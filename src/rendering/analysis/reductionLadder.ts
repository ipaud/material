import type { RawVisualStats } from '@/signals/visual/types';

/**
 * v0.4A A2 — the pure half of the GPU reduction.
 *
 * Turning a frame into scalars must never read the frame back to the CPU. The
 * GPU sums four channels down a ladder; this module owns the arithmetic around
 * that — level sizing, the final decode, and a CPU reference implementation
 * the goldens check the GPU against.
 *
 * Channel layout of every level (RGBA32F):
 *   R = luma            Rec.709 over the source
 *   G = |flow|          magnitude, uv per frame
 *   B = flow.x          SIGNED, unweighted
 *   A = 1               coverage
 *
 * B is deliberately NOT magnitude-weighted. The weighted mean of the unit
 * direction is Σ(|f|·(f.x/|f|)) / Σ|f| = Σf.x / Σ|f| — the weight cancels, so
 * no fifth accumulator is needed and the result is bounded to ±1 by
 * construction. That is why motion.x needs no per-source calibration.
 */

/** Children summed per reduce pass, per axis. 4×4 = 16 taps per draw. */
export const REDUCE_FACTOR = 4;

/** Stop reducing once the level fits here; sum the remainder on the CPU. */
export const TILE_MAX = 8;

/**
 * Sizes of every reduce level after the extract pass, `ceil` at each step.
 * Chasing the ladder to 1×1 would cost two more full passes to move ~60
 * floats, so it stops at TILE_MAX and the tile is summed during decode.
 */
export function levelSizes(width: number, height: number): [number, number][] {
  const out: [number, number][] = [];
  let w = width;
  let h = height;
  while (Math.max(w, h) > TILE_MAX) {
    w = Math.ceil(w / REDUCE_FACTOR);
    h = Math.ceil(h / REDUCE_FACTOR);
    out.push([w, h]);
  }
  return out;
}

/**
 * Flow magnitude below which direction is noise rather than motion, in uv per
 * frame, expressed against the analysis grid. A twentieth of a texel sits under
 * the measured LK noise floor (background magnitude ~0.166‰ uv at the 320 grid).
 * Used as Tikhonov regularisation on the divisor — the same idiom as the
 * diagonal `reg` in LK_FRAG — so a dead-still frame decays smoothly to 0.5
 * instead of exploding on noise, and 0/0 cannot occur.
 */
export function directionGate(gridWidth: number): number {
  return 0.05 / Math.max(gridWidth, 1);
}

/** Sum a readback tile (RGBA, row-major, any size) into the four totals. */
export function sumTile(tile: Float32Array): [number, number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let i = 0; i < tile.length; i += 4) {
    r += tile[i] as number;
    g += tile[i + 1] as number;
    b += tile[i + 2] as number;
    a += tile[i + 3] as number;
  }
  return [r, g, b, a];
}

/**
 * Closed-form decode. `gridWidth` converts the mean magnitude from uv/frame to
 * analysis texels/frame, which is what makes motion.amount independent of the
 * analysis resolution.
 */
/**
 * Above this mean displacement Lucas-Kanade has stopped measuring: its
 * linearization holds over the 5x5 window it samples, and past it the field
 * saturates rather than reporting more. `motionValid` reports that state for
 * diagnostics; the value is still published and still calibrated, because a
 * genuinely fast source SHOULD peg the knob.
 *
 * Suppressing those frames was the first attempt and was wrong: a 12 fps
 * export of a moving source legitimately displaces 5-8 texels per frame, so it
 * deleted the motion signal from 59 of 61 exported frames. Transient
 * saturation (a video seek measured at 9.698 texels/frame, a source switch, a
 * camera's exposure ramp breaking LK's brightness-constancy assumption) is
 * damped by tauExpand instead: at 30 Hz one outlier frame moves the envelope
 * by 2.2% of the gap, so it takes a sustained event to move the range.
 */
export const LK_APERTURE_TEXELS = 4;

/** The field's own ceiling: the shader clamps each component to 8 texels, so
 * a fully saturated diagonal reads 8*sqrt(2). Reporting more than the
 * instrument can express would be inventing a number. */
export const MOTION_SATURATION_TEXELS = 8 * Math.SQRT2;

export function decodeStats(
  tile: Float32Array,
  gridWidth: number,
  hasFlow: boolean,
): RawVisualStats {
  const [sr, sg, sb, sa] = sumTile(tile);
  const n = sa;
  if (n <= 0) {
    return { n: 0, luminance: 0, motionAmount: 0, motionX: 0.5, motionValid: false, hasFlow: false };
  }
  const gate = n * directionGate(gridWidth);
  const dirX = hasFlow ? sb / Math.max(sg, gate) : 0;
  const motionAmount = hasFlow
    ? clamp((sg / n) * gridWidth, 0, MOTION_SATURATION_TEXELS)
    : 0;
  return {
    n,
    luminance: clamp01(sr / n),
    motionAmount,
    motionX: 0.5 + 0.5 * clamp(dirX, -1, 1),
    motionValid: hasFlow && motionAmount < LK_APERTURE_TEXELS,
    hasFlow,
  };
}

/**
 * CPU reference for the whole ladder, used only by tests: the goldens assert
 * the GPU agrees with this, and this agrees with a naive sum.
 */
export function cpuReduce(
  src: Float32Array,
  width: number,
  height: number,
): { tile: Float32Array; tileWidth: number; tileHeight: number } {
  let cur = src;
  let w = width;
  let h = height;
  for (const [nw, nh] of levelSizes(width, height)) {
    const next = new Float32Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let j = 0; j < REDUCE_FACTOR; j++) {
          for (let i = 0; i < REDUCE_FACTOR; i++) {
            const px = x * REDUCE_FACTOR + i;
            const py = y * REDUCE_FACTOR + j;
            // Out-of-range children are SKIPPED, not clamped and not zero-
            // padded-with-coverage: clamping would duplicate edge texels and
            // bias the mean on odd dimensions.
            if (px >= w || py >= h) continue;
            const o = (py * w + px) * 4;
            r += cur[o] as number;
            g += cur[o + 1] as number;
            b += cur[o + 2] as number;
            a += cur[o + 3] as number;
          }
        }
        const o = (y * nw + x) * 4;
        next[o] = r;
        next[o + 1] = g;
        next[o + 2] = b;
        next[o + 3] = a;
      }
    }
    cur = next;
    w = nw;
    h = nh;
  }
  return { tile: cur, tileWidth: w, tileHeight: h };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
const clamp01 = (v: number): number => clamp(v, 0, 1);

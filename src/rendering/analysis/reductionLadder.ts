import type { RawVisualStats } from '@/signals/visual/types';

/**
 * v0.4A/B — the pure half of the GPU reduction.
 *
 * Turning a frame into scalars must never read the frame back to the CPU. The
 * GPU sums a fixed set of accumulators down a ladder; this module owns the
 * arithmetic around that — level sizing, the final decode, and a CPU reference
 * implementation the goldens check the GPU against.
 *
 * v0.4B widened the payload from one RGBA target to THREE (MRT), because six
 * more signals needed six more sums. The alternative — a second and third
 * ladder — would have tripled the readback stalls, which dominate the cost.
 *
 * Plane layout (each an RGBA32F attachment of the same level):
 *
 *   plane 0   R = L            G = L*L         B = |grad L|   A = 1
 *   plane 1   R = |f|          G = f.x         B = f.y        A = moving?1:0
 *   plane 2   R = u*|f|        G = v*|f|       B = 0          A = 0
 *
 * Why these and not others:
 *  - `L*L` with `L` gives variance in one pass: E[L2] - E[L]^2. Contrast is a
 *    standard deviation, not an ad-hoc edge measure.
 *  - `f.x`/`f.y` are SIGNED and UNWEIGHTED. The magnitude weight cancels in
 *    the ratio Sum(f.x)/Sum(|f|), which is the magnitude-weighted mean of the
 *    unit direction — bounded to +-1 by construction, so the directional
 *    signals need no per-source calibration.
 *  - `u*|f|` and `v*|f|` are first moments of the flow magnitude, so the
 *    centroid is Sum(u|f|)/Sum(|f|): a position, in the source's own
 *    normalised coordinates, with no tracking model anywhere.
 */

/** Children summed per reduce pass, per axis. 4x4 = 16 taps per draw. */
export const REDUCE_FACTOR = 4;

/** Stop reducing once the level fits here; sum the remainder on the CPU. */
export const TILE_MAX = 8;

/** How many RGBA planes the motion configuration carries. */
export const MOTION_PLANES = 3;

/**
 * Sizes of every reduce level after the extract pass, `ceil` at each step.
 * Chasing the ladder to 1x1 would cost two more full passes to move ~60
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
 * the measured LK noise floor (background magnitude ~0.166 per mille uv at the
 * 320 grid). Used as Tikhonov regularisation on the divisor — the same idiom as
 * the diagonal `reg` in LK_FRAG — so a dead-still frame decays smoothly to 0.5
 * instead of exploding on noise, and 0/0 cannot occur.
 */
export function directionGate(gridWidth: number): number {
  return 0.05 / Math.max(gridWidth, 1);
}

/**
 * A texel counts as MOVING above this displacement. Five times the measured LK
 * noise floor (0.053 texels/frame), so a still frame reads activity 0 rather
 * than a few percent of shimmer. This threshold is what separates
 * `motion.activity` (how MUCH of the frame moves) from `motion.amount` (how
 * FAST it moves on average): without it, activity would just be amount again.
 */
export const ACTIVITY_TEXELS = 0.25;

/**
 * Below this mean displacement the centroid is meaningless — dividing two
 * numbers that are both noise gives a position that jitters across the whole
 * frame. Above it the first moment is dominated by real motion. Chosen at
 * twice the LK noise floor and verified against the static fixture, which must
 * report INVALID rather than a plausible-looking 0.5.
 */
export const CENTROID_MIN_TEXELS = 0.1;

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

/**
 * v0.8.3 — `motionAmount` is published in texels per REFERENCE frame, 1/30 s.
 *
 * The field measures displacement between two consecutive source frames. For
 * a file video that pair spans one source frame in preview and export alike.
 * For a GENERATOR it spans one display frame in preview (1/60 or 1/120 s) and
 * one export frame in export (1/30 s at 30 fps) — the same source velocity
 * read 2-4x larger in export. Calibration removes scale only above its span
 * floor, so a slow figure sat in different regimes on the two paths: measured
 * on a Chladni plate, calibrated motion 0.27 in preview against 0.00 in export
 * for the same two seconds, and a Look's echo rotation went from 11 to 1.5
 * degrees. Rescaling to a fixed reference makes the number a velocity again.
 * 30 fps is the identity, so every floor and fixture tuned at 30 keeps its
 * meaning. Aperture and saturation stay per measured frame: they describe
 * the instrument, not the source.
 */
export const MOTION_REFERENCE_FPS = 30;

/** Scale that takes a per-frame displacement over `pairDtSec` to the
 * reference frame. Unknown or degenerate spacing leaves the value alone. */
export function referenceMotionScale(pairDtSec: number | null | undefined): number {
  if (pairDtSec === null || pairDtSec === undefined || !(pairDtSec > 0)) return 1;
  return 1 / MOTION_REFERENCE_FPS / pairDtSec;
}

/** Sum one plane of a packed readback into its four totals.
 *
 * The packed buffer holds `planes` tiles stacked vertically, so plane `p`
 * occupies rows [p*tileHeight, (p+1)*tileHeight). One readback for every
 * plane is what keeps the number of GPU sync stalls at one. */
export function sumPlane(
  packed: Float32Array,
  tileWidth: number,
  tileHeight: number,
  plane: number,
): [number, number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  const start = plane * tileWidth * tileHeight * 4;
  const end = start + tileWidth * tileHeight * 4;
  for (let i = start; i < end && i < packed.length; i += 4) {
    r += packed[i] as number;
    g += packed[i + 1] as number;
    b += packed[i + 2] as number;
    a += packed[i + 3] as number;
  }
  return [r, g, b, a];
}

/** Back-compat helper: sum a single-plane tile. */
export function sumTile(tile: Float32Array): [number, number, number, number] {
  return sumPlane(tile, tile.length / 4, 1, 0);
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
const clamp01 = (v: number): number => clamp(v, 0, 1);

const EMPTY: RawVisualStats = {
  n: 0,
  luminance: 0,
  contrast: 0,
  edgeEnergy: 0,
  motionAmount: 0,
  motionX: 0.5,
  motionY: 0.5,
  motionActivity: 0,
  centroidX: 0.5,
  centroidY: 0.5,
  motionValid: false,
  centroidValid: false,
  hasFlow: false,
};

/**
 * Closed-form decode of a packed readback.
 *
 * `gridWidth` converts mean magnitudes from uv/frame to analysis texels/frame,
 * which is what makes every motion figure independent of the analysis
 * resolution — preview and export can disagree about the grid and still agree
 * about the number.
 */
export function decodeStats(
  packed: Float32Array,
  tileWidth: number,
  tileHeight: number,
  gridWidth: number,
  hasFlow: boolean,
): RawVisualStats {
  const [sumL, sumL2, sumEdge, coverage] = sumPlane(packed, tileWidth, tileHeight, 0);
  const n = coverage;
  if (n <= 0) return EMPTY;

  const meanL = sumL / n;
  // max(.,0) because catastrophic cancellation can put a flat frame a few ULP
  // below zero, and sqrt of that is NaN — which would poison every downstream
  // envelope silently.
  const variance = Math.max(sumL2 / n - meanL * meanL, 0);

  const image = {
    n,
    luminance: clamp01(meanL),
    contrast: Math.sqrt(variance),
    edgeEnergy: sumEdge / n,
  };

  if (!hasFlow) return { ...EMPTY, ...image };

  const [sumMag, sumFx, sumFy, active] = sumPlane(packed, tileWidth, tileHeight, 1);
  const [sumUw, sumVw] = sumPlane(packed, tileWidth, tileHeight, 2);

  const gate = n * directionGate(gridWidth);
  const divisor = Math.max(sumMag, gate);
  const motionAmount = clamp((sumMag / n) * gridWidth, 0, MOTION_SATURATION_TEXELS);
  const centroidValid = motionAmount >= CENTROID_MIN_TEXELS;

  return {
    ...image,
    motionAmount,
    motionX: 0.5 + 0.5 * clamp(sumFx / divisor, -1, 1),
    motionY: 0.5 + 0.5 * clamp(sumFy / divisor, -1, 1),
    motionActivity: clamp01(active / n),
    centroidX: centroidValid ? clamp01(sumUw / divisor) : 0.5,
    centroidY: centroidValid ? clamp01(sumVw / divisor) : 0.5,
    motionValid: motionAmount < LK_APERTURE_TEXELS,
    centroidValid,
    hasFlow: true,
  };
}

/**
 * CPU reference for one plane of the ladder, used only by tests: the goldens
 * assert the GPU agrees with this, and this agrees with a naive sum.
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
            const sx = x * REDUCE_FACTOR + i;
            const sy = y * REDUCE_FACTOR + j;
            if (sx >= w || sy >= h) continue;
            const o = (sy * w + sx) * 4;
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

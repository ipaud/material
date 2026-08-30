import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_TEXELS,
  REDUCE_FACTOR,
  TILE_MAX,
  cpuReduce,
  decodeStats,
  directionGate,
  levelSizes,
  sumTile,
} from '@/rendering/analysis/reductionLadder';

/**
 * v0.4A A2 — the reduction arithmetic, proven without a GPU.
 *
 * The strongest assertion here is coverage exactness: ΣA must equal w·h for
 * ANY dimensions. If it does, no padded texel contributed and none was
 * dropped, which is the whole edge-bias question answered by one integer.
 */

function field(w: number, h: number, fn: (x: number, y: number) => [number, number, number]) {
  const out = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const o = (y * w + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 1; // coverage
    }
  }
  return out;
}

describe('level sizing', () => {
  it('quarters each axis with ceil and terminates at the tile size', () => {
    expect(levelSizes(320, 180)).toEqual([
      [80, 45],
      [20, 12],
      [5, 3],
    ]);
    // 16 → 4 already fits the tile, so the ladder stops there.
    expect(levelSizes(16, 16)).toEqual([[4, 4]]);
    expect(levelSizes(17, 5)).toEqual([[5, 2]]);
  });

  it('never needs more than four levels for any grid up to 512', () => {
    for (let w = 1; w <= 512; w++) {
      const levels = levelSizes(w, Math.max(1, Math.floor(w * 0.5625)));
      expect(levels.length).toBeLessThanOrEqual(4);
      const [lw, lh] = levels[levels.length - 1] ?? [w, w];
      expect(Math.max(lw, lh)).toBeLessThanOrEqual(TILE_MAX);
    }
  });

  it('a grid already small enough reduces not at all', () => {
    expect(levelSizes(8, 8)).toEqual([]);
    expect(levelSizes(1, 1)).toEqual([]);
  });

  it('every level is exactly ceil(previous / factor)', () => {
    let [w, h] = [317, 179];
    for (const [nw, nh] of levelSizes(317, 179)) {
      expect(nw).toBe(Math.ceil(w / REDUCE_FACTOR));
      expect(nh).toBe(Math.ceil(h / REDUCE_FACTOR));
      [w, h] = [nw, nh];
    }
  });
});

describe('coverage is exact for any dimensions (§A2 anti-edge-bias)', () => {
  for (const [w, h] of [
    [1, 1],
    [5, 3],
    [8, 8],
    [16, 16],
    [317, 179],
    [320, 180],
    [511, 287],
  ] as [number, number][]) {
    it(`${w}x${h} sums exactly ${w * h} covered texels`, () => {
      const src = field(w, h, () => [0.5, 0, 0]);
      const { tile } = cpuReduce(src, w, h);
      const [, , , sa] = sumTile(tile);
      expect(sa).toBe(w * h);
    });
  }
});

describe('reduction agrees with a naive sum', () => {
  it('matches over 200 random fields', () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let k = 0; k < 200; k++) {
      const w = 1 + Math.floor(rnd() * 200);
      const h = 1 + Math.floor(rnd() * 120);
      const src = field(w, h, () => [rnd(), rnd(), rnd() * 2 - 1]);
      let nr = 0;
      let ng = 0;
      let nb = 0;
      for (let i = 0; i < src.length; i += 4) {
        nr += src[i] as number;
        ng += src[i + 1] as number;
        nb += src[i + 2] as number;
      }
      const { tile } = cpuReduce(src, w, h);
      const [sr, sg, sb] = sumTile(tile);
      expect(sr).toBeCloseTo(nr, 3);
      expect(sg).toBeCloseTo(ng, 3);
      expect(sb).toBeCloseTo(nb, 3);
    }
  });
});

describe('decode', () => {
  const GRID = 320;
  const decodeField = (w: number, h: number, fn: Parameters<typeof field>[2], hasFlow = true) => {
    const { tile, tileWidth, tileHeight } = cpuReduce(field(w, h, fn), w, h);
    // One plane in, so motion planes read as zeros — the image half of the
    // decode is what these fixtures exercise.
    const packed = new Float32Array(tile.length * 3);
    packed.set(tile, 0);
    return decodeStats(packed, tileWidth, tileHeight, GRID, hasFlow);
  };

  /**
   * Decode a field described per texel as (luma, flow.x, flow.y) in uv,
   * building all three planes exactly as the extract shader does. This is the
   * v0.4B layout: motion no longer rides in the image plane.
   */
  const decodeMotion = (
    w: number,
    h: number,
    fn: (x: number, y: number) => [number, number, number],
  ) => {
    const p0 = new Float32Array(w * h * 4);
    const p1 = new Float32Array(w * h * 4);
    const p2 = new Float32Array(w * h * 4);
    const gate = ACTIVITY_TEXELS / GRID;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [luma, fx, fy] = fn(x, y);
        const mag = Math.hypot(fx, fy);
        const o = (y * w + x) * 4;
        p0.set([luma, luma * luma, 0, 1], o);
        p1.set([mag, fx, fy, mag > gate ? 1 : 0], o);
        // Row 0 is the TOP of the image in these fixtures, so v runs straight
        // down. Whether the shader needs a flip to match depends on the
        // texture's orientation and is settled by a GPU golden, not here.
        const u = (x + 0.5) / w;
        const v = (y + 0.5) / h;
        p2.set([u * mag, v * mag, 0, 0], o);
      }
    }
    const r0 = cpuReduce(p0, w, h);
    const r1 = cpuReduce(p1, w, h);
    const r2 = cpuReduce(p2, w, h);
    const packed = new Float32Array(r0.tile.length * 3);
    packed.set(r0.tile, 0);
    packed.set(r1.tile, r0.tile.length);
    packed.set(r2.tile, r0.tile.length * 2);
    return decodeStats(packed, r0.tileWidth, r0.tileHeight, GRID, true);
  };

  it('a constant field decodes to its constant', () => {
    const s = decodeField(320, 180, () => [0.25, 0, 0]);
    expect(s.n).toBe(320 * 180);
    expect(s.luminance).toBeCloseTo(0.25, 6);
  });

  it('half black / half white on an ODD width is not edge-biased', () => {
    // 159 of 317 columns lit — only correct if coverage is exact.
    const s = decodeField(317, 179, (x) => [x < 159 ? 1 : 0, 0, 0]);
    expect(s.luminance).toBeCloseTo(159 / 317, 6);
  });

  it('all-rightward motion reads +1, all-leftward -1', () => {
    const c = 0.01;
    expect(decodeMotion(64, 36, () => [0, c, 0]).motionX).toBeCloseTo(1, 5);
    expect(decodeMotion(64, 36, () => [0, -c, 0]).motionX).toBeCloseTo(0, 5);
  });

  it('purely vertical motion reads exactly still — no horizontal dominance', () => {
    const s = decodeMotion(64, 36, () => [0, 0, 0.01]);
    expect(s.motionX).toBeCloseTo(0.5, 6);
    expect(s.motionAmount).toBeGreaterThan(0);
  });

  it('45-degree motion reads the cosine, not saturation', () => {
    const c = Math.SQRT1_2 * 0.01;
    const s = decodeMotion(64, 36, () => [0, c, c]);
    // dirX = Σf.x / Σ|f| = 1/√2 → 0.5 + 0.5/√2
    expect(s.motionX).toBeCloseTo(0.5 + 0.5 * Math.SQRT1_2, 5);
  });

  it('opposing motion does not cancel to a false still in AMOUNT', () => {
    const s = decodeMotion(64, 36, (x) => [0, x < 32 ? 0.01 : -0.01, 0]);
    expect(s.motionX).toBeCloseTo(0.5, 5); // no net direction — correct
    expect(s.motionAmount).toBeGreaterThan(0); // but there IS motion
  });

  it('a still frame decays to centre instead of exploding on noise', () => {
    const tiny = directionGate(320) * 0.01;
    const s = decodeMotion(64, 36, () => [0, tiny, 0]);
    expect(Number.isFinite(s.motionX)).toBe(true);
    expect(Math.abs(s.motionX - 0.5)).toBeLessThan(0.02);
  });

  it('no flow at all omits motion rather than inventing zero motion', () => {
    const s = decodeField(64, 36, () => [0.4, 0, 0], false);
    expect(s.hasFlow).toBe(false);
    expect(s.motionX).toBe(0.5);
    expect(s.luminance).toBeCloseTo(0.4, 6);
  });

  it('an empty tile cannot produce NaN', () => {
    const s = decodeStats(new Float32Array(12), 1, 1, 320, true);
    expect(Number.isFinite(s.luminance)).toBe(true);
    expect(Number.isFinite(s.motionX)).toBe(true);
    expect(s.n).toBe(0);
  });
});

/**
 * v0.4B — the six added signals, proven against the arithmetic before any GPU
 * is involved. Every block ends with the fixture that would fail if the
 * quantity were replaced by a constant, because a signal that never moves is
 * perfectly deterministic and completely useless.
 */
describe('v0.4B image statistics', () => {
  const GRID = 320;

  /** Mirror of the extract shader for the image plane, so the CPU reference
   * and the GLSL agree by construction rather than by coincidence. */
  const imagePlane = (w: number, h: number, luma: (x: number, y: number) => number): Float32Array => {
    const out = new Float32Array(w * h * 4);
    const at = (x: number, y: number) =>
      luma(Math.min(Math.max(x, 0), w - 1), Math.min(Math.max(y, 0), h - 1));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const l = luma(x, y);
        const gx = (at(x + 1, y) - at(x - 1, y)) * 0.5;
        const gy = (at(x, y + 1) - at(x, y - 1)) * 0.5;
        out.set([l, l * l, Math.hypot(gx, gy), 1], (y * w + x) * 4);
      }
    }
    return out;
  };

  const decodeImage = (w: number, h: number, luma: (x: number, y: number) => number) => {
    const { tile, tileWidth, tileHeight } = cpuReduce(imagePlane(w, h, luma), w, h);
    const packed = new Float32Array(tile.length * 3);
    packed.set(tile, 0);
    return decodeStats(packed, tileWidth, tileHeight, GRID, false);
  };

  describe('contrast is a standard deviation, not a synonym for brightness', () => {
    it('any flat frame reads zero, at any brightness', () => {
      for (const level of [0, 0.5, 1]) {
        const s = decodeImage(64, 36, () => level);
        expect(s.luminance).toBeCloseTo(level, 6);
        expect(s.contrast, `flat ${level}`).toBeLessThan(1e-4);
      }
    });

    it('a half-black half-white split reads the theoretical maximum of 0.5', () => {
      const s = decodeImage(64, 36, (x) => (x < 32 ? 0 : 1));
      expect(s.luminance).toBeCloseTo(0.5, 6);
      expect(s.contrast).toBeCloseTo(0.5, 6);
    });

    it('a narrow grey pair reads proportionally less', () => {
      const s = decodeImage(64, 36, (x) => (x < 32 ? 0.4 : 0.6));
      expect(s.contrast).toBeCloseTo(0.1, 6);
    });

    it('SAME mean, different contrast — the fixture that separates the two', () => {
      const flat = decodeImage(64, 36, () => 0.5);
      const narrow = decodeImage(64, 36, (x) => (x < 32 ? 0.4 : 0.6));
      const wide = decodeImage(64, 36, (x) => (x < 32 ? 0 : 1));
      for (const s of [flat, narrow, wide]) expect(s.luminance).toBeCloseTo(0.5, 6);
      expect(flat.contrast).toBeLessThan(narrow.contrast);
      expect(narrow.contrast).toBeLessThan(wide.contrast);
    });

    it('cancellation cannot produce NaN on a flat frame', () => {
      // E[L^2] - E[L]^2 is a difference of two large near-equal numbers; a few
      // ULP below zero would make sqrt return NaN and poison every envelope.
      const s = decodeImage(64, 36, () => 0.9999999);
      expect(Number.isFinite(s.contrast)).toBe(true);
      expect(s.contrast).toBeGreaterThanOrEqual(0);
    });
  });

  describe('edge energy is local structure, not global spread', () => {
    it('a flat frame has no edges', () => {
      expect(decodeImage(64, 36, () => 0.5).edgeEnergy).toBeLessThan(1e-6);
    });

    it('a single hard edge reads above flat, a checker higher still', () => {
      const flat = decodeImage(64, 36, () => 0.5).edgeEnergy;
      const one = decodeImage(64, 36, (x) => (x < 32 ? 0 : 1)).edgeEnergy;
      const checker = decodeImage(64, 36, (x, y) => ((x + y) % 2 === 0 ? 0 : 1)).edgeEnergy;
      expect(one).toBeGreaterThan(flat);
      expect(checker).toBeGreaterThan(one);
    });

    it('blur lowers it — because blur removes AMPLITUDE, not because it is smooth', () => {
      // Edge energy is total variation per texel, so a full-amplitude sine and
      // a square wave of the same period read alike. What a blur actually does
      // to fine detail is cut its swing, and that is what shows up here.
      const sharp = decodeImage(64, 36, (x) => (Math.floor(x / 4) % 2 === 0 ? 0 : 1)).edgeEnergy;
      const quarterSwing = decodeImage(
        64,
        36,
        (x) => 0.5 + 0.125 * (Math.floor(x / 4) % 2 === 0 ? -1 : 1),
      ).edgeEnergy;
      expect(quarterSwing).toBeCloseTo(sharp * 0.25, 4);
    });

    it('SAME contrast, different structure — the fixture that separates edge from contrast', () => {
      // Stripes and a single split are both black/white 50/50, so their
      // standard deviations are identical to the last digit. Only edge energy
      // can tell them apart, because it is total variation per texel and the
      // stripes cross black-to-white eight times instead of once.
      const split = decodeImage(64, 36, (x) => (x < 32 ? 0 : 1));
      const stripes = decodeImage(64, 36, (x) => (Math.floor(x / 4) % 2 === 0 ? 0 : 1));
      expect(stripes.contrast).toBeCloseTo(split.contrast, 6);
      expect(stripes.edgeEnergy).toBeGreaterThan(split.edgeEnergy * 5);
    });

    it('a ramp and a single hard edge share edge energy — and that is correct', () => {
      // Both traverse the full range exactly once across the width, so their
      // total variation is equal. Recording it stops a future reader from
      // "fixing" a result that is not broken: contrast is what separates these
      // two, and it does, by a factor of nearly two.
      const ramp = decodeImage(64, 36, (x) => x / 63);
      const split = decodeImage(64, 36, (x) => (x < 32 ? 0 : 1));
      expect(ramp.edgeEnergy).toBeCloseTo(split.edgeEnergy, 4);
      expect(ramp.contrast).toBeCloseTo(1 / Math.sqrt(12), 2);
      expect(split.contrast).toBeCloseTo(0.5, 6);
    });
  });
});

describe('v0.4B motion statistics', () => {
  const GRID = 320;

  const decodeMotionField = (
    w: number,
    h: number,
    fn: (x: number, y: number) => [number, number],
  ) => {
    const p0 = new Float32Array(w * h * 4);
    const p1 = new Float32Array(w * h * 4);
    const p2 = new Float32Array(w * h * 4);
    const gate = ACTIVITY_TEXELS / GRID;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [fx, fy] = fn(x, y);
        const mag = Math.hypot(fx, fy);
        const o = (y * w + x) * 4;
        p0.set([0.5, 0.25, 0, 1], o);
        p1.set([mag, fx, fy, mag > gate ? 1 : 0], o);
        const u = (x + 0.5) / w;
        const v = (y + 0.5) / h;
        p2.set([u * mag, v * mag, 0, 0], o);
      }
    }
    const r0 = cpuReduce(p0, w, h);
    const r1 = cpuReduce(p1, w, h);
    const r2 = cpuReduce(p2, w, h);
    const packed = new Float32Array(r0.tile.length * 3);
    packed.set(r0.tile, 0);
    packed.set(r1.tile, r0.tile.length);
    packed.set(r2.tile, r0.tile.length * 2);
    return decodeStats(packed, r0.tileWidth, r0.tileHeight, GRID, true);
  };

  /** A moving rectangle, given in texel coordinates. */
  const patch = (
    w: number,
    h: number,
    box: { x0: number; x1: number; y0: number; y1: number },
    flow: [number, number],
  ) =>
    decodeMotionField(w, h, (x, y) =>
      x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1 ? flow : [0, 0],
    );

  describe('motion.y mirrors motion.x exactly', () => {
    const c = 0.01;
    it('up reads 1, down reads 0, and horizontal motion leaves it centred', () => {
      expect(decodeMotionField(64, 36, () => [0, c]).motionY).toBeCloseTo(1, 5);
      expect(decodeMotionField(64, 36, () => [0, -c]).motionY).toBeCloseTo(0, 5);
      expect(decodeMotionField(64, 36, () => [c, 0]).motionY).toBeCloseTo(0.5, 6);
    });

    it('a still frame reads exactly centred on both axes', () => {
      const s = decodeMotionField(64, 36, () => [0, 0]);
      expect(s.motionX).toBeCloseTo(0.5, 6);
      expect(s.motionY).toBeCloseTo(0.5, 6);
    });

    it('diagonal motion reads both axes, neither saturated', () => {
      const d = Math.SQRT1_2 * c;
      const s = decodeMotionField(64, 36, () => [d, d]);
      expect(s.motionX).toBeCloseTo(0.5 + 0.5 * Math.SQRT1_2, 5);
      expect(s.motionY).toBeCloseTo(0.5 + 0.5 * Math.SQRT1_2, 5);
    });

    it('ANTI-NOOP: absolute value or a flipped sign fails the up/down pair', () => {
      const up = decodeMotionField(64, 36, () => [0, c]).motionY;
      const down = decodeMotionField(64, 36, () => [0, -c]).motionY;
      expect(up).toBeGreaterThan(0.9);
      expect(down).toBeLessThan(0.1);
      expect(up).not.toBeCloseTo(down, 2);
    });
  });

  describe('motion.activity measures HOW MUCH of the frame moves', () => {
    it('a still frame is exactly zero', () => {
      expect(decodeMotionField(64, 36, () => [0, 0]).motionActivity).toBe(0);
    });

    it('full-field motion is exactly one', () => {
      expect(decodeMotionField(64, 36, () => [0.01, 0]).motionActivity).toBeCloseTo(1, 6);
    });

    it('a quarter of the frame moving reads a quarter', () => {
      const s = patch(64, 36, { x0: 0, x1: 32, y0: 0, y1: 18 }, [0.01, 0]);
      expect(s.motionActivity).toBeCloseTo(0.25, 6);
    });

    it('THE product gate: same AMOUNT, different ACTIVITY', () => {
      // 1/16 of the frame at 16x the speed carries the same total displacement
      // as the whole frame moving slowly. `amount` cannot tell them apart —
      // that is precisely why `activity` exists.
      const small = patch(64, 36, { x0: 0, x1: 16, y0: 0, y1: 9 }, [0.16, 0]);
      const large = decodeMotionField(64, 36, () => [0.01, 0]);
      expect(small.motionAmount).toBeCloseTo(large.motionAmount, 5);
      expect(small.motionActivity).toBeCloseTo(0.0625, 6);
      expect(large.motionActivity).toBeCloseTo(1, 6);
      expect(large.motionActivity / small.motionActivity).toBeGreaterThan(10);
    });

    it('ANTI-NOOP: activity derived from mean magnitude fails the gate above', () => {
      const small = patch(64, 36, { x0: 0, x1: 16, y0: 0, y1: 9 }, [0.16, 0]);
      const large = decodeMotionField(64, 36, () => [0.01, 0]);
      // If activity were any monotone function of amount, these would be equal.
      expect(Math.abs(small.motionActivity - large.motionActivity)).toBeGreaterThan(0.5);
    });

    it('motion under the noise floor does not count as activity', () => {
      const noise = (ACTIVITY_TEXELS / GRID) * 0.5;
      expect(decodeMotionField(64, 36, () => [noise, 0]).motionActivity).toBe(0);
    });
  });

  describe('motion centroid is a position, not an amplitude', () => {
    it('a patch on the left reads left, on the right reads right', () => {
      const left = patch(64, 36, { x0: 0, x1: 16, y0: 8, y1: 28 }, [0.05, 0]);
      const right = patch(64, 36, { x0: 48, x1: 64, y0: 8, y1: 28 }, [0.05, 0]);
      expect(left.centroidX).toBeLessThan(0.3);
      expect(right.centroidX).toBeGreaterThan(0.7);
      expect(left.centroidValid && right.centroidValid).toBe(true);
    });

    it('0 is the TOP of the image, matching how a viewer describes it', () => {
      const top = patch(64, 36, { x0: 24, x1: 40, y0: 0, y1: 8 }, [0.05, 0]);
      const bottom = patch(64, 36, { x0: 24, x1: 40, y0: 28, y1: 36 }, [0.05, 0]);
      expect(top.centroidY).toBeLessThan(0.3);
      expect(bottom.centroidY).toBeGreaterThan(0.7);
    });

    it('the centroid of a centred patch is the centre', () => {
      const s = patch(64, 36, { x0: 24, x1: 40, y0: 12, y1: 24 }, [0.05, 0]);
      expect(s.centroidX).toBeCloseTo(0.5, 2);
      expect(s.centroidY).toBeCloseTo(0.5, 2);
    });

    it('shifting the patch moves the centroid MONOTONICALLY', () => {
      const xs = [0, 8, 16, 24, 32, 40, 48].map(
        (x0) => patch(64, 36, { x0, x1: x0 + 16, y0: 8, y1: 28 }, [0.05, 0]).centroidX,
      );
      for (let i = 1; i < xs.length; i++) {
        expect(xs[i]!, `step ${i}`).toBeGreaterThan(xs[i - 1]!);
      }
      expect(xs[xs.length - 1]! - xs[0]!).toBeGreaterThan(0.5);
    });

    it('a still frame reports INVALID rather than a plausible-looking centre', () => {
      // Dividing noise by noise gives a position that wanders the whole frame
      // and looks exactly like tracking. Refusing to answer is the honest move.
      const s = decodeMotionField(64, 36, () => [0, 0]);
      expect(s.centroidValid).toBe(false);
      expect(s.centroidX).toBe(0.5);
    });

    it('motion below the validity floor stays invalid', () => {
      const faint = (0.05 / GRID) * 0.5;
      expect(decodeMotionField(64, 36, () => [faint, 0]).centroidValid).toBe(false);
    });

    it('ANTI-NOOP: a constant 0.5 fails the left/right pair', () => {
      const left = patch(64, 36, { x0: 0, x1: 16, y0: 8, y1: 28 }, [0.05, 0]).centroidX;
      const right = patch(64, 36, { x0: 48, x1: 64, y0: 8, y1: 28 }, [0.05, 0]).centroidX;
      expect(Math.abs(right - left)).toBeGreaterThan(0.4);
      expect(left).not.toBeCloseTo(0.5, 1);
    });
  });
});

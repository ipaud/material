import { describe, expect, it } from 'vitest';
import {
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
  const decodeField = (w: number, h: number, fn: Parameters<typeof field>[2], hasFlow = true) =>
    decodeStats(cpuReduce(field(w, h, fn), w, h).tile, GRID, hasFlow);

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
    expect(decodeField(64, 36, () => [0, c, c]).motionX).toBeCloseTo(1, 5);
    expect(decodeField(64, 36, () => [0, c, -c]).motionX).toBeCloseTo(0, 5);
  });

  it('purely vertical motion reads exactly still — no horizontal dominance', () => {
    const s = decodeField(64, 36, () => [0, 0.01, 0]);
    expect(s.motionX).toBeCloseTo(0.5, 6);
    expect(s.motionAmount).toBeGreaterThan(0);
  });

  it('45-degree motion reads the cosine, not saturation', () => {
    const c = Math.SQRT1_2 * 0.01;
    const s = decodeField(64, 36, () => [0, 0.01, c]);
    // dirX = Σf.x / Σ|f| = 1/√2 → 0.5 + 0.5/√2
    expect(s.motionX).toBeCloseTo(0.5 + 0.5 * Math.SQRT1_2, 5);
  });

  it('opposing motion does not cancel to a false still in AMOUNT', () => {
    const s = decodeField(64, 36, (x) => [0, 0.01, x < 32 ? 0.01 : -0.01]);
    expect(s.motionX).toBeCloseTo(0.5, 5); // no net direction — correct
    expect(s.motionAmount).toBeGreaterThan(0); // but there IS motion
  });

  it('a still frame decays to centre instead of exploding on noise', () => {
    const tiny = directionGate(320) * 0.01;
    const s = decodeField(64, 36, () => [0, tiny, tiny]);
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
    const s = decodeStats(new Float32Array(4), 320, true);
    expect(Number.isFinite(s.luminance)).toBe(true);
    expect(Number.isFinite(s.motionX)).toBe(true);
    expect(s.n).toBe(0);
  });
});

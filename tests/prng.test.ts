import { describe, expect, test } from 'vitest';
import { deriveSeed, mulberry32 } from '@/utils/prng';

describe('seeded prng', () => {
  test('same seed produces the same sequence', () => {
    const a = mulberry32(841295);
    const b = mulberry32(841295);
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b());
    }
  });

  test('different seeds produce different sequences', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  test('values stay in [0, 1)', () => {
    const rng = mulberry32(123);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test('derived seeds are deterministic and lane-dependent', () => {
    expect(deriveSeed(841295, 0)).toBe(deriveSeed(841295, 0));
    expect(deriveSeed(841295, 0)).not.toBe(deriveSeed(841295, 1));
  });
});

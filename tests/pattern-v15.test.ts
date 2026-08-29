import { describe, expect, it } from 'vitest';
import { compilePattern, type CompiledPattern } from '@/pattern/compilePattern';
import { evaluatePattern } from '@/pattern/evaluatePattern';
import {
  LANE_CHOICE,
  LANE_SHUFFLE,
  hashStringToUint32,
  patternPermutation,
  patternRandom01,
} from '@/pattern/patternRandom';
import { canFormatSequence, formatSequencePattern, parsePattern } from '@/pattern/miniNotation';
import type {
  PatternDefinition,
  PatternEvaluationContext,
  PatternTransform,
} from '@/pattern/patternTypes';
import { parseProject, projectSchema, createEmptyProject } from '@shared/schemas/project';

/**
 * Pattern v1.5 — smooth · alternate · rest · iter · maybe · shuffle.
 * Semantics inspired by pattern live-coding systems; implementation and
 * goldens are entirely ours (no ported code — licensing is load-bearing).
 */

const CTX: PatternEvaluationContext = { projectSeed: 12345, patternId: 'pattern-a' };
const HASH_A = hashStringToUint32('pattern-a');

function mustCompile(def: PatternDefinition, transforms: PatternTransform[] = []): CompiledPattern {
  const r = compilePattern(def, transforms);
  if (!r.ok) throw new Error(r.error);
  return r.pattern;
}
const at = (c: CompiledPattern, cycleIndex: number, cyclePhase: number) =>
  evaluatePattern(c, { cycleIndex, cyclePhase }, CTX);
const val = (c: CompiledPattern, cy: number, ph: number) => {
  const r = at(c, cy, ph);
  if (!r.active) throw new Error('unexpected inactive');
  return r.value;
};

// ---------------------------------------------------------------------------
// SMOOTH
// ---------------------------------------------------------------------------

describe('smooth', () => {
  it('lerps toward the next step by intra-step phase (golden)', () => {
    const c = mustCompile({ type: 'sequence', values: [0, 1] }, [{ type: 'smooth' }]);
    expect(val(c, 0, 0.125)).toBe(0.25); // step 0, frac .25 → 0→1
    expect(val(c, 0, 0.25)).toBe(0.5);
    expect(val(c, 0, 0.375)).toBe(0.75);
    expect(val(c, 0, 0.625)).toBe(0.75); // step 1, frac .25 → 1→0 (wraps)
    expect(val(c, 0, 0)).toBe(0);
  });

  it('is stateless: direct seek equals playback-through exactly', () => {
    const c = mustCompile({ type: 'sequence', values: [0.1, 0.9, 0.4] }, [
      { type: 'fast', factor: 2 },
      { type: 'smooth' },
    ]);
    const direct = val(c, 41, 0.37);
    for (let f = 0; f < 300; f++) at(c, f / 60, (f % 60) / 60);
    expect(val(c, 41, 0.37)).toBe(direct);
  });

  it('respects the transformed presentation: reversed patterns lerp toward the reversed next', () => {
    const plain = mustCompile({ type: 'sequence', values: [0, 1, 0.5, 0.25] }, [{ type: 'smooth' }]);
    const reversed = mustCompile({ type: 'sequence', values: [0, 1, 0.5, 0.25] }, [
      { type: 'reverse' },
      { type: 'smooth' },
    ]);
    // Reversed at phase p mirrors plain — including the interpolation target.
    expect(val(reversed, 0, 0.1)).not.toBe(val(plain, 0, 0.1));
  });

  it('falls back to steps around rests and booleans', () => {
    const c = mustCompile({ type: 'sequence', values: [0.5, null, 1] }, [{ type: 'smooth' }]);
    expect(val(c, 0, 0.1)).toBe(0.5); // next is a rest → no lerp
    expect(at(c, 0, 0.5).active).toBe(false); // the rest itself
    const b = mustCompile({ type: 'sequence', values: [true, false] }, [{ type: 'smooth' }]);
    expect(val(b, 0, 0.1)).toBe(true); // booleans never interpolate
  });

  it('cannot nest inside EVERY', () => {
    const r = compilePattern({ type: 'sequence', values: [0, 1] }, [
      { type: 'every', cycles: 2, transform: { type: 'smooth' } as never },
    ]);
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ALTERNATE + rest
// ---------------------------------------------------------------------------

describe('alternate', () => {
  it('holds one value for the whole cycle, rotating per cycle', () => {
    const c = mustCompile({ type: 'alternate', values: [0, 0.5, 1] });
    for (const ph of [0, 0.3, 0.99]) expect(val(c, 0, ph)).toBe(0);
    expect(val(c, 1, 0.5)).toBe(0.5);
    expect(val(c, 2, 0.5)).toBe(1);
    expect(val(c, 3, 0.5)).toBe(0); // wraps
    expect(val(c, -1, 0.5)).toBe(1); // pre-roll uses true modulo
  });

  it('the transform algebra still applies to the cycle deck', () => {
    const c = mustCompile({ type: 'alternate', values: [0, 0.5, 1] }, [{ type: 'reverse' }]);
    expect(val(c, 0, 0.5)).toBe(1);
    expect(val(c, 1, 0.5)).toBe(0.5);
    expect(val(c, 2, 0.5)).toBe(0);
  });

  it('a rest cycle is silent, then the next cycle plays again', () => {
    const c = mustCompile({ type: 'alternate', values: [1, null] });
    expect(at(c, 0, 0.5).active).toBe(true);
    expect(at(c, 1, 0.5).active).toBe(false);
    expect(at(c, 2, 0.5).active).toBe(true);
  });

  it('smooth on alternate interpolates across the cycle toward the next value', () => {
    const c = mustCompile({ type: 'alternate', values: [0, 1] }, [{ type: 'smooth' }]);
    expect(val(c, 0, 0)).toBe(0);
    expect(val(c, 0, 0.5)).toBe(0.5);
    expect(val(c, 1, 0.5)).toBe(0.5); // 1 → 0
  });
});

describe('rest (~)', () => {
  it('a rest step is inactive and never degrade-sampled', () => {
    const c = mustCompile({ type: 'sequence', values: [1, null, 0.5, null] }, [
      { type: 'degrade', probability: 1 },
    ]);
    expect(at(c, 0, 0.125).active).toBe(true);
    expect(at(c, 0, 0.375).active).toBe(false);
    expect(at(c, 0, 0.625).active).toBe(true);
    expect(at(c, 0, 0.875).active).toBe(false);
  });

  it('constant cannot be a rest', () => {
    expect(compilePattern({ type: 'constant', value: null }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ITER
// ---------------------------------------------------------------------------

describe('iter', () => {
  it('advances the rotation by steps per cycle', () => {
    const c = mustCompile({ type: 'sequence', values: [1, 2, 3, 4] }, [{ type: 'iter', steps: 1 }]);
    const cycleAt = (cy: number) => [0, 1, 2, 3].map((i) => val(c, cy, (i + 0.5) / 4));
    expect(cycleAt(0)).toEqual([1, 2, 3, 4]);
    expect(cycleAt(1)).toEqual([2, 3, 4, 1]);
    expect(cycleAt(2)).toEqual([3, 4, 1, 2]);
    expect(cycleAt(4)).toEqual([1, 2, 3, 4]); // n cycles → home
    expect(cycleAt(-1)).toEqual([4, 1, 2, 3]); // pre-roll extends backwards
  });

  it('iter 0 is identity and equals rotate-by-cycle semantics', () => {
    const id = mustCompile({ type: 'sequence', values: [1, 2, 3] }, [{ type: 'iter', steps: 0 }]);
    expect([0, 1, 2].map((i) => val(id, 5, (i + 0.5) / 3))).toEqual([1, 2, 3]);
    // iter k at cycle c ≡ rotate −k·c (iter advances the start; rotate
    // shifts the pattern forward — opposite signs by design).
    const it2 = mustCompile({ type: 'sequence', values: [1, 2, 3, 4] }, [{ type: 'iter', steps: 2 }]);
    const rot6 = mustCompile({ type: 'sequence', values: [1, 2, 3, 4] }, [{ type: 'rotate', steps: -6 }]);
    for (let i = 0; i < 4; i++) {
      expect(val(it2, 3, (i + 0.5) / 4)).toBe(val(rot6, 3, (i + 0.5) / 4));
    }
  });

  it('nests inside EVERY', () => {
    const c = mustCompile({ type: 'sequence', values: [1, 2] }, [
      { type: 'every', cycles: 2, transform: { type: 'iter', steps: 1 } },
    ]);
    expect(val(c, 0, 0.25)).toBe(1); // untransformed cycle
    expect(val(c, 1, 0.25)).toBe(2); // every-2 fires, iter rotates by cycle 1
  });
});

// ---------------------------------------------------------------------------
// MAYBE
// ---------------------------------------------------------------------------

describe('maybe', () => {
  // Golden CHOICE-lane samples (seed 12345, 'pattern-a', salt 0), cycles 0..7:
  // [.9963, .2967, .6890, .9406, .6130, .5450, .1978, .5761]
  const APPLIED_AT_HALF = [1, 6]; // sample < 0.5

  it('applies its transform on deterministic cycles (golden)', () => {
    const c = mustCompile({ type: 'sequence', values: [1, 2, 3, 4] }, [
      { type: 'maybe', probability: 0.5, transform: { type: 'reverse' } },
    ]);
    for (let cy = 0; cy < 8; cy++) {
      const first = val(c, cy, 0.125);
      const expected = APPLIED_AT_HALF.includes(cy) ? 4 : 1;
      expect(first, `cycle ${cy}`).toBe(expected);
    }
  });

  it('p=0 never applies, p=1 always applies', () => {
    const never = mustCompile({ type: 'sequence', values: [1, 2] }, [
      { type: 'maybe', probability: 0, transform: { type: 'reverse' } },
    ]);
    const always = mustCompile({ type: 'sequence', values: [1, 2] }, [
      { type: 'maybe', probability: 1, transform: { type: 'reverse' } },
    ]);
    for (let cy = 0; cy < 12; cy++) {
      expect(val(never, cy, 0.25)).toBe(1);
      expect(val(always, cy, 0.25)).toBe(2);
    }
  });

  it('lives on the CHOICE lane — Degrade decisions are untouched by adding maybe', () => {
    const bare = mustCompile({ type: 'sequence', values: [1] }, [
      { type: 'degrade', probability: 0.5 },
    ]);
    const withMaybe = mustCompile({ type: 'sequence', values: [1] }, [
      { type: 'maybe', probability: 0.5, transform: { type: 'rotate', steps: 0 } },
      { type: 'degrade', probability: 0.5 },
    ]);
    for (let cy = 0; cy < 24; cy++) {
      expect(at(withMaybe, cy, 0.5).active).toBe(at(bare, cy, 0.5).active);
    }
    expect(patternRandom01(12345, HASH_A, LANE_CHOICE, 3, 0, 0)).not.toBe(
      patternRandom01(12345, HASH_A, 0, 3, 0, 0),
    );
  });

  it('two maybes in one chain decide independently (compile-time salt)', () => {
    const c = mustCompile({ type: 'sequence', values: [1, 2, 3, 4] }, [
      { type: 'maybe', probability: 0.5, transform: { type: 'rotate', steps: 1 } },
      { type: 'maybe', probability: 0.5, transform: { type: 'reverse' } },
    ]);
    // Determinism + at least one cycle where the two decisions differ.
    const rows = Array.from({ length: 16 }, (_, cy) =>
      [0, 1, 2, 3].map((i) => val(c, cy, (i + 0.5) / 4)).join(','),
    );
    expect(rows).toEqual(
      Array.from({ length: 16 }, (_, cy) =>
        [0, 1, 2, 3].map((i) => val(c, cy, (i + 0.5) / 4)).join(','),
      ),
    );
    expect(new Set(rows).size).toBeGreaterThan(2);
  });

  it('cannot nest EVERY or MAYBE', () => {
    expect(
      compilePattern({ type: 'sequence', values: [1] }, [
        { type: 'maybe', probability: 0.5, transform: { type: 'maybe' } as never },
      ]).ok,
    ).toBe(false);
    expect(
      compilePattern({ type: 'sequence', values: [1] }, [
        { type: 'maybe', probability: Number.NaN, transform: { type: 'reverse' } },
      ]).ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SHUFFLE
// ---------------------------------------------------------------------------

describe('shuffle', () => {
  it('permutes the deck per cycle, deterministically (golden)', () => {
    // patternPermutation(12345,'pattern-a', c, 4): c0=[1,3,0,2] c1=[3,2,0,1] c2=[3,2,1,0]
    expect(patternPermutation(12345, HASH_A, 0, 4)).toEqual([1, 3, 0, 2]);
    expect(patternPermutation(12345, HASH_A, 1, 4)).toEqual([3, 2, 0, 1]);
    expect(patternPermutation(12345, HASH_A, 2, 4)).toEqual([3, 2, 1, 0]);
    const c = mustCompile({ type: 'sequence', values: [10, 20, 30, 40] }, [{ type: 'shuffle' }]);
    expect([0, 1, 2, 3].map((i) => val(c, 0, (i + 0.5) / 4))).toEqual([20, 40, 10, 30]);
    expect([0, 1, 2, 3].map((i) => val(c, 1, (i + 0.5) / 4))).toEqual([40, 30, 10, 20]);
  });

  it('every cycle is a valid permutation — same multiset, new order', () => {
    const c = mustCompile({ type: 'sequence', values: [1, 2, 3, 4, 5] }, [{ type: 'shuffle' }]);
    const orders = new Set<string>();
    for (let cy = 0; cy < 20; cy++) {
      const row = [0, 1, 2, 3, 4].map((i) => val(c, cy, (i + 0.5) / 5));
      expect([...row].sort()).toEqual([1, 2, 3, 4, 5]);
      orders.add(row.join(','));
    }
    expect(orders.size).toBeGreaterThan(5);
  });

  it('seek-safe and seed-sensitive', () => {
    const c = mustCompile({ type: 'sequence', values: [1, 2, 3, 4] }, [{ type: 'shuffle' }]);
    const direct = val(c, 77, 0.375);
    for (let f = 0; f < 200; f++) at(c, f, 0.1);
    expect(val(c, 77, 0.375)).toBe(direct);
    const otherSeed = evaluatePattern(
      c,
      { cycleIndex: 77, cyclePhase: 0.375 },
      { projectSeed: 999, patternId: 'pattern-a' },
    );
    expect(otherSeed.active).toBe(true);
    expect(patternPermutation(999, HASH_A, 77, 4)).not.toEqual(
      patternPermutation(12345, HASH_A, 77, 4),
    );
    expect(LANE_SHUFFLE).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Mini-notation v1.1: '~' and '<a b c>'
// ---------------------------------------------------------------------------

describe('mini-notation v1.5', () => {
  it("parses '~' as a rest inside a sequence", () => {
    const r = parsePattern('1 ~ 0.5 ~');
    expect(r.ok && r.definition).toEqual({ type: 'sequence', values: [1, null, 0.5, null] });
  });

  it('parses <a b c> as a whole-pattern alternation', () => {
    const r = parsePattern('  <0 0.5 1>  ');
    expect(r.ok && r.definition).toEqual({ type: 'alternate', values: [0, 0.5, 1] });
    const withRest = parsePattern('<1 ~ 2>');
    expect(withRest.ok && withRest.definition).toEqual({
      type: 'alternate',
      values: [1, null, 2],
    });
  });

  it('rejects alternation inside a sequence and unclosed brackets', () => {
    for (const bad of ['0 <1 2> 3', '<1 2', '1 2>', '<>', '< >', '~', '~ ~']) {
      const r = parsePattern(bad);
      expect(r.ok, `"${bad}" must not parse`).toBe(false);
    }
  });

  it('formats canonically and round-trips', () => {
    expect(formatSequencePattern({ type: 'sequence', values: [1, null, 0.5] })).toBe('1 ~ 0.5');
    expect(formatSequencePattern({ type: 'alternate', values: [0, 0.25, null] })).toBe(
      '<0 0.25 ~>',
    );
    for (const text of ['1 ~ 0.5', '<0 0.25 ~>', '<1 2 3>']) {
      const parsed = parsePattern(text);
      if (!parsed.ok) throw new Error(text);
      expect(canFormatSequence(parsed.definition)).toBe(true);
      expect(formatSequencePattern(parsed.definition)).toBe(text);
    }
  });
});

// ---------------------------------------------------------------------------
// Persistence: additive v2, round-trip
// ---------------------------------------------------------------------------

describe('persistence', () => {
  it('alternate/rest/new transforms round-trip through the project schema', () => {
    const base = createEmptyProject('v15');
    const project = {
      ...base,
      patternSources: [
        {
          id: 'pat-v15',
          enabled: true,
          beatsPerCycle: 4,
          pattern: { type: 'alternate' as const, values: [0, null, 1] },
          transforms: [
            { type: 'iter' as const, steps: 1 },
            { type: 'maybe' as const, probability: 0.4, transform: { type: 'reverse' as const } },
            { type: 'shuffle' as const },
            { type: 'smooth' as const },
            { type: 'degrade' as const, probability: 0.8 },
          ],
        },
      ],
    };
    const reloaded = parseProject(JSON.parse(JSON.stringify(projectSchema.parse(project))));
    expect(reloaded.patternSources[0]).toEqual(project.patternSources[0]);
  });
});

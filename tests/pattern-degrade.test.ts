import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compilePattern, type CompiledPattern } from '@/pattern/compilePattern';
import { evaluatePattern } from '@/pattern/evaluatePattern';
import {
  LANE_DEGRADE,
  deriveMatchesSanctioned,
  hashPatternId,
  hashStringToUint32,
  patternRandom01,
} from '@/pattern/patternRandom';
import type {
  PatternDefinition,
  PatternEvaluationContext,
  PatternTransform,
} from '@/pattern/patternTypes';
import { deriveSeed, mulberry32, mulberry32Once } from '@/utils/prng';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mustCompile(def: PatternDefinition, transforms: PatternTransform[] = []): CompiledPattern {
  const result = compilePattern(def, transforms);
  if (!result.ok) throw new Error(result.error);
  return result.pattern;
}

const seq = (values: (number | boolean)[]): PatternDefinition => ({ type: 'sequence', values });
const euclid = (
  pulses: number,
  steps: number,
  rotation = 0,
  activeValue: number | boolean = 1,
  inactiveValue: number | boolean = 0,
): PatternDefinition => ({ type: 'euclidean', pulses, steps, rotation, activeValue, inactiveValue });
const degrade = (probability: number): PatternTransform => ({ type: 'degrade', probability });

const CTX_A: PatternEvaluationContext = { projectSeed: 12345, patternId: 'pattern-a' };
const CTX_B: PatternEvaluationContext = { projectSeed: 12345, patternId: 'pattern-b' };

const HASH_A = hashStringToUint32('pattern-a');

const r = (seed: number, id: string, cycle: number, step: number, salt = 0) =>
  patternRandom01(seed, hashStringToUint32(id), LANE_DEGRADE, cycle, step, salt);

// ---------------------------------------------------------------------------
// PRNG foundations
// ---------------------------------------------------------------------------

describe('deterministic sampling foundations', () => {
  it('mulberry32Once is bit-exact with mulberry32(seed)()', () => {
    for (const seed of [0, 1, 12345, 0xffffffff, 0x9e3779b9, 2 ** 31, 987654321]) {
      expect(mulberry32Once(seed)).toBe(mulberry32(seed)());
    }
  });

  it('internal derive is bit-exact with the sanctioned deriveSeed', () => {
    for (const [p, l] of [
      [0, 0],
      [12345, 92873175],
      [0xffffffff, 0xffffffff],
      [777, 3],
      [deriveSeed(1, 2), 0x811c9dc5],
    ] as const) {
      expect(deriveMatchesSanctioned(p, l)).toBe(true);
    }
  });

  it('FNV-1a string hash is stable (golden)', () => {
    expect(hashStringToUint32('pattern-a')).toBe(92873175);
    expect(hashStringToUint32('pattern-b')).toBe(109650794);
    expect(hashStringToUint32('')).toBe(2166136261);
    expect(hashPatternId('pattern-a')).toBe(92873175);
    // Memoized path returns the same value on repeat.
    expect(hashPatternId('pattern-a')).toBe(92873175);
  });
});

// ---------------------------------------------------------------------------
// patternRandom01 — golden samples (§32)
// ---------------------------------------------------------------------------
// COMPATIBILITY: these exact values become project semantics once patterns
// persist (P6). Changing hash/derivation later would visually alter saved
// projects. Do not "fix" these numbers.

describe('patternRandom01 golden samples', () => {
  it('locks exact deterministic samples', () => {
    expect(r(12345, 'pattern-a', 0, 0)).toBe(0.45305717131122947);
    expect(r(12345, 'pattern-a', 0, 1)).toBe(0.7962316782213748);
    expect(r(12345, 'pattern-a', 1, 0)).toBe(0.29400141816586256);
    expect(r(12345, 'pattern-b', 0, 0)).toBe(0.9093667166307569);
    expect(r(54321, 'pattern-a', 0, 0)).toBe(0.7741320563945919);
    expect(patternRandom01(12345, HASH_A, 1, 0, 0)).toBe(0.9963159409817308); // lane 1
    expect(r(12345, 'pattern-a', 0, 0, 1)).toBe(0.29862849437631667); // salt 1
  });

  it('pre-roll cycles are deterministic and distinct (golden)', () => {
    expect(r(12345, 'pattern-a', -1, 0)).toBe(0.3229152497369796);
    expect(r(12345, 'pattern-a', -100, 2)).toBe(0.7525064253713936);
    expect(r(12345, 'pattern-a', -1, 0)).not.toBe(r(12345, 'pattern-a', 0, 0));
    expect(r(12345, 'pattern-a', -2, 0)).not.toBe(r(12345, 'pattern-a', 1, 0));
  });

  it('cycles beyond uint32 stay distinct — hi-word derivation (golden)', () => {
    expect(r(12345, 'pattern-a', 2 ** 40, 0)).toBe(0.6240133382380009);
    // A single truncated zigzag word would collide 2^40 with 0.
    expect(r(12345, 'pattern-a', 2 ** 40, 0)).not.toBe(r(12345, 'pattern-a', 0, 0));
    expect(r(12345, 'pattern-a', 2 ** 33 + 5, 3)).toBe(r(12345, 'pattern-a', 2 ** 33 + 5, 3));
  });

  it('same key is exact-identical across 10k repeated calls', () => {
    const first = r(12345, 'pattern-a', 7, 3);
    for (let i = 0; i < 10000; i++) {
      expect(r(12345, 'pattern-a', 7, 3)).toBe(first);
    }
  });

  it('samples stay in [0,1)', () => {
    for (let i = 0; i < 1000; i++) {
      const s = r(i, 'range', i * 17 - 500, i % 16);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(1);
    }
  });

  it('distribution sanity: ~half of 10k independent keys pass p=.5 (broad bound)', () => {
    let pass = 0;
    for (let i = 0; i < 10000; i++) {
      if (r(12345, 'pattern-a', Math.floor(i / 16), i % 16) < 0.5) pass++;
    }
    expect(pass).toBeGreaterThan(4000);
    expect(pass).toBeLessThan(6000);
  });
});

// ---------------------------------------------------------------------------
// Degrade compile validation (§24)
// ---------------------------------------------------------------------------

describe('degrade compilation', () => {
  it('accepts 0, 1, and intermediate probabilities', () => {
    for (const p of [0, 0.5, 1]) {
      expect(compilePattern(seq([1]), [degrade(p)]).ok).toBe(true);
    }
  });

  it('rejects NaN, Infinity and out-of-range probabilities', () => {
    for (const p of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1]) {
      const result = compilePattern(seq([1]), [degrade(p)]);
      expect(result.ok).toBe(false);
    }
  });

  it('EVERY cannot wrap DEGRADE', () => {
    const bad: PatternTransform = {
      type: 'every',
      cycles: 2,
      transform: { type: 'degrade', probability: 0.5 } as never,
    };
    const result = compilePattern(seq([1]), [bad]);
    expect(result).toEqual({ ok: false, error: 'EVERY cannot wrap DEGRADE' });
  });

  it('degrade compiles into gates, not coordinate transforms', () => {
    const compiled = mustCompile(seq([1, 2]), [degrade(0.5), { type: 'fast', factor: 2 }]);
    expect(compiled.degrades).toEqual([0.5]);
    expect(compiled.transforms).toEqual([{ type: 'fast', factor: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// Event metadata (§20–§22)
// ---------------------------------------------------------------------------

describe('event metadata', () => {
  it('sequence and constant: every step is an event', () => {
    const s = mustCompile(seq([0, 1, 0]));
    expect(s.events).toBeNull();
    for (let i = 0; i < 3; i++) {
      const e = evaluatePattern(s, { cycleIndex: 0, cyclePhase: (i + 0.5) / 3 });
      expect(e).toMatchObject({ active: true, event: true });
    }
    const c = evaluatePattern(mustCompile({ type: 'constant', value: 7 }), {
      cycleIndex: 0,
      cyclePhase: 0.5,
    });
    expect(c).toMatchObject({ active: true, event: true });
  });

  it('euclidean: pulses are events, rests are not — independent of value equality', () => {
    // activeValue === inactiveValue: events must still track the mask.
    const compiled = mustCompile(euclid(3, 8, 0, 5, 5));
    const pulses = [0, 3, 6]; // E(3,8) = 10010010
    for (let i = 0; i < 8; i++) {
      const e = evaluatePattern(compiled, { cycleIndex: 0, cyclePhase: (i + 0.5) / 8 });
      expect(e).toMatchObject({ active: true, value: 5, event: pulses.includes(i) });
    }
  });

  it('rotation moves events with the pulses', () => {
    const compiled = mustCompile(euclid(3, 8, 1));
    const pulses = [1, 4, 7];
    for (let i = 0; i < 8; i++) {
      const e = evaluatePattern(compiled, { cycleIndex: 0, cyclePhase: (i + 0.5) / 8 });
      expect(e).toMatchObject({ active: true, event: pulses.includes(i) });
    }
  });
});

// ---------------------------------------------------------------------------
// Degrade semantics (§8, §9, §18, §19, §22)
// ---------------------------------------------------------------------------

describe('degrade semantics', () => {
  it('p=0 never active, p=1 always active', () => {
    const never = mustCompile(seq([1, 2, 3, 4]), [degrade(0)]);
    const always = mustCompile(seq([1, 2, 3, 4]), [degrade(1)]);
    for (let c = -8; c < 8; c++) {
      for (let i = 0; i < 4; i++) {
        const pos = { cycleIndex: c, cyclePhase: (i + 0.5) / 4 };
        expect(evaluatePattern(never, pos, CTX_A)).toEqual({ active: false });
        expect(evaluatePattern(always, pos, CTX_A)).toMatchObject({ active: true, value: i + 1 });
      }
    }
  });

  it('locks the exact comparison rule: sample < probability keeps', () => {
    // Golden: sample(seed 12345, 'pattern-a', c0, s0) = 0.45305717131122947.
    const pos = { cycleIndex: 0, cyclePhase: 0.5 };
    const below = mustCompile(seq([9]), [degrade(0.453)]);
    const above = mustCompile(seq([9]), [degrade(0.454)]);
    expect(evaluatePattern(below, pos, CTX_A)).toEqual({ active: false });
    expect(evaluatePattern(above, pos, CTX_A)).toMatchObject({ active: true, value: 9 });
  });

  it('boolean false is an active event value — not inactive', () => {
    const kept = evaluatePattern(mustCompile(seq([false]), [degrade(1)]), {
      cycleIndex: 0,
      cyclePhase: 0.5,
    }, CTX_A);
    expect(kept).toEqual({ active: true, value: false, stepIndex: 0, cycleIndex: 0, event: true });
    const gated = evaluatePattern(mustCompile(seq([false]), [degrade(0)]), {
      cycleIndex: 0,
      cyclePhase: 0.5,
    }, CTX_A);
    expect(gated).toEqual({ active: false });
  });

  it('sequence: value 0 is still a gateable event', () => {
    const compiled = mustCompile(seq([0]), [degrade(0)]);
    expect(evaluatePattern(compiled, { cycleIndex: 0, cyclePhase: 0.5 }, CTX_A)).toEqual({
      active: false,
    });
  });

  it('constant: one decision per cycle, stable within the cycle', () => {
    const compiled = mustCompile({ type: 'constant', value: 1 }, [degrade(0.3)]);
    // Golden samples: c0 = 0.4530… (≥.3 → gated), c1 = 0.2940… (<.3 → kept).
    for (const phase of [0, 0.25, 0.5, 0.9999]) {
      expect(evaluatePattern(compiled, { cycleIndex: 0, cyclePhase: phase }, CTX_A)).toEqual({
        active: false,
      });
      expect(
        evaluatePattern(compiled, { cycleIndex: 1, cyclePhase: phase }, CTX_A),
      ).toMatchObject({ active: true, value: 1 });
    }
  });

  it('multiple degrade gates use independent salts and all must pass', () => {
    const pos = { cycleIndex: 0, cyclePhase: 0.5 };
    expect(
      evaluatePattern(mustCompile(seq([1]), [degrade(1), degrade(1)]), pos, CTX_A),
    ).toMatchObject({ active: true });
    expect(evaluatePattern(mustCompile(seq([1]), [degrade(1), degrade(0)]), pos, CTX_A)).toEqual({
      active: false,
    });
    // Gate gi samples with salt gi — locked against patternRandom01 directly.
    const s0 = patternRandom01(12345, HASH_A, LANE_DEGRADE, 0, 0, 0);
    const s1 = patternRandom01(12345, HASH_A, LANE_DEGRADE, 0, 0, 1);
    expect(s0).not.toBe(s1);
    const both = mustCompile(seq([1]), [degrade(0.5), degrade(0.5)]);
    const expected = s0 < 0.5 && s1 < 0.5;
    expect(evaluatePattern(both, pos, CTX_A).active).toBe(expected);
  });

  it('degraded pattern without context is still deterministic (zero context)', () => {
    const compiled = mustCompile(seq([1, 2]), [degrade(0.5)]);
    for (let c = 0; c < 16; c++) {
      const a = evaluatePattern(compiled, { cycleIndex: c, cyclePhase: 0.25 });
      const b = evaluatePattern(compiled, { cycleIndex: c, cyclePhase: 0.25 });
      expect(a).toEqual(b);
    }
  });
});

// ---------------------------------------------------------------------------
// Euclidean + degrade (§20, §38)
// ---------------------------------------------------------------------------

describe('euclidean + degrade', () => {
  const CTX_E: PatternEvaluationContext = { projectSeed: 1, patternId: 'euclid' };

  it('p=0 gates every pulse; rests stay active with inactiveValue', () => {
    const compiled = mustCompile(euclid(3, 8), [degrade(0)]);
    const pulses = [0, 3, 6];
    for (let i = 0; i < 8; i++) {
      const e = evaluatePattern(compiled, { cycleIndex: 0, cyclePhase: (i + 0.5) / 8 }, CTX_E);
      if (pulses.includes(i)) expect(e).toEqual({ active: false });
      else expect(e).toMatchObject({ active: true, value: 0, event: false });
    }
  });

  it('p=1 keeps every pulse', () => {
    const compiled = mustCompile(euclid(3, 8), [degrade(1)]);
    const pulses = [0, 3, 6];
    for (let i = 0; i < 8; i++) {
      const e = evaluatePattern(compiled, { cycleIndex: 0, cyclePhase: (i + 0.5) / 8 }, CTX_E);
      expect(e).toMatchObject({ active: true, value: pulses.includes(i) ? 1 : 0 });
    }
  });

  it('E(5,16) @ p=.5 — deterministic pulse gating (golden)', () => {
    const compiled = mustCompile(euclid(5, 16), [degrade(0.5)]);
    const pulses = [0, 3, 6, 9, 12]; // E(5,16) = 1001001001001000
    const keptAt = (cycle: number) =>
      pulses.filter(
        (s) =>
          evaluatePattern(compiled, { cycleIndex: cycle, cyclePhase: (s + 0.5) / 16 }, CTX_E)
            .active,
      );
    expect(keptAt(0)).toEqual([3, 6]);
    expect(keptAt(1)).toEqual([0, 3, 6, 12]);
    // Exact repeat of the whole run.
    expect(keptAt(0)).toEqual([3, 6]);
    // Rests untouched at any probability.
    for (let i = 0; i < 16; i++) {
      if (pulses.includes(i)) continue;
      expect(
        evaluatePattern(compiled, { cycleIndex: 0, cyclePhase: (i + 0.5) / 16 }, CTX_E),
      ).toMatchObject({ active: true, value: 0, event: false });
    }
  });
});

// ---------------------------------------------------------------------------
// Transformed-coordinate identity (§13–§15, §33–§37)
// ---------------------------------------------------------------------------

describe('degrade identity follows transformed coordinates', () => {
  it('fast 2: transformed cycles are the event identity', () => {
    const base = mustCompile(seq([1]), [degrade(0.5)]);
    const fast2 = mustCompile(seq([1]), [{ type: 'fast', factor: 2 }, degrade(0.5)]);
    // fast2 at (k, phase) ≡ base at the transformed coordinate — including gating.
    for (let k = -4; k < 12; k++) {
      expect(evaluatePattern(fast2, { cycleIndex: k, cyclePhase: 0.25 }, CTX_A)).toEqual(
        evaluatePattern(base, { cycleIndex: 2 * k, cyclePhase: 0.5 }, CTX_A),
      );
      expect(evaluatePattern(fast2, { cycleIndex: k, cyclePhase: 0.75 }, CTX_A)).toEqual(
        evaluatePattern(base, { cycleIndex: 2 * k + 1, cyclePhase: 0.5 }, CTX_A),
      );
    }
    // Two independently degradable event cycles inside one source cycle.
    const results = [];
    for (let k = 0; k < 32; k++) {
      const first = evaluatePattern(fast2, { cycleIndex: k, cyclePhase: 0.25 }, CTX_A).active;
      const second = evaluatePattern(fast2, { cycleIndex: k, cyclePhase: 0.75 }, CTX_A).active;
      results.push(first !== second);
    }
    expect(results).toContain(true);
  });

  it('slow 4: one sample across the whole stretched event — no mid-event resample', () => {
    const compiled = mustCompile(seq([1, 2, 3, 4]), [{ type: 'slow', factor: 4 }, degrade(0.5)]);
    // All of source cycle 0 lives inside transformed (cycle 0, step 0).
    const reference = evaluatePattern(compiled, { cycleIndex: 0, cyclePhase: 0 }, CTX_A);
    for (const phase of [0.1, 0.5, 0.9, 0.999]) {
      expect(evaluatePattern(compiled, { cycleIndex: 0, cyclePhase: phase }, CTX_A)).toEqual(
        reference,
      );
    }
    // Source cycle 1 is transformed step 1 — a different event key.
    const next = evaluatePattern(compiled, { cycleIndex: 1, cyclePhase: 0.5 }, CTX_A);
    if (next.active && reference.active) {
      expect(next.stepIndex).toBe(1);
    }
  });

  it('reverse: gating keys on the PRESENTED step (locked against patternRandom01)', () => {
    const compiled = mustCompile(seq([1, 2, 3, 4]), [{ type: 'reverse' }, degrade(0.5)]);
    for (let i = 0; i < 4; i++) {
      const e = evaluatePattern(compiled, { cycleIndex: 0, cyclePhase: (i + 0.5) / 4 }, CTX_A);
      const presented = 3 - i;
      const sample = patternRandom01(12345, HASH_A, LANE_DEGRADE, 0, presented, 0);
      expect(e.active).toBe(sample < 0.5);
      if (e.active) expect(e.stepIndex).toBe(presented);
    }
  });

  it('rotate: gating keys on the rotated presented step', () => {
    const compiled = mustCompile(seq([1, 2, 3, 4]), [{ type: 'rotate', steps: 1 }, degrade(0.5)]);
    for (let i = 0; i < 4; i++) {
      const e = evaluatePattern(compiled, { cycleIndex: 0, cyclePhase: (i + 0.5) / 4 }, CTX_A);
      const presented = (((i - 1) % 4) + 4) % 4;
      const sample = patternRandom01(12345, HASH_A, LANE_DEGRADE, 0, presented, 0);
      expect(e.active).toBe(sample < 0.5);
    }
  });

  it('every 4 reverse + degrade .5: direct seek matches playback-through', () => {
    const transforms: PatternTransform[] = [
      { type: 'every', cycles: 4, transform: { type: 'reverse' } },
      degrade(0.5),
    ];
    const played = mustCompile(seq([1, 2, 3, 4]), transforms);
    const playthrough: unknown[] = [];
    for (let c = -4; c < 12; c++) {
      for (let i = 0; i < 4; i++) {
        playthrough.push(evaluatePattern(played, { cycleIndex: c, cyclePhase: (i + 0.5) / 4 }, CTX_A));
      }
    }
    // Fresh compile, direct seeks in reverse order — identical results.
    const seeked = mustCompile(seq([1, 2, 3, 4]), transforms);
    const direct: unknown[] = [];
    for (let c = 11; c >= -4; c--) {
      for (let i = 3; i >= 0; i--) {
        direct.push(evaluatePattern(seeked, { cycleIndex: c, cyclePhase: (i + 0.5) / 4 }, CTX_A));
      }
    }
    expect(direct.reverse()).toEqual(playthrough);
  });
});

// ---------------------------------------------------------------------------
// Independence / order / reload (§27–§31)
// ---------------------------------------------------------------------------

describe('independence and reproducibility', () => {
  const positions = Array.from({ length: 64 }, (_, i) => ({
    cycleIndex: Math.floor(i / 4) - 4,
    cyclePhase: ((i % 4) + 0.5) / 4,
  }));

  it('different projectSeed / patternId / cycle / step give different lanes (golden-checked)', () => {
    expect(r(12345, 'pattern-a', 0, 0)).not.toBe(r(54321, 'pattern-a', 0, 0));
    expect(r(12345, 'pattern-a', 0, 0)).not.toBe(r(12345, 'pattern-b', 0, 0));
    expect(r(12345, 'pattern-a', 0, 0)).not.toBe(r(12345, 'pattern-a', 1, 0));
    expect(r(12345, 'pattern-a', 0, 0)).not.toBe(r(12345, 'pattern-a', 0, 1));
  });

  it('patternId isolates instances of the same definition', () => {
    const a = mustCompile(seq([1, 2, 3, 4]), [degrade(0.5)]);
    const b = mustCompile(seq([1, 2, 3, 4]), [degrade(0.5)]);
    const resultsA = positions.map((p) => evaluatePattern(a, p, CTX_A).active);
    const resultsB = positions.map((p) => evaluatePattern(b, p, CTX_B).active);
    expect(resultsA).not.toEqual(resultsB);
    // Same id → identical, regardless of compiled-object identity.
    expect(positions.map((p) => evaluatePattern(b, p, CTX_A).active)).toEqual(resultsA);
  });

  it('evaluation order is irrelevant — no shared RNG stream', () => {
    const a = mustCompile(euclid(5, 16), [degrade(0.5)]);
    const b = mustCompile(seq([1, 2, 3]), [{ type: 'fast', factor: 2 }, degrade(0.7)]);
    const aFirst = positions.map((p) => [
      evaluatePattern(a, p, CTX_A),
      evaluatePattern(b, p, CTX_B),
    ]);
    const bFirst = positions.map((p) => {
      const rb = evaluatePattern(b, p, CTX_B);
      const ra = evaluatePattern(a, p, CTX_A);
      return [ra, rb];
    });
    expect(bFirst).toEqual(aFirst);
  });

  it('reload: recompiling the same serialized definition reproduces every result', () => {
    const def = euclid(5, 16, 2);
    const transforms: PatternTransform[] = [{ type: 'rotate', steps: 3 }, degrade(0.4)];
    const first = mustCompile(def, transforms);
    const results = positions.map((p) => evaluatePattern(first, p, CTX_A));
    const reloaded = mustCompile(
      JSON.parse(JSON.stringify(def)) as PatternDefinition,
      JSON.parse(JSON.stringify(transforms)) as PatternTransform[],
    );
    expect(positions.map((p) => evaluatePattern(reloaded, p, CTX_A))).toEqual(results);
  });

  it('project seed flows from project.explore.lastSeed (integration-style, pure)', () => {
    // Mirror of the product convention: seed = project.explore.lastSeed ?? 1.
    const project = { explore: { lastSeed: 777 } };
    const ctx: PatternEvaluationContext = {
      projectSeed: project.explore.lastSeed ?? 1,
      patternId: 'pattern-a',
    };
    const literal: PatternEvaluationContext = { projectSeed: 777, patternId: 'pattern-a' };
    const compiled = mustCompile(seq([1, 2, 3, 4]), [degrade(0.5)]);
    const viaProject = positions.map((p) => evaluatePattern(compiled, p, ctx));
    expect(positions.map((p) => evaluatePattern(compiled, p, literal))).toEqual(viaProject);
    // And a different project seed changes outcomes.
    const other = positions.map((p) =>
      evaluatePattern(compiled, p, { projectSeed: 778, patternId: 'pattern-a' }),
    );
    expect(other).not.toEqual(viaProject);
  });
});

// ---------------------------------------------------------------------------
// Hygiene + performance (§40, §41)
// ---------------------------------------------------------------------------

describe('hygiene and performance', () => {
  it('src/pattern contains no Math.random and no timers', () => {
    const dir = join(__dirname, '..', 'src', 'pattern');
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), 'utf8');
      expect(text.includes('Math.random'), `${file} must not use Math.random`).toBe(false);
      expect(/setTimeout|setInterval|requestAnimationFrame/.test(text), `${file} timers`).toBe(
        false,
      );
    }
  });

  it('250 degraded patterns × 1000 frames stays trivial', () => {
    const patterns: CompiledPattern[] = [];
    const contexts: PatternEvaluationContext[] = [];
    for (let i = 0; i < 250; i++) {
      const def =
        i % 3 === 0 ? euclid(5, 16) : i % 3 === 1 ? seq([1, 2, 3, 4, 5, 6, 7, 8]) : seq([1, 0]);
      patterns.push(
        mustCompile(def, [
          { type: 'fast', factor: 2 },
          { type: 'every', cycles: 4, transform: { type: 'reverse' } },
          degrade(0.5),
        ]),
      );
      contexts.push({ projectSeed: 12345, patternId: `bench-${i}` });
    }
    const start = performance.now();
    let acc = 0;
    for (let frame = 0; frame < 1000; frame++) {
      const pos = { cycleIndex: Math.floor(frame / 60), cyclePhase: (frame % 60) / 60 };
      for (let i = 0; i < patterns.length; i++) {
        const e = evaluatePattern(patterns[i]!, pos, contexts[i]);
        if (e.active) acc += Number(e.value);
      }
    }
    const elapsed = performance.now() - start;
    expect(acc).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
  });
});

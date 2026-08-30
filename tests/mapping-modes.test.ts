import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ModulationMapping, modulationMappingSchema } from '@shared/schemas/project';
import {
  SmoothingState,
  applyModulations,
  replaceConflicts,
  shapeMappingValue,
} from '@/modulation/evaluator';
import type { TechniqueDefinition } from '@/techniques/types';

/**
 * v0.4C — the mapping composition model, as pure arithmetic.
 *
 * Every expectation here is a closed-form number, not a relative comparison,
 * because "it moved" is the assertion a broken mapping passes too.
 */

const DEF = {
  id: 'test',
  name: 'Test',
  sections: [
    {
      id: 'main',
      label: 'Main',
      params: [
        { id: 'p', type: 'number', label: 'P', min: 0, max: 10, step: 0.1, default: 2, modulatable: true },
        { id: 'q', type: 'number', label: 'Q', min: -1, max: 1, step: 0.01, default: 0, modulatable: true },
      ],
    },
  ],
} as unknown as TechniqueDefinition;

const map = (over: Partial<ModulationMapping> = {}): ModulationMapping => ({
  id: 'm1',
  enabled: true,
  source: 's',
  target: 'p',
  amount: 1,
  min: 0,
  max: 1,
  invert: false,
  smoothing: 0,
  curve: 'linear',
  frozenValue: null,
  ...over,
});

const resolve = (mappings: ModulationMapping[], values: Record<string, number>, base = { p: 2 }) =>
  applyModulations(
    { ...base } as Record<string, number>,
    mappings,
    values,
    DEF,
    new SmoothingState(),
    1 / 60,
  );

describe('ADD is unchanged — the compatibility promise', () => {
  it('a mapping with no mode behaves exactly as before v0.4C', () => {
    // base 2 + amount 1 * shaped 0.5 * span 10 = 7
    expect(resolve([map()], { s: 0.5 }).p).toBeCloseTo(7, 10);
  });

  it('the output window still scales the contribution, not the parameter', () => {
    // shaped = 0.2 + (0.8-0.2)*0.5 = 0.5 → 2 + 1*0.5*10 = 7
    expect(resolve([map({ min: 0.2, max: 0.8 })], { s: 0.5 }).p).toBeCloseTo(7, 10);
    // shaped = 0.2 + 0.6*1 = 0.8 → 2 + 8 = 10, clamped at the parameter ceiling
    expect(resolve([map({ min: 0.2, max: 0.8 })], { s: 1 }).p).toBeCloseTo(10, 10);
  });

  it('several ADD mappings on one target sum, then clamp once', () => {
    const out = resolve(
      [map({ id: 'a', amount: 0.2 }), map({ id: 'b', amount: 0.3 })],
      { s: 1 },
    );
    expect(out.p).toBeCloseTo(2 + 0.2 * 10 + 0.3 * 10, 10);
  });

  it('an absent source contributes nothing at all — not zero', () => {
    // Zero would be a real contribution once `invert` or a non-zero `min` is
    // involved; absence is the only true neutral.
    expect(resolve([map({ invert: true })], {}).p).toBe(2);
    expect(resolve([map({ min: 0.5, max: 0.5 })], {}).p).toBe(2);
  });
});

describe('REPLACE positions the parameter absolutely', () => {
  it('maps 0..1 onto the parameter range, ignoring where it sat', () => {
    for (const base of [0, 2, 9]) {
      // 0.25 of a 0..10 parameter is 2.5, wherever the slider was.
      expect(resolve([map({ mode: 'replace' })], { s: 0.25 }, { p: base }).p).toBeCloseTo(2.5, 10);
    }
  });

  it('the output window becomes the TRAVEL, in the parameter own units', () => {
    // min 0.15 / max 0.85 on a 0..10 parameter means 1.5 .. 8.5.
    const m = map({ mode: 'replace', min: 0.15, max: 0.85 });
    expect(resolve([m], { s: 0 }).p).toBeCloseTo(1.5, 10);
    expect(resolve([m], { s: 1 }).p).toBeCloseTo(8.5, 10);
    expect(resolve([m], { s: 0.5 }).p).toBeCloseTo(5, 10);
  });

  it('rescues a parameter parked at its ceiling, where ADD has nowhere to go', () => {
    // The measured failure this mode exists for: additive modulation of a
    // parameter already at max can only ever push it further into the clamp.
    expect(resolve([map({ amount: 1 })], { s: 1 }, { p: 10 }).p).toBe(10);
    expect(resolve([map({ amount: 1 })], { s: 0 }, { p: 10 }).p).toBe(10);
    const rep = map({ mode: 'replace' });
    expect(resolve([rep], { s: 1 }, { p: 10 }).p).toBeCloseTo(10, 10);
    expect(resolve([rep], { s: 0 }, { p: 10 }).p).toBeCloseTo(0, 10);
  });

  it('amount blends between where the parameter was and where the signal puts it', () => {
    // base 2, target position 10 * 0.9 = 9 → half way is 5.5
    const m = map({ mode: 'replace', amount: 0.5 });
    expect(resolve([m], { s: 0.9 }, { p: 2 }).p).toBeCloseTo(2 + (9 - 2) * 0.5, 10);
    expect(resolve([map({ mode: 'replace', amount: 0 })], { s: 0.9 }, { p: 2 }).p).toBeCloseTo(2, 10);
  });

  it('REPLACE lands first, then ADD sums on top', () => {
    const out = resolve(
      [
        map({ id: 'r', mode: 'replace', min: 0, max: 1 }),
        map({ id: 'a', amount: 0.1, source: 'other' }),
      ],
      { s: 0.5, other: 1 },
      { p: 9 },
    );
    // replace → 5, then add 0.1 * 1 * 10 = 1 → 6. If the order were reversed
    // the ADD would be erased and this would read 5.
    expect(out.p).toBeCloseTo(6, 10);
  });

  it('a second REPLACE on the same target is INERT, and says so', () => {
    const first = map({ id: 'r1', mode: 'replace' });
    const second = map({ id: 'r2', mode: 'replace', min: 1, max: 1 });
    const ignored = replaceConflicts([first, second]);
    expect([...ignored]).toEqual(['r2']);
    // r2 would force 10; the result is r1's 3, so document order decides and
    // the outcome does not depend on which row happens to evaluate last.
    expect(resolve([first, second], { s: 0.3 }).p).toBeCloseTo(3, 10);
  });

  it('two REPLACE mappings on DIFFERENT targets are both live', () => {
    expect(replaceConflicts([map({ id: 'a', mode: 'replace' }), map({ id: 'b', mode: 'replace', target: 'q' })]).size).toBe(0);
  });

  it('a disabled REPLACE does not claim its target', () => {
    const dead = map({ id: 'r1', mode: 'replace', enabled: false });
    const live = map({ id: 'r2', mode: 'replace', min: 1, max: 1 });
    expect(replaceConflicts([dead, live]).size).toBe(0);
    expect(resolve([dead, live], { s: 0 }).p).toBeCloseTo(10, 10);
  });
});

describe('input window is creative remapping, not calibration', () => {
  it('renormalises the interesting part of a signal to full travel', () => {
    const m = map({ inMin: 0.2, inMax: 0.8 });
    // 0.2 → 0, 0.5 → 0.5, 0.8 → 1
    expect(shapeMappingValue(m, { s: 0.2 }, new SmoothingState(), 1 / 60)).toBeCloseTo(0, 10);
    expect(shapeMappingValue(m, { s: 0.5 }, new SmoothingState(), 1 / 60)).toBeCloseTo(0.5, 10);
    expect(shapeMappingValue(m, { s: 0.8 }, new SmoothingState(), 1 / 60)).toBeCloseTo(1, 10);
  });

  it('clamps outside the window rather than extrapolating', () => {
    const m = map({ inMin: 0.2, inMax: 0.8 });
    expect(shapeMappingValue(m, { s: 0 }, new SmoothingState(), 1 / 60)).toBe(0);
    expect(shapeMappingValue(m, { s: 1 }, new SmoothingState(), 1 / 60)).toBe(1);
  });

  it('the default window is exactly the identity', () => {
    const plain = map();
    const explicit = map({ inMin: 0, inMax: 1 });
    for (const v of [0, 0.137, 0.5, 1]) {
      const a = shapeMappingValue(plain, { s: v }, new SmoothingState(), 1 / 60);
      const b = shapeMappingValue(explicit, { s: v }, new SmoothingState(), 1 / 60);
      expect(a).toBe(b);
      expect(a).toBeCloseTo(v, 12);
    }
  });

  it('a degenerate window cannot divide by zero', () => {
    const m = map({ inMin: 0.5, inMax: 0.5 });
    const v = shapeMappingValue(m, { s: 0.9 }, new SmoothingState(), 1 / 60);
    expect(Number.isFinite(v)).toBe(true);
  });
});

describe('invert on a centred signal mirrors around its own neutral', () => {
  it('1 - v is already the right operation for a 0.5-centred signal', () => {
    // motion.x publishes 0.5 + 0.5*direction, so 1 - v maps +d to -d exactly.
    // No separate bipolar inversion is needed, and adding one would break the
    // unipolar sources that share the evaluator.
    const m = map({ invert: true });
    const st = new SmoothingState();
    expect(shapeMappingValue(m, { s: 0.5 }, st, 1 / 60)).toBeCloseTo(0.5, 12);
    expect(shapeMappingValue(map({ id: 'a', invert: true }), { s: 0.9 }, new SmoothingState(), 1 / 60)).toBeCloseTo(0.1, 12);
    expect(shapeMappingValue(map({ id: 'b', invert: true }), { s: 0.1 }, new SmoothingState(), 1 / 60)).toBeCloseTo(0.9, 12);
  });

  it('a centred signal at rest through a bipolar window contributes nothing', () => {
    // min -1 / max 1 is the default for motion.x/y: shaped(0.5) = 0 exactly,
    // so "still" adds nothing at all rather than a constant bias.
    const m = map({ min: -1, max: 1 });
    expect(shapeMappingValue(m, { s: 0.5 }, new SmoothingState(), 1 / 60)).toBeCloseTo(0, 12);
    expect(resolve([m], { s: 0.5 }).p).toBeCloseTo(2, 10);
    expect(resolve([map({ id: 'l', min: -1, max: 1 })], { s: 0 }).p).toBeCloseTo(0, 10);
    expect(resolve([map({ id: 'r', min: -1, max: 1 })], { s: 1 }).p).toBeCloseTo(10, 10);
  });
});

describe('structural — the mapping model stays where authority is (§63)', () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

  it('the Output replica evaluates no mappings and knows no modes', () => {
    // The replica receives RESOLVED parameter values. If it ever needed to
    // know what `replace` means, authority would have leaked across the
    // channel and two evaluators could disagree.
    const replica = read('src', 'output-window', 'replica.ts');
    for (const forbidden of [
      'applyModulations',
      'replaceConflicts',
      'shapeMappingValue',
      'calibrationStore',
      'ImageStatsReducer',
      "'replace'",
    ]) {
      expect(replica.includes(forbidden), `replica must not reference ${forbidden}`).toBe(false);
    }
  });

  it('the frame message carries resolved params, never signals or mappings', () => {
    const channel = read('shared', 'outputChannel.ts');
    for (const forbidden of ['VisualSignal', 'RawVisualStats', 'ModulationMapping']) {
      expect(channel.includes(forbidden), `channel must not carry ${forbidden}`).toBe(false);
    }
  });

  it('composition order is stated in one place, not rediscovered per call site', () => {
    const evaluator = read('src', 'modulation', 'evaluator.ts');
    expect(evaluator).toContain('function composeTarget');
    // Both apply paths must go through it, or source params and technique
    // params would compose differently.
    const uses = evaluator.split('composeTarget(').length - 1;
    expect(uses).toBeGreaterThanOrEqual(3);
  });
});

describe('old projects keep their exact meaning (§39, §62)', () => {
  it('a mapping stored before v0.4C parses as ADD with an identity window', () => {
    const stored = {
      id: 'm1',
      enabled: true,
      source: 'bass',
      target: 'scale',
      amount: 0.5,
      min: 0,
      max: 1,
      invert: false,
      smoothing: 0.25,
      curve: 'linear',
      frozenValue: null,
    };
    const parsed = modulationMappingSchema.parse(stored);
    // Absent, not defaulted to a value that would then be written back into
    // every project on next save.
    expect(parsed.mode).toBeUndefined();
    expect(parsed.inMin).toBeUndefined();
    expect(parsed.inMax).toBeUndefined();
    // And it evaluates identically to an explicit ADD.
    const legacy = applyModulations({ p: 2 }, [{ ...parsed, target: 'p' }], { bass: 0.5 }, DEF, new SmoothingState(), 1 / 60);
    const explicit = applyModulations({ p: 2 }, [{ ...parsed, target: 'p', mode: 'add', inMin: 0, inMax: 1 }], { bass: 0.5 }, DEF, new SmoothingState(), 1 / 60);
    expect(legacy.p).toBe(explicit.p);
  });

  it('a v0.4C mapping round-trips through the schema unchanged', () => {
    const m = {
      id: 'm2',
      enabled: true,
      source: 'motion.centroidX',
      target: 'centerX',
      amount: 1,
      min: 0.15,
      max: 0.85,
      invert: false,
      smoothing: 0.1,
      curve: 'linear' as const,
      frozenValue: null,
      mode: 'replace' as const,
      inMin: 0.1,
      inMax: 0.9,
    };
    expect(modulationMappingSchema.parse(m)).toEqual(m);
  });
});

describe('smoothing state cannot be permanently poisoned', () => {
  it('a non-finite dt holds the previous value instead of storing NaN', () => {
    // Found while a probe passed a technique id where the evaluator takes a
    // time. One NaN dt used to write NaN into the mapping's smoothing state,
    // and every later step read it back as `prev` — so the parameter sat at
    // NaN for the rest of the session while the mapping still looked enabled.
    const st = new SmoothingState();
    expect(st.step('m', 0.4, 0.25, 1 / 60)).toBeGreaterThan(0);
    const poisoned = st.step('m', 0.8, 0.25, Number.NaN);
    expect(Number.isFinite(poisoned)).toBe(true);
    // And it still tracks afterwards, rather than being stuck.
    const after = st.step('m', 0.8, 0.25, 1 / 60);
    expect(Number.isFinite(after)).toBe(true);
    expect(after).toBeGreaterThan(poisoned);
  });

  it('a non-finite target does not become permanent state', () => {
    const st = new SmoothingState();
    st.step('m', 0.5, 0.25, 1 / 60);
    expect(Number.isFinite(st.step('m', Number.NaN, 0.25, 1 / 60))).toBe(true);
    expect(Number.isFinite(st.step('m', 0.6, 0.25, 1 / 60))).toBe(true);
  });

  it('an infinite dt behaves as a very long step, not as a poison', () => {
    const st = new SmoothingState();
    st.step('m', 0.2, 0.25, 1 / 60);
    expect(Number.isFinite(st.step('m', 0.9, 0.25, Number.POSITIVE_INFINITY))).toBe(true);
  });
});

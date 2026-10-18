import { describe, expect, it } from 'vitest';
import { shapedUnitValue, SmoothingState } from '@/modulation/evaluator';
import { evalSources, MOD_SOURCES, type SourceContext } from '@/modulation/sources';
import type { ModulationMapping } from '@shared/schemas/project';

const ctx = (durationSec: number): SourceContext => ({
  analysis: null,
  durationSec,
  bpm: null,
  beatOffsetSec: 0,
  beatsPerBar: 4,
});

const ramp = (inMin: number, inMax: number): ModulationMapping =>
  ({
    id: 'r', enabled: true, source: 'time.sec', target: 'scale', amount: 1, min: 0, max: 1,
    invert: false, smoothing: 0, curve: 'linear', frozenValue: null, inMin, inMax,
  }) as ModulationMapping;

const at = (m: ModulationMapping, t: number, duration: number) =>
  shapedUnitValue(m, evalSources(t, ctx(duration)), new SmoothingState(), 1 / 25);

describe('time in absolute seconds', () => {
  it('is listed as a source and reports raw seconds', () => {
    expect(MOD_SOURCES.some((s) => s.id === 'time.sec')).toBe(true);
    expect(evalSources(73.5, ctx(220))['time.sec']).toBe(73.5);
    expect(evalSources(-3, ctx(220))['time.sec']).toBe(0);
  });

  it('a 54 s → 220 s ramp is the same ramp whatever the clip length', () => {
    const m = ramp(54, 220);
    for (const duration of [60, 220, 900]) {
      expect(at(m, 40, duration)).toBe(0);
      expect(at(m, 54, duration)).toBe(0);
      expect(at(m, 137, duration)).toBeCloseTo(0.5, 6);
      expect(at(m, 220, duration)).toBe(1);
      expect(at(m, 500, duration)).toBe(1);
    }
  });

  it('the old normalised time still depends on the duration (unchanged)', () => {
    const old = { ...ramp(0, 1), source: 'time', inMin: undefined, inMax: undefined } as ModulationMapping;
    expect(at(old, 30, 60)).toBeCloseTo(0.5, 6);
    expect(at(old, 30, 120)).toBeCloseTo(0.25, 6);
  });
});

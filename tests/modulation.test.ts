import { describe, expect, test } from 'vitest';
import { applyCurve, applyModulations, shapeMappingValue, SmoothingState } from '@/modulation/evaluator';
import { evalSources } from '@/modulation/sources';
import { mosaicDefinition } from '@/techniques/mosaic/definition';
import { defaultParams } from '@/techniques/types';
import { analyzeBuffer } from '@/audio/analysis';
import type { ModulationMapping } from '@shared/schemas/project';

function mapping(patch: Partial<ModulationMapping> = {}): ModulationMapping {
  return {
    id: 'm1',
    enabled: true,
    source: 'bass',
    target: 'depth',
    amount: 1,
    min: 0,
    max: 1,
    invert: false,
    smoothing: 0,
    curve: 'linear',
    frozenValue: null,
    ...patch,
  };
}

describe('curves', () => {
  test('linear passes through, exp squares, log sqrt', () => {
    expect(applyCurve(0.5, 'linear')).toBeCloseTo(0.5);
    expect(applyCurve(0.5, 'exponential')).toBeCloseTo(0.25);
    expect(applyCurve(0.25, 'logarithmic')).toBeCloseTo(0.5);
  });

  test('clamps input to 0..1', () => {
    expect(applyCurve(-1, 'linear')).toBe(0);
    expect(applyCurve(2, 'linear')).toBe(1);
  });
});

describe('shaping', () => {
  test('invert flips source', () => {
    const state = new SmoothingState();
    const v = shapeMappingValue(mapping({ invert: true }), { bass: 0.2 }, state, 1 / 60);
    expect(v).toBeCloseTo(0.8);
  });

  test('min/max window scales output', () => {
    const state = new SmoothingState();
    const v = shapeMappingValue(mapping({ min: 0.4, max: 0.6 }), { bass: 0.5 }, state, 1 / 60);
    expect(v).toBeCloseTo(0.5);
  });

  test('frozen value bypasses source entirely', () => {
    const state = new SmoothingState();
    const v = shapeMappingValue(mapping({ frozenValue: 0.7 }), { bass: 0.1 }, state, 1 / 60);
    expect(v).toBeCloseTo(0.7);
  });

  test('smoothing converges toward target deterministically', () => {
    const state = new SmoothingState();
    const m = mapping({ smoothing: 0.5 });
    let v = 0;
    for (let i = 0; i < 240; i++) {
      v = shapeMappingValue(m, { bass: 1 }, state, 1 / 60);
    }
    expect(v).toBeGreaterThan(0.95);
    // Deterministic replay produces identical sequence.
    const stateB = new SmoothingState();
    let vb = 0;
    for (let i = 0; i < 240; i++) {
      vb = shapeMappingValue(m, { bass: 1 }, stateB, 1 / 60);
    }
    expect(vb).toBe(v);
  });
});

describe('applyModulations', () => {
  test('adds scaled amount into the target range and clamps', () => {
    const base = defaultParams(mosaicDefinition); // depth default 0, range 0..1200
    const out = applyModulations(
      base,
      [mapping({ amount: 0.5 })],
      { bass: 1 },
      mosaicDefinition,
      new SmoothingState(),
      1 / 60,
    );
    expect(out.depth).toBeCloseTo(600);
  });

  test('disabled mappings do nothing', () => {
    const base = defaultParams(mosaicDefinition);
    const out = applyModulations(
      base,
      [mapping({ enabled: false })],
      { bass: 1 },
      mosaicDefinition,
      new SmoothingState(),
      1 / 60,
    );
    expect(out).toEqual(base);
  });

  test('non-modulatable target is ignored', () => {
    const base = defaultParams(mosaicDefinition);
    const out = applyModulations(
      base,
      [mapping({ target: 'columns' })],
      { bass: 1 },
      mosaicDefinition,
      new SmoothingState(),
      1 / 60,
    );
    expect(out.columns).toBe(base.columns);
  });

  test('negative amount subtracts', () => {
    const base = { ...defaultParams(mosaicDefinition), opacity: 1 };
    const out = applyModulations(
      base,
      [mapping({ target: 'opacity', amount: -1 })],
      { bass: 1 },
      mosaicDefinition,
      new SmoothingState(),
      1 / 60,
    );
    expect(out.opacity).toBeCloseTo(0);
  });
});

describe('sources', () => {
  test('beat sources derive phase from bpm', () => {
    const v = evalSources(0.25, { analysis: null, durationSec: 10, bpm: 120, beatOffsetSec: 0 });
    expect(v['beat:1/4']).toBeCloseTo(0.5);
    expect(v.time).toBeCloseTo(0.025);
    expect(v.bass).toBe(0);
  });

  test('audio sources read the analysis', () => {
    const sampleRate = 48000;
    const sine = new Float32Array(sampleRate);
    for (let i = 0; i < sine.length; i++) sine[i] = Math.sin((2 * Math.PI * 80 * i) / sampleRate);
    const analysis = analyzeBuffer(sine, sampleRate);
    const v = evalSources(0.5, { analysis, durationSec: 1, bpm: null, beatOffsetSec: 0 });
    expect(v.bass).toBeGreaterThan(0.5);
    expect(v['beat:bar']).toBe(0);
  });
});

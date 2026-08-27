import { describe, expect, test } from 'vitest';
import { applyModulations, SmoothingState } from '@/modulation/evaluator';
import { evalSources, type SourceContext } from '@/modulation/sources';
import { mosaicDefinition } from '@/techniques/mosaic/definition';
import { defaultParams } from '@/techniques/types';
import { analyzeBuffer } from '@/audio/analysis';
import type { ModulationMapping, ParamRecord } from '@shared/schemas/project';

/**
 * Mirrors the export loop in src/export/exportRunner.ts:
 * frameTime = start + i/fps, fresh smoothing state, fixed dt = 1/fps.
 */
function renderSequence(
  mappings: ModulationMapping[],
  ctx: SourceContext,
  startSec: number,
  fps: number,
  frames: number,
): ParamRecord[] {
  const base = defaultParams(mosaicDefinition);
  const smoothing = new SmoothingState();
  const dt = 1 / fps;
  const out: ParamRecord[] = [];
  for (let i = 0; i < frames; i++) {
    const timeSec = startSec + i / fps;
    const sources = evalSources(timeSec, ctx);
    out.push(applyModulations(base, mappings, sources, mosaicDefinition, smoothing, dt));
  }
  return out;
}

function makeContext(): SourceContext {
  const sampleRate = 48000;
  const mono = new Float32Array(sampleRate * 3);
  // Bass sweep + periodic bursts so every source has something to chew on.
  for (let i = 0; i < mono.length; i++) {
    const t = i / sampleRate;
    const burst = Math.floor(t * 4) % 2 === 0 ? 1 : 0.2;
    mono[i] = Math.sin(2 * Math.PI * 60 * t) * burst + Math.sin(2 * Math.PI * 6000 * t) * 0.3 * burst;
  }
  return {
    analysis: analyzeBuffer(mono, sampleRate),
    durationSec: 3,
    bpm: 120,
    beatOffsetSec: 0,
    beatsPerBar: 4,
  };
}

const MAPPINGS: ModulationMapping[] = [
  {
    id: 'm-bass-depth',
    enabled: true,
    source: 'bass',
    target: 'depth',
    amount: 0.8,
    min: 0,
    max: 1,
    invert: false,
    smoothing: 0.3,
    curve: 'linear',
    frozenValue: null,
  },
  {
    id: 'm-transient-jitter',
    enabled: true,
    source: 'transients',
    target: 'jitterX',
    amount: 0.5,
    min: 0,
    max: 1,
    invert: false,
    smoothing: 0.1,
    curve: 'linear',
    frozenValue: null,
  },
  {
    id: 'm-beat-scale',
    enabled: true,
    source: 'beat:1/4',
    target: 'scale',
    amount: -0.3,
    min: 0,
    max: 1,
    invert: true,
    smoothing: 0.05,
    curve: 'exponential',
    frozenValue: null,
  },
];

describe('export determinism', () => {
  const ctx = makeContext();

  test('two export runs produce byte-identical parameter sequences', () => {
    const a = renderSequence(MAPPINGS, ctx, 0.5, 30, 90);
    const b = renderSequence(MAPPINGS, ctx, 0.5, 30, 90);
    expect(a).toEqual(b);
  });

  test('frame time is exactly frameIndex / fps', () => {
    const fps = 25;
    for (let i = 0; i < 50; i++) {
      expect(1 + i / fps).toBeCloseTo(1 + i * (1 / fps), 12);
    }
  });

  test('smoothed mappings converge across different start points', () => {
    // Smoothing is an EMA, so its value legitimately depends on history —
    // that is exactly why export starts a fresh state at the export start and
    // steps a fixed dt. A run starting 1s earlier converges to within a small
    // fraction of the parameter range by the time both reach t = 2.0.
    const fps = 60;
    const fromZero = renderSequence(MAPPINGS, ctx, 0, fps, 180); // 0..3s
    const fromOne = renderSequence(MAPPINGS, ctx, 1, fps, 120); // 1..3s
    const depthRange = 1200; // mosaic depth max
    const depthDelta = Math.abs(Number(fromZero[120]?.depth) - Number(fromOne[60]?.depth));
    expect(depthDelta / depthRange).toBeLessThan(0.02);
    // scale uses near-zero smoothing → effectively time-addressable.
    expect(Number(fromZero[120]?.scale)).toBeCloseTo(Number(fromOne[60]?.scale), 3);
  });

  test('unsmoothed mappings are exactly time-addressable (no history)', () => {
    const instant = MAPPINGS.map((m) => ({ ...m, smoothing: 0 }));
    const fromZero = renderSequence(instant, ctx, 0, 30, 90);
    const fromOne = renderSequence(instant, ctx, 1, 30, 60);
    expect(fromZero[30]).toEqual(fromOne[0]); // both are t = 1.0
    expect(fromZero[60]).toEqual(fromOne[30]); // both are t = 2.0
  });

  test('frozen mappings stay constant across the whole export', () => {
    const frozen = MAPPINGS.map((m) =>
      m.id === 'm-bass-depth' ? { ...m, frozenValue: 0.42 } : m,
    );
    const seq = renderSequence(frozen, ctx, 0, 30, 60);
    const depths = new Set(seq.map((p) => Number(p.depth).toFixed(6)));
    expect(depths.size).toBe(1);
  });

  test('export sequence is not all-constant (modulation actually moves)', () => {
    const seq = renderSequence(MAPPINGS, ctx, 0, 30, 90);
    const scales = new Set(seq.map((p) => Number(p.scale).toFixed(4)));
    expect(scales.size).toBeGreaterThan(10);
  });
});

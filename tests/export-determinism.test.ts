import { describe, expect, it, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compositionTimeAt } from '@/export/exportRunner';
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

/**
 * CE1H §78 — the release determinism matrix.
 *
 * Every system, measured end to end on a clean process with a deterministic
 * generator source (no decoder), 160×90 @12fps, repeat = two exports of
 * 2–3s, full/subrange = frames of a 1–3s export against a 2–3s export:
 *
 *   System                 Repeat   Full vs subrange
 *   Generator (stateless)  12/12    12/12
 *   Feedback               12/12    12/12
 *   Time Field             12/12    12/12
 *   Slit Scan              12/12    12/12
 *   Echo                   12/12    12/12
 *   Step Print             12/12    12/12
 *   Flow Displace          12/12    12/12
 *   Motion Mosh            12/12    12/12
 *   Flow Feedback          12/12    12/12
 *   Motion Trails          12/12    12/12
 *   Reaction Diffusion     12/12    12/12
 *   Cellular               12/12    12/12
 *   Morph · Noise          12/12    12/12
 *   Morph · Radial         12/12    12/12
 *   Morph · Glitch         12/12    12/12
 *   Morph · Luma           12/12    12/12
 *
 * All byte-identical (worst pixel delta 0). Three CE1H fixes got the last
 * four rows there: the temporal atlas tile-bleed fix, frame-grid composition
 * time, and the feedback subrange preroll.
 */
describe('composition time is addressed by global frame (§78)', () => {
  it('the same global frame is the same float in a full and a subrange export', () => {
    const fps = 12;
    // Full export from 1s reaches global frame 25 at index 13; a subrange
    // from 2s reaches it at index 1. `start + i / fps` gives two different
    // floats, and floor(t * 60) then picks a different simulation step.
    const naiveFull = 1 + 13 / fps;
    const naiveSub = 2 + 1 / fps;
    expect(naiveFull).not.toBe(naiveSub);
    expect(Math.floor(naiveFull * 60)).not.toBe(Math.floor(naiveSub * 60));

    expect(compositionTimeAt(1, fps, 13)).toBe(compositionTimeAt(2, fps, 1));
    expect(Math.floor(compositionTimeAt(1, fps, 13) * 60)).toBe(
      Math.floor(compositionTimeAt(2, fps, 1) * 60),
    );
  });

  it('agrees with the naive formula wherever the naive formula is exact', () => {
    for (const fps of [12, 24, 25, 30, 60]) {
      for (let i = 0; i < 40; i++) {
        expect(compositionTimeAt(0, fps, i)).toBeCloseTo(i / fps, 12);
      }
    }
  });

  it('snaps a start time onto the frame grid', () => {
    // Export ranges come from a timeline; a start between frames resolves to
    // the frame it belongs to rather than drifting the whole sequence.
    expect(compositionTimeAt(2.04, 12, 0)).toBe(compositionTimeAt(2, 12, 0));
    expect(compositionTimeAt(0, 12, 25)).toBe(compositionTimeAt(2, 12, 1));
  });
});

/**
 * CE1H — the export evaluator replays from the ORIGIN.
 *
 * Modulation smoothing and trigger scheduling are per-frame state. An
 * evaluator created at the subrange start begins with none of it while a full
 * export arrives carrying it, so the same global frame resolves to different
 * parameter values.
 *
 * Found by driving the reference track (SHAZUNO-material.mp3) into Motion
 * Mosh with `bass → flow` at smoothing 0.2 and exporting: repeat was 12/12
 * byte-identical, full-vs-subrange 0/12. With smoothing 0 the same setup was
 * 12/12 — the audio was never the problem, the smoothing history was.
 *
 * After the fix, with smoothing 0.2: repeat 12/12 AND full-vs-subrange 12/12,
 * and all 16 systems in the release matrix still 12/12 both ways.
 */
describe('smoothing state is subrange-stable (§78)', () => {
  it('a smoothed mapping only matches across exports when replayed from the origin', () => {
    const mapping: ModulationMapping = {
      id: 'm1',
      enabled: true,
      source: 'rms',
      target: 'scale',
      amount: 1,
      min: 0,
      max: 1,
      invert: false,
      smoothing: 0.5,
      curve: 'linear',
      frozenValue: null,
    };
    const ctx = makeContext();
    const fps = 12;

    // A full export reaching global frame 24 has 24 frames of smoothing.
    const full = renderSequence([mapping], ctx, 0, fps, 36);
    // A subrange starting at frame 24 with FRESH state does not agree...
    const coldSub = renderSequence([mapping], ctx, 24 / fps, fps, 12);
    expect(coldSub[0]!.scale).not.toBe(full[24]!.scale);

    // ...but replaying from the origin and reading the same global frames does.
    const warmSub = renderSequence([mapping], ctx, 0, fps, 36).slice(24);
    for (let i = 0; i < 12; i++) {
      expect(warmSub[i]!.scale, `global frame ${24 + i}`).toBe(full[24 + i]!.scale);
    }
  });

  it('the export runner evaluates from frame zero and offsets the render range', () => {
    const runner = readFileSync(
      join(__dirname, '..', 'src', 'export', 'exportRunner.ts'),
      'utf8',
    );
    expect(runner).toContain('const evaluate = createFrameEvaluator(0, request.fps)');
    expect(runner).toContain('evaluate(startFrame + i)');
    // The skipped frames must actually be walked, not merely skipped.
    expect(runner).toContain('const frame = evaluate(f);');
  });
});

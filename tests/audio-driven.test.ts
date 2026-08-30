import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeBuffer, sampleTrack, type TrackId } from '@/audio/analysis';
import { applyModulations, SmoothingState } from '@/modulation/evaluator';
import { evalSources, type SourceContext } from '@/modulation/sources';
import { getTechnique } from '@/techniques/registry';
import { allParams, defaultParams } from '@/techniques/types';
import { resolvePatternHandles } from '@/pattern/patternSourceRuntime';
import type { ModulationMapping } from '@shared/schemas/project';

/**
 * CE1H — the reference track DRIVING the instrument.
 *
 * audio-material.test.ts proves the analyser reads real music correctly.
 * This proves the next link: that those envelopes reach a Creative Expansion
 * parameter through the real modulation pipeline, move it usefully, and do so
 * identically every time — which is what makes an audio-reactive export
 * reproducible.
 *
 * Fixture: 10s mono @22.05kHz from SHAZUNO-material.mp3 (60s in).
 */

const SAMPLE_RATE = 22050;

function mono(): Float32Array {
  const raw = readFileSync(join(__dirname, 'fixtures', 'shazuno-material-10s.pcm'));
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 32768;
  return out;
}

const analysis = analyzeBuffer(mono(), SAMPLE_RATE);

function context(): SourceContext {
  return {
    analysis,
    durationSec: analysis.durationSec,
    bpm: 120,
    beatOffsetSec: 0,
    beatsPerBar: 4,
    patterns: resolvePatternHandles([]),
    projectSeed: 1,
  };
}

function mapping(target: string, source: string, over: Partial<ModulationMapping> = {}): ModulationMapping {
  return {
    id: 'm1',
    enabled: true,
    source,
    target,
    amount: 1,
    min: 0,
    max: 1,
    invert: false,
    smoothing: 0,
    curve: 'linear',
    frozenValue: null,
    ...over,
  };
}

/** Run the real per-frame pipeline over the fixture at a given fps. */
function drive(
  techniqueId: string,
  paramId: string,
  source: string,
  over: Partial<ModulationMapping> = {},
  fps = 30,
) {
  const technique = getTechnique(techniqueId)!;
  const base = defaultParams(technique);
  const smoothing = new SmoothingState();
  const ctx = context();
  const frames = Math.floor(analysis.durationSec * fps);
  const values: number[] = [];
  for (let i = 0; i < frames; i++) {
    const timeSec = i / fps;
    const sources = evalSources(timeSec, ctx);
    const out = applyModulations(base, [mapping(paramId, source, over)], sources, technique, smoothing, 1 / fps);
    const v = out[paramId];
    if (typeof v === 'number') values.push(v);
  }
  return values;
}

function spread(values: number[]) {
  return Math.max(...values) - Math.min(...values);
}

describe('the reference track drives Creative Expansion parameters (§17)', () => {
  const CASES: [string, string, string][] = [
    ['feedback-zoom', 'zoom', 'bass'],
    ['feedback-bloom', 'gain', 'master'],
    ['time-field', 'depth', 'rms'],
    ['motion-mosh', 'flow', 'peak'],
    ['flow-displace', 'amount', 'transients'],
    ['reaction-diffusion', 'speed', 'centroid'],
  ];

  for (const [techniqueId, paramId, source] of CASES) {
    it(`${source} → ${techniqueId}.${paramId} moves and stays in range`, () => {
      const values = drive(techniqueId, paramId, source);
      const def = allParams(getTechnique(techniqueId)!).find((p) => p.id === paramId);
      expect(values.length).toBeGreaterThan(200);
      expect(def?.type).toBe('number');
      if (def?.type !== 'number') return;

      expect(values.every((v) => Number.isFinite(v))).toBe(true);
      expect(Math.min(...values)).toBeGreaterThanOrEqual(def.min - 1e-9);
      expect(Math.max(...values)).toBeLessThanOrEqual(def.max + 1e-9);
      // Real music must not read as a constant: a dead knob is worse than a
      // wrong one, because it looks like the feature works. Integer-stepped
      // parameters quantize, so the floor is "genuinely varies", not a count.
      const distinct = new Set(values.map((v) => v.toFixed(5))).size;
      const integerStepped = def.step >= 1;
      expect(distinct, `${techniqueId}.${paramId} barely varies`).toBeGreaterThan(
        integerStepped ? 2 : 20,
      );
    });
  }

  it('audio modulation is deterministic frame for frame', () => {
    // This is what makes an audio-reactive EXPORT reproducible: the analysis
    // is offline and the pipeline is pure, so the same second always
    // resolves to the same parameter value.
    const a = drive('motion-mosh', 'flow', 'bass');
    const b = drive('motion-mosh', 'flow', 'bass');
    expect(a).toEqual(b);
  });

  it('the same composition time resolves identically at any frame rate', () => {
    // A 30fps and a 60fps export must agree at the seconds they share, or
    // the same performance renders differently at a different frame rate.
    const at30 = drive('time-field', 'depth', 'rms', {}, 30);
    const at60 = drive('time-field', 'depth', 'rms', {}, 60);
    for (let sec = 1; sec < 9; sec++) {
      expect(at60[sec * 60], `t=${sec}s`).toBeCloseTo(at30[sec * 30]!, 6);
    }
  });

  it('smoothing removes frame-to-frame jitter without freezing the control', () => {
    const raw = drive('feedback-zoom', 'zoom', 'peak', { smoothing: 0 });
    const smooth = drive('feedback-zoom', 'zoom', 'peak', { smoothing: 0.8 });
    const jitter = (v: number[]) =>
      v.slice(1).reduce((acc, x, i) => acc + Math.abs(x - v[i]!), 0) / (v.length - 1);
    expect(jitter(smooth)).toBeLessThan(jitter(raw));
    expect(spread(smooth)).toBeGreaterThan(0);
  });

  it('AMOUNT is what rescues a quiet band — not the mapping range', () => {
    // Worth stating precisely, because the intuitive reading is backwards.
    // `min`/`max` are the mapping's OUTPUT range: shaped = min + (max-min)*v.
    // Narrowing them to a quiet band's real span makes it contribute LESS,
    // not more. Gain lives in `amount`, which multiplies the parameter span.
    const plain = drive('time-field', 'depth', 'mids', { amount: 1 });
    const narrowed = drive('time-field', 'depth', 'mids', { min: 0, max: 0.18 });
    const amplified = drive('time-field', 'depth', 'mids', { amount: 5 });
    expect(spread(narrowed)).toBeLessThan(spread(plain));
    // Amplified travel is bounded by the parameter ceiling, so this is
    // roughly 2.4x rather than 5x — gain buys reach, not headroom.
    expect(spread(amplified)).toBeGreaterThan(spread(plain) * 2);
  });

  it('an inverted mapping pulls a high default downward', () => {
    // persistence defaults near its ceiling, so additive modulation clamps.
    // Inversion is how you actually perform it.
    const plain = drive('feedback-zoom', 'persistence', 'bass');
    const inverted = drive('feedback-zoom', 'persistence', 'bass', {
      invert: true,
      amount: -1,
    });
    expect(spread(inverted)).toBeGreaterThan(spread(plain));
  });

  it('every audio source the UI offers resolves to a finite value', () => {
    const ctx = context();
    const sources = evalSources(4.2, ctx);
    const ids: TrackId[] = [
      'master',
      'rms',
      'peak',
      'bass',
      'mids',
      'highs',
      'centroid',
      'flux',
      'onset',
      'transients',
    ];
    for (const id of ids) {
      const v = sources[id];
      expect(v, `${id} missing`).toBeDefined();
      expect(Number.isFinite(v as number), `${id} not finite`).toBe(true);
      expect(v as number).toBeGreaterThanOrEqual(0);
      expect(v as number).toBeLessThanOrEqual(1);
    }
  });

  it('sampling past the end of the track clamps instead of drifting', () => {
    // An export longer than its audio must not produce NaN at the tail.
    for (const t of [analysis.durationSec, analysis.durationSec + 30, 1e6]) {
      const v = sampleTrack(analysis, 'master', t);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

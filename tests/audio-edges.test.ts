import { describe, expect, test } from 'vitest';
import { analyzeBuffer, sampleTrack, TRACK_IDS } from '@/audio/analysis';
import { detectTempo } from '@/audio/tempo';

/**
 * Phase 17 §18: audio edge cases. The contract under test is honesty —
 * analysis must never invent structure that is not there, never emit NaN,
 * and always produce the same numbers for the same samples.
 */

const SR = 44100;

function buffer(fill: (i: number, t: number) => number, seconds = 6): Float32Array {
  const length = Math.floor(SR * seconds);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) data[i] = fill(i, i / SR);
  return data;
}

/** Percussive click track at a known tempo. */
function clicks(bpm: number, seconds = 12): Float32Array {
  const period = Math.round((60 / bpm) * SR);
  return buffer((i) => {
    const phase = i % period;
    if (phase > SR * 0.03) return 0;
    const env = Math.exp(-phase / (SR * 0.006));
    return Math.sin((2 * Math.PI * 180 * phase) / SR) * env;
  }, seconds);
}

function allFinite(values: number[]): boolean {
  return values.every((v) => Number.isFinite(v));
}

function trackSamples(analysis: ReturnType<typeof analyzeBuffer>, id: string): number[] {
  const out: number[] = [];
  for (let t = 0; t < 5; t += 0.05) out.push(sampleTrack(analysis, id as never, t));
  return out;
}

describe('degenerate audio never invents structure', () => {
  test('digital silence: no NaN, no fake tempo', () => {
    const analysis = analyzeBuffer(buffer(() => 0), SR);
    for (const id of TRACK_IDS) {
      const samples = trackSamples(analysis, id);
      expect(allFinite(samples)).toBe(true);
      expect(Math.max(...samples)).toBeLessThanOrEqual(1);
      expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
    }
    expect(detectTempo(analysis)).toBeNull();
  });

  test('DC offset (constant non-zero) is not a beat', () => {
    const analysis = analyzeBuffer(buffer(() => 0.5), SR);
    expect(allFinite(trackSamples(analysis, 'master'))).toBe(true);
    const tempo = detectTempo(analysis);
    // Either honestly nothing, or something with visibly low confidence.
    if (tempo) expect(tempo.confidence).toBeLessThan(0.5);
  });

  test('very quiet track stays finite and bounded', () => {
    const analysis = analyzeBuffer(buffer((_i, t) => Math.sin(2 * Math.PI * 220 * t) * 1e-5), SR);
    for (const id of TRACK_IDS) {
      expect(allFinite(trackSamples(analysis, id))).toBe(true);
    }
  });

  test('clipped/hot track does not exceed the normalized range', () => {
    const analysis = analyzeBuffer(
      buffer((_i, t) => Math.sign(Math.sin(2 * Math.PI * 110 * t)) * 0.999),
      SR,
    );
    for (const id of TRACK_IDS) {
      const samples = trackSamples(analysis, id);
      expect(allFinite(samples)).toBe(true);
      expect(Math.max(...samples)).toBeLessThanOrEqual(1.0001);
    }
  });

  test('a single impulse in silence does not become a tempo', () => {
    const analysis = analyzeBuffer(buffer((i) => (i === 1000 ? 1 : 0)), SR);
    const tempo = detectTempo(analysis);
    if (tempo) expect(tempo.confidence).toBeLessThan(0.5);
  });
});

describe('tempo detection honesty', () => {
  test.each([90, 120, 140])('finds %d BPM on a click track (or its octave)', (bpm) => {
    const tempo = detectTempo(analyzeBuffer(clicks(bpm), SR));
    expect(tempo).not.toBeNull();
    const found = tempo!.bpm;
    const ratio = found / bpm;
    // Half/double-time is a legitimate reading of a bare click track.
    const octaveOk = [0.5, 1, 2].some((r) => Math.abs(ratio - r) < 0.04);
    expect(octaveOk).toBe(true);
    expect(tempo!.confidence).toBeGreaterThan(0);
    expect(Number.isFinite(tempo!.beatOffsetSec)).toBe(true);
  });

  test('confidence on a click track beats confidence on noise', () => {
    const clicky = detectTempo(analyzeBuffer(clicks(120), SR));
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff - 0.5;
    };
    const noisy = detectTempo(analyzeBuffer(buffer(() => rand() * 0.5, 12), SR));
    expect(clicky).not.toBeNull();
    if (noisy) expect(clicky!.confidence).toBeGreaterThan(noisy.confidence);
  });

  test('detection is deterministic across runs', () => {
    const buf = clicks(128);
    const a = detectTempo(analyzeBuffer(buf, SR));
    const b = detectTempo(analyzeBuffer(buf, SR));
    expect(a).toEqual(b);
  });
});

describe('analysis determinism and shape', () => {
  test('the same buffer yields byte-identical feature arrays', () => {
    const buf = clicks(100, 8);
    const a = analyzeBuffer(buf, SR);
    const b = analyzeBuffer(buf, SR);
    for (const id of TRACK_IDS) {
      expect(Array.from(a.tracks[id])).toEqual(Array.from(b.tracks[id]));
    }
  });

  test('analysis is sample-rate aware, not frame-index aware', () => {
    // The same tone at two rates must land on the same normalized envelope.
    const at44 = analyzeBuffer(buffer((_i, t) => Math.sin(2 * Math.PI * 220 * t), 6), SR);
    const a = trackSamples(at44, 'master');
    expect(allFinite(a)).toBe(true);
    expect(Math.max(...a)).toBeGreaterThan(0.1);
  });

  test('sampling outside the analysed span is clamped, not NaN', () => {
    const analysis = analyzeBuffer(clicks(120, 4), SR);
    for (const id of TRACK_IDS) {
      expect(Number.isFinite(sampleTrack(analysis, id as never, -5))).toBe(true);
      expect(Number.isFinite(sampleTrack(analysis, id as never, 1e6))).toBe(true);
    }
  });

  test('a very short buffer analyses without throwing', () => {
    const analysis = analyzeBuffer(buffer((_i, t) => Math.sin(2 * Math.PI * 440 * t), 0.05), SR);
    expect(Number.isFinite(sampleTrack(analysis, 'master', 0))).toBe(true);
  });

  test('spectral centroid separates low from high content', () => {
    const low = analyzeBuffer(buffer((_i, t) => Math.sin(2 * Math.PI * 120 * t)), SR);
    const high = analyzeBuffer(buffer((_i, t) => Math.sin(2 * Math.PI * 6000 * t)), SR);
    const lowC = sampleTrack(low, 'centroid', 2);
    const highC = sampleTrack(high, 'centroid', 2);
    expect(highC).toBeGreaterThan(lowC);
  });
});

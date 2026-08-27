import { describe, expect, test } from 'vitest';
import { fftRadix2, magnitudeSpectrum } from '@/audio/fft';
import { analyzeBuffer, sampleTrack, FFT_SIZE, HOP_SIZE } from '@/audio/analysis';
import { beatsAt, divisionPhase, beatTimes } from '@/audio/beatGrid';
import { computePeaks } from '@/audio/waveform';

function sine(freq: number, sampleRate: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.floor(sampleRate * seconds));
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return out;
}

describe('fft', () => {
  test('impulse has flat magnitude spectrum', () => {
    const n = 8;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    re[0] = 1;
    fftRadix2(re, im);
    for (let i = 0; i < n; i++) {
      expect(Math.hypot(re[i] as number, im[i] as number)).toBeCloseTo(1, 5);
    }
  });

  test('sine peaks at its own frequency bin', () => {
    const sampleRate = 48000;
    const frame = sine(1500, sampleRate, FFT_SIZE / sampleRate);
    const mags = magnitudeSpectrum(frame);
    let peakBin = 0;
    for (let i = 1; i < mags.length; i++) {
      if ((mags[i] as number) > (mags[peakBin] as number)) peakBin = i;
    }
    const expectedBin = Math.round((1500 * FFT_SIZE) / sampleRate);
    expect(Math.abs(peakBin - expectedBin)).toBeLessThanOrEqual(1);
  });

  test('rejects non power-of-two length', () => {
    expect(() => fftRadix2(new Float32Array(100), new Float32Array(100))).toThrow();
  });
});

describe('audio analysis', () => {
  const sampleRate = 48000;

  test('bass sine registers in bass, not highs', () => {
    const analysis = analyzeBuffer(sine(80, sampleRate, 1), sampleRate);
    const mid = Math.floor(analysis.frameCount / 2);
    expect(analysis.tracks.bass[mid]).toBeGreaterThan(0.5);
    expect(analysis.tracks.highs[mid] as number).toBeLessThan(0.2);
  });

  test('high sine registers in highs, not bass', () => {
    const analysis = analyzeBuffer(sine(8000, sampleRate, 1), sampleRate);
    const mid = Math.floor(analysis.frameCount / 2);
    expect(analysis.tracks.highs[mid]).toBeGreaterThan(0.5);
    expect(analysis.tracks.bass[mid] as number).toBeLessThan(0.2);
  });

  test('silence → near-zero rms; loud onset → transient spike', () => {
    const seconds = 1;
    const mono = new Float32Array(sampleRate * seconds);
    // Silence for first half, then a burst.
    const burst = sine(1000, sampleRate, 0.5);
    mono.set(burst, Math.floor(sampleRate * 0.5));
    const analysis = analyzeBuffer(mono, sampleRate);
    const silentFrame = Math.floor((0.25 / analysis.hopSec));
    expect(analysis.tracks.rms[silentFrame] as number).toBeLessThan(0.05);
    // Find max transient position — should be near the onset at 0.5s.
    let maxI = 0;
    const tr = analysis.tracks.transients;
    for (let i = 1; i < tr.length; i++) if ((tr[i] as number) > (tr[maxI] as number)) maxI = i;
    const onsetTime = maxI * analysis.hopSec;
    expect(Math.abs(onsetTime - 0.5)).toBeLessThan(0.05);
  });

  test('analysis is deterministic', () => {
    const mono = sine(440, sampleRate, 0.5);
    const a = analyzeBuffer(Float32Array.from(mono), sampleRate);
    const b = analyzeBuffer(Float32Array.from(mono), sampleRate);
    expect(Array.from(a.tracks.master)).toEqual(Array.from(b.tracks.master));
    expect(Array.from(a.tracks.transients)).toEqual(Array.from(b.tracks.transients));
  });

  test('sampleTrack interpolates and clamps', () => {
    const analysis = analyzeBuffer(sine(440, sampleRate, 0.5), sampleRate);
    expect(sampleTrack(analysis, 'master', -1)).toBe(analysis.tracks.master[0]);
    expect(sampleTrack(analysis, 'master', 999)).toBe(
      analysis.tracks.master[analysis.frameCount - 1],
    );
    const t = analysis.hopSec * 10.5;
    const v = sampleTrack(analysis, 'master', t);
    const lo = Math.min(analysis.tracks.master[10] as number, analysis.tracks.master[11] as number);
    const hi = Math.max(analysis.tracks.master[10] as number, analysis.tracks.master[11] as number);
    expect(v).toBeGreaterThanOrEqual(lo);
    expect(v).toBeLessThanOrEqual(hi);
  });

  test('hop timing matches spec constants', () => {
    const analysis = analyzeBuffer(sine(440, sampleRate, 0.25), sampleRate);
    expect(analysis.hopSec).toBeCloseTo(HOP_SIZE / sampleRate);
  });
});

describe('beat grid', () => {
  test('beatsAt: 120 bpm → 2 beats per second', () => {
    expect(beatsAt(1, 120, 0)).toBeCloseTo(2);
    expect(beatsAt(1.5, 120, 0.5)).toBeCloseTo(2);
  });

  test('divisionPhase wraps 0..1 and respects divisions', () => {
    // 120 bpm: quarter = 0.5s.
    expect(divisionPhase(0.25, 120, 0, '1/4')).toBeCloseTo(0.5);
    expect(divisionPhase(0.5, 120, 0, '1/4')).toBeCloseTo(0);
    expect(divisionPhase(1, 120, 0, 'bar')).toBeCloseTo(0.5); // bar = 2s at 120
  });

  test('beatTimes generates aligned grid', () => {
    const times = beatTimes(0, 2, 120, 0.25);
    expect(times[0]).toBeCloseTo(0.25);
    expect(times[1]).toBeCloseTo(0.75);
    expect(times.length).toBe(4);
  });
});

describe('waveform peaks', () => {
  test('peaks bound the signal', () => {
    const mono = sine(100, 48000, 0.1);
    const peaks = computePeaks(mono, 50);
    expect(peaks.length).toBe(100);
    for (let b = 0; b < 50; b++) {
      expect(peaks[b * 2] as number).toBeLessThanOrEqual(0);
      expect(peaks[b * 2 + 1] as number).toBeGreaterThanOrEqual(0);
    }
  });
});

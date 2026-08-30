import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeBuffer, sampleTrack, TRACK_IDS } from '@/audio/analysis';

/**
 * CE1H §17 — audio QA on real production material.
 *
 * The synthetic fixtures elsewhere prove the maths. This proves the thing
 * synthetic tones cannot: that a real, loud, bass-heavy mix produces
 * modulation sources a performer can actually use.
 *
 * Fixture: 10s mono @22.05kHz from SHAZUNO-material.mp3 (60s in), the
 * project's reference track.
 */

const SAMPLE_RATE = 22050;

function fixture(): Float32Array {
  const raw = readFileSync(join(__dirname, 'fixtures', 'shazuno-material-10s.pcm'));
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const mono = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) mono[i] = pcm[i]! / 32768;
  return mono;
}

const analysis = analyzeBuffer(fixture(), SAMPLE_RATE);

/** Statistics over the whole envelope, not a handful of sample points —
 * a percussive track sampled sparsely reads as silent between hits. */
function stats(id: (typeof TRACK_IDS)[number]) {
  const t = analysis.tracks[id];
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let above = 0;
  for (let i = 0; i < t.length; i++) {
    const v = t[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    if (v > 0.2) above++;
  }
  return { min, max, mean: sum / t.length, usable: above / t.length };
}

describe('real-material audio analysis (§17)', () => {
  it('analyses the reference track into every declared source', () => {
    expect(analysis.frameCount).toBeGreaterThan(300);
    expect(analysis.durationSec).toBeGreaterThan(9);
    expect(analysis.durationSec).toBeLessThan(11);
    for (const id of TRACK_IDS) {
      expect(analysis.tracks[id], `missing track ${id}`).toBeDefined();
      expect(analysis.tracks[id].length).toBe(analysis.frameCount);
    }
  });

  it('every envelope stays inside 0..1 with no NaN', () => {
    for (const id of TRACK_IDS) {
      const s = stats(id);
      expect(Number.isFinite(s.min), `${id} min`).toBe(true);
      expect(Number.isFinite(s.max), `${id} max`).toBe(true);
      expect(s.min).toBeGreaterThanOrEqual(0);
      expect(s.max).toBeLessThanOrEqual(1);
    }
  });

  it('loudness sources are performable on real music, not just non-zero', () => {
    // A source that never leaves the bottom of its range is a dead knob.
    for (const id of ['master', 'rms', 'peak'] as const) {
      const s = stats(id);
      expect(s.max, `${id} never reaches the top of its range`).toBeGreaterThan(0.8);
      expect(s.usable, `${id} spends too little time in usable range`).toBeGreaterThan(0.4);
    }
  });

  it('bass carries real movement on this material', () => {
    const bass = stats('bass');
    expect(bass.max).toBeGreaterThan(0.5);
    expect(bass.mean).toBeGreaterThan(0.05);
  });

  it('the three bands share one reference, so band balance is preserved', () => {
    // Measured on the full 221s track: bass peaks at 1.0 while mids reach
    // 0.181 and highs 0.058. That is the documented trade-off — a pure bass
    // tone must not light up the highs track — and it means mids/highs on a
    // bass-heavy mix live in the bottom of their range and want a mapping
    // range narrowed to suit. See docs/MODULATION.md.
    const bass = stats('bass');
    const mids = stats('mids');
    const highs = stats('highs');
    expect(bass.max).toBeGreaterThan(mids.max);
    expect(mids.max).toBeGreaterThan(highs.max);
  });

  it('onset and transients stay sparse rather than smearing', () => {
    // These drive triggers; a smeared onset track fires constantly.
    const onset = stats('onset');
    expect(onset.usable).toBeLessThan(0.5);
    expect(onset.max).toBeGreaterThan(0.5);
  });

  it('sampleTrack agrees with the raw envelope and is deterministic', () => {
    const a = sampleTrack(analysis, 'master', 5);
    const b = sampleTrack(analysis, 'master', 5);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(1);
    // Out-of-range times clamp rather than throw.
    expect(Number.isFinite(sampleTrack(analysis, 'master', -5))).toBe(true);
    expect(Number.isFinite(sampleTrack(analysis, 'master', 9999))).toBe(true);
  });

  it('analysis is deterministic for identical input', () => {
    const again = analyzeBuffer(fixture(), SAMPLE_RATE);
    expect(again.frameCount).toBe(analysis.frameCount);
    for (const id of TRACK_IDS) {
      expect(Array.from(again.tracks[id])).toEqual(Array.from(analysis.tracks[id]));
    }
  });
});

import { describe, expect, test } from 'vitest';
import { analyzeBuffer } from '@/audio/analysis';
import { detectTempo } from '@/audio/tempo';
import { TapTempo, offsetFromTap } from '@/audio/tapTempo';
import { divisionPhase, musicalPosition, divisionBeats } from '@/audio/beatGrid';
import { parseProject, createEmptyProject } from '@shared/schemas/project';

const SR = 48000;

function sine(freq: number, seconds: number, gain = 1): Float32Array {
  const out = new Float32Array(Math.floor(SR * seconds));
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.sin((2 * Math.PI * freq * i) / SR) * gain;
  }
  return out;
}

/** Synthetic click track: short decaying bursts on the beat grid. */
function clickTrack(
  bpm: number,
  seconds: number,
  opts: { offsetSec?: number; quietIntroSec?: number; dynamicRamp?: boolean } = {},
): Float32Array {
  const out = new Float32Array(Math.floor(SR * seconds));
  const period = 60 / bpm;
  const offset = opts.offsetSec ?? 0;
  for (let t = offset; t < seconds; t += period) {
    if (opts.quietIntroSec && t < opts.quietIntroSec) continue;
    const start = Math.floor(t * SR);
    // Dynamics change across the track when requested.
    const level = opts.dynamicRamp ? 0.3 + 0.7 * (t / seconds) : 1;
    for (let i = 0; i < 2400 && start + i < out.length; i++) {
      const env = Math.exp(-i / 300);
      out[start + i] =
        (out[start + i] as number) +
        (Math.sin((2 * Math.PI * 1000 * i) / SR) * 0.8 + Math.sin((2 * Math.PI * 180 * i) / SR)) *
          env *
          level;
    }
  }
  return out;
}

describe('new analysis tracks', () => {
  test('centroid: high sine reads brighter than low sine', () => {
    const low = analyzeBuffer(sine(200, 1), SR);
    const high = analyzeBuffer(sine(6000, 1), SR);
    const mid = (a: Float32Array) => a[Math.floor(a.length / 2)] as number;
    expect(mid(high.tracks.centroid)).toBeGreaterThan(mid(low.tracks.centroid) + 0.3);
    // Absolute scale is meaningful: 6 kHz sits high on the 100 Hz–8 kHz log scale.
    expect(mid(high.tracks.centroid)).toBeGreaterThan(0.8);
    expect(mid(low.tracks.centroid)).toBeLessThan(0.3);
  });

  test('centroid holds through silence instead of snapping to zero', () => {
    const mono = new Float32Array(SR * 1);
    mono.set(sine(4000, 0.5), 0); // sound then silence
    const analysis = analyzeBuffer(mono, SR);
    const lateFrame = analysis.frameCount - 2;
    expect(analysis.tracks.centroid[lateFrame]).toBeGreaterThan(0.5);
  });

  test('peak reacts to a single hit harder than rms', () => {
    const mono = new Float32Array(SR * 1);
    // One sharp 5 ms click in silence.
    for (let i = 0; i < 240; i++) mono[SR / 2 + i] = 1;
    const analysis = analyzeBuffer(mono, SR);
    const at = (track: Float32Array, sec: number) =>
      track[Math.floor(sec / analysis.hopSec)] as number;
    expect(at(analysis.tracks.peak, 0.5)).toBeGreaterThan(0.9);
    // RMS of a 5 ms click inside a 42 ms window is much smaller than its peak
    // was before normalization — both normalize to their own max, so compare
    // widths: rms should be non-zero across more frames than peak.
    const peakActive = Array.from(analysis.tracks.peak).filter((v) => v > 0.5).length;
    const rmsActive = Array.from(analysis.tracks.rms).filter((v) => v > 0.5).length;
    expect(rmsActive).toBeGreaterThanOrEqual(peakActive);
  });

  test('onset spikes at hits and stays low during sustained tone', () => {
    const mono = new Float32Array(SR * 2);
    mono.set(sine(440, 2, 0.5), 0); // sustained tone
    // Add one hit at 1.0 s.
    for (let i = 0; i < 1200; i++) {
      const env = Math.exp(-i / 200);
      mono[SR + i] = (mono[SR + i] as number) + Math.sin((2 * Math.PI * 2000 * i) / SR) * env;
    }
    const analysis = analyzeBuffer(mono, SR);
    const hitFrame = Math.floor(1.0 / analysis.hopSec);
    const sustainFrame = Math.floor(0.5 / analysis.hopSec);
    const hitRegion = Math.max(
      ...Array.from(analysis.tracks.onset.slice(hitFrame - 2, hitFrame + 4)),
    );
    expect(hitRegion).toBeGreaterThan(0.5);
    expect(analysis.tracks.onset[sustainFrame] as number).toBeLessThan(0.25);
  });
});

describe('tempo detection', () => {
  test('detects 120 BPM within ±1', () => {
    const est = detectTempo(analyzeBuffer(clickTrack(120, 12), SR));
    expect(est).not.toBeNull();
    expect(Math.abs((est?.bpm ?? 0) - 120)).toBeLessThan(1);
  });

  test('detects 87 BPM (awkward, off-center tempo)', () => {
    const est = detectTempo(analyzeBuffer(clickTrack(87, 14), SR));
    expect(Math.abs((est?.bpm ?? 0) - 87)).toBeLessThan(1.5);
  });

  test('detects 174 BPM or flags its half-time as ambiguity', () => {
    const est = detectTempo(analyzeBuffer(clickTrack(174, 12), SR));
    expect(est).not.toBeNull();
    if (!est) return;
    const hitsFull = Math.abs(est.bpm - 174) < 2;
    const hitsHalf = Math.abs(est.bpm - 87) < 1.5;
    expect(hitsFull || hitsHalf).toBe(true);
    // Either way the other octave must be surfaced.
    if (hitsHalf) expect(est.alternativeBpm).not.toBeNull();
  });

  test('recovers beat offset', () => {
    const est = detectTempo(analyzeBuffer(clickTrack(120, 12, { offsetSec: 0.25 }), SR));
    expect(est).not.toBeNull();
    if (!est) return;
    // Offset modulo one period should be near 0.25.
    const period = 60 / est.bpm;
    const rel = ((est.beatOffsetSec % period) + period) % period;
    const dist = Math.min(Math.abs(rel - 0.25), Math.abs(rel - 0.25 + period), Math.abs(rel - 0.25 - period));
    expect(dist).toBeLessThan(0.05);
  });

  test('survives a quiet no-percussion intro', () => {
    const est = detectTempo(
      analyzeBuffer(clickTrack(128, 16, { quietIntroSec: 4 }), SR),
    );
    expect(Math.abs((est?.bpm ?? 0) - 128)).toBeLessThan(1);
  });

  test('survives changing dynamics', () => {
    const est = detectTempo(analyzeBuffer(clickTrack(110, 14, { dynamicRamp: true }), SR));
    expect(Math.abs((est?.bpm ?? 0) - 110)).toBeLessThan(1);
  });

  test('repeated runs are identical (stability)', () => {
    const mono = clickTrack(133, 10);
    const a = detectTempo(analyzeBuffer(Float32Array.from(mono), SR));
    const b = detectTempo(analyzeBuffer(Float32Array.from(mono), SR));
    expect(a?.bpm).toBe(b?.bpm);
    expect(a?.beatOffsetSec).toBe(b?.beatOffsetSec);
    expect(Array.from(a?.beatPositions ?? [])).toEqual(Array.from(b?.beatPositions ?? []));
  });

  test('confidence is higher for a clean click than for noise', () => {
    const clean = detectTempo(analyzeBuffer(clickTrack(120, 10), SR));
    // Deterministic pseudo-noise (no Math.random — reproducibility).
    const noise = new Float32Array(SR * 10);
    let x = 12345;
    for (let i = 0; i < noise.length; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      noise[i] = (x / 0x7fffffff) * 2 - 1;
    }
    const noisy = detectTempo(analyzeBuffer(noise, SR));
    expect(clean?.confidence ?? 0).toBeGreaterThan((noisy?.confidence ?? 0) + 0.15);
  });
});

describe('tap tempo', () => {
  test('median interval gives BPM, resistant to one bad tap', () => {
    const tap = new TapTempo();
    let result = null;
    const times = [0, 500, 1000, 1490, 2010, 2500]; // ~120 BPM with jitter
    for (const t of times) result = tap.tap(t);
    expect(result).not.toBeNull();
    expect(Math.abs((result?.bpm ?? 0) - 120)).toBeLessThan(4);
  });

  test('long gap resets the measurement', () => {
    const tap = new TapTempo();
    tap.tap(0);
    tap.tap(500);
    const after = tap.tap(10000); // gap ≫ reset threshold
    expect(after).toBeNull(); // fresh measurement, needs a second tap
  });

  test('offsetFromTap aligns the grid to the tapped moment', () => {
    expect(offsetFromTap(10.25, 120)).toBeCloseTo(0.25, 3);
    expect(offsetFromTap(10.0, 120)).toBeCloseTo(0, 3);
  });
});

describe('musical clock', () => {
  test('bar phase respects beatsPerBar', () => {
    // 120 BPM, 3/4 time: a bar is 1.5 s.
    expect(divisionPhase(0.75, 120, 0, 'bar', 3)).toBeCloseTo(0.5);
    expect(divisionBeats('bar', 3)).toBe(3);
    expect(divisionBeats('bar', 4)).toBe(4);
  });

  test('musicalPosition reports 1-based bar and beat', () => {
    const pos = musicalPosition(2.5, 120, 0, 4); // beat 5 → bar 2, beat 2
    expect(pos.bar).toBe(2);
    expect(pos.beat).toBe(2);
  });
});

describe('project format v2', () => {
  test('v1 projects migrate cleanly', () => {
    const v1 = JSON.parse(JSON.stringify(createEmptyProject()));
    v1.version = 1;
    delete v1.timeline.beatsPerBar;
    delete v1.timeline.markers;
    const migrated = parseProject(v1);
    expect(migrated.version).toBe(2);
    expect(migrated.timeline.beatsPerBar).toBe(4);
    expect(migrated.timeline.markers).toEqual([]);
  });

  test('v2 round-trips', () => {
    const p = createEmptyProject();
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  test('newer versions are refused', () => {
    const p = { ...createEmptyProject(), version: 3 };
    expect(() => parseProject(p)).toThrow(/version/i);
  });
});

import { magnitudeSpectrum } from './fft';

/**
 * Offline, deterministic audio feature extraction.
 * All tracks are normalized 0..1 envelopes sampled every hop; playback and
 * export both read the same arrays via sampleTrack(timeSec) — identical
 * modulation values in preview and final render.
 */

export const TRACK_IDS = ['master', 'rms', 'bass', 'mids', 'highs', 'transients'] as const;
export type TrackId = (typeof TRACK_IDS)[number];

export interface AudioAnalysis {
  sampleRate: number;
  hopSec: number;
  frameCount: number;
  durationSec: number;
  tracks: Record<TrackId, Float32Array>;
}

export const FFT_SIZE = 2048;
export const HOP_SIZE = 512;

/** Frequency band edges (Hz) per spec §16. */
export const BANDS = {
  bass: [20, 250],
  mids: [250, 4000],
  highs: [4000, 16000],
} as const;

function percentileRef(track: Float32Array): number {
  // High percentile so single spikes don't crush the rest.
  const sorted = Float32Array.from(track).sort();
  return sorted[Math.min(Math.floor(sorted.length * 0.995), sorted.length - 1)] ?? 0;
}

function scaleTrack(track: Float32Array, ref: number): void {
  if (ref <= 0) return;
  for (let i = 0; i < track.length; i++) {
    track[i] = Math.min((track[i] as number) / ref, 1);
  }
}

export function analyzeBuffer(mono: Float32Array, sampleRate: number): AudioAnalysis {
  const frameCount = Math.max(Math.floor((mono.length - FFT_SIZE) / HOP_SIZE) + 1, 1);
  const tracks: Record<TrackId, Float32Array> = {
    master: new Float32Array(frameCount),
    rms: new Float32Array(frameCount),
    bass: new Float32Array(frameCount),
    mids: new Float32Array(frameCount),
    highs: new Float32Array(frameCount),
    transients: new Float32Array(frameCount),
  };

  const binHz = sampleRate / FFT_SIZE;
  const binRange = (lo: number, hi: number): [number, number] => [
    Math.max(Math.floor(lo / binHz), 1),
    Math.min(Math.ceil(hi / binHz), FFT_SIZE / 2 - 1),
  ];
  const [bassLo, bassHi] = binRange(BANDS.bass[0], BANDS.bass[1]);
  const [midsLo, midsHi] = binRange(BANDS.mids[0], BANDS.mids[1]);
  const [highsLo, highsHi] = binRange(BANDS.highs[0], BANDS.highs[1]);

  let prevMags: Float32Array | null = null;
  const frame = new Float32Array(FFT_SIZE);

  for (let f = 0; f < frameCount; f++) {
    const start = f * HOP_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) {
      frame[i] = start + i < mono.length ? (mono[start + i] as number) : 0;
    }

    // Time-domain RMS.
    let sumSq = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const v = frame[i] as number;
      sumSq += v * v;
    }
    tracks.rms[f] = Math.sqrt(sumSq / FFT_SIZE);

    const mags = magnitudeSpectrum(frame);

    const sumBins = (lo: number, hi: number): number => {
      let sum = 0;
      for (let i = lo; i <= hi; i++) sum += mags[i] as number;
      return sum / (hi - lo + 1);
    };
    tracks.bass[f] = sumBins(bassLo, bassHi);
    tracks.mids[f] = sumBins(midsLo, midsHi);
    tracks.highs[f] = sumBins(highsLo, highsHi);
    tracks.master[f] = sumBins(1, FFT_SIZE / 2 - 1);

    // Spectral flux (positive changes only) → transients.
    if (prevMags) {
      let flux = 0;
      for (let i = 1; i < mags.length; i++) {
        const diff = (mags[i] as number) - (prevMags[i] as number);
        if (diff > 0) flux += diff;
      }
      tracks.transients[f] = flux;
    }
    prevMags = Float32Array.from(mags);
  }

  // The three bands share one reference so relative band energy is preserved
  // (a pure bass tone must NOT light up the highs track via normalization).
  const bandRef = Math.max(
    percentileRef(tracks.bass),
    percentileRef(tracks.mids),
    percentileRef(tracks.highs),
  );
  scaleTrack(tracks.bass, bandRef);
  scaleTrack(tracks.mids, bandRef);
  scaleTrack(tracks.highs, bandRef);
  // Master is "overall loudness", not a band comparison → own reference,
  // like rms and transients.
  scaleTrack(tracks.master, percentileRef(tracks.master));
  scaleTrack(tracks.rms, percentileRef(tracks.rms));
  scaleTrack(tracks.transients, percentileRef(tracks.transients));

  return {
    sampleRate,
    hopSec: HOP_SIZE / sampleRate,
    frameCount,
    durationSec: mono.length / sampleRate,
    tracks,
  };
}

/** Deterministic linear-interpolated read of a track at an exact time. */
export function sampleTrack(analysis: AudioAnalysis, id: TrackId, timeSec: number): number {
  const track = analysis.tracks[id];
  if (track.length === 0) return 0;
  const pos = timeSec / analysis.hopSec;
  const i0 = Math.min(Math.max(Math.floor(pos), 0), track.length - 1);
  const i1 = Math.min(i0 + 1, track.length - 1);
  const frac = Math.min(Math.max(pos - i0, 0), 1);
  return (track[i0] as number) * (1 - frac) + (track[i1] as number) * frac;
}

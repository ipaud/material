import { magnitudeSpectrum } from './fft';

/**
 * Offline, deterministic audio feature extraction.
 * All tracks are normalized 0..1 envelopes sampled every hop; playback and
 * export both read the same arrays via sampleTrack(timeSec) — identical
 * modulation values in preview and final render.
 */

export const TRACK_IDS = [
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
] as const;
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

/**
 * Centroid mapping range. The centroid is normalized on a log-frequency
 * scale between these bounds so it stays a *meaningful brightness* value
 * (0 ≈ 100 Hz rumble, 1 ≈ 8 kHz sizzle) instead of being percentile-crushed.
 */
export const CENTROID_LO_HZ = 100;
export const CENTROID_HI_HZ = 8000;
/** Onset adaptive-mean window (seconds) — local context for "is this a hit?". */
const ONSET_MEAN_WINDOW_SEC = 0.5;

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
    peak: new Float32Array(frameCount),
    bass: new Float32Array(frameCount),
    mids: new Float32Array(frameCount),
    highs: new Float32Array(frameCount),
    centroid: new Float32Array(frameCount),
    flux: new Float32Array(frameCount),
    onset: new Float32Array(frameCount),
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

    // Time-domain RMS over the analysis frame, and peak over the fresh hop
    // (peak on the hop segment keeps it crisp — a frame-wide max would smear
    // a single hit across four frames).
    let sumSq = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const v = frame[i] as number;
      sumSq += v * v;
    }
    tracks.rms[f] = Math.sqrt(sumSq / FFT_SIZE);
    // Frames are timestamped by their start, so peak reads the FIRST hop
    // segment — the samples that actually belong to this frame's timestamp.
    let hopPeak = 0;
    for (let i = 0; i < HOP_SIZE; i++) {
      const v = Math.abs(frame[i] as number);
      if (v > hopPeak) hopPeak = v;
    }
    tracks.peak[f] = hopPeak;

    const mags = magnitudeSpectrum(frame);

    // Spectral centroid on a log-frequency brightness scale (absolute
    // mapping, not percentile — see CENTROID_LO_HZ/HI_HZ). Near-silent
    // frames hold the previous value instead of snapping to 0, which reads
    // as "brightness persists through the gap" rather than a glitch.
    {
      let weighted = 0;
      let total = 0;
      for (let i = 1; i < mags.length; i++) {
        const m = mags[i] as number;
        weighted += m * i * binHz;
        total += m;
      }
      if (total > 1e-6) {
        const hz = weighted / total;
        const norm =
          Math.log2(Math.max(hz, CENTROID_LO_HZ) / CENTROID_LO_HZ) /
          Math.log2(CENTROID_HI_HZ / CENTROID_LO_HZ);
        tracks.centroid[f] = Math.min(Math.max(norm, 0), 1);
      } else {
        tracks.centroid[f] = f > 0 ? (tracks.centroid[f - 1] as number) : 0;
      }
    }

    const sumBins = (lo: number, hi: number): number => {
      let sum = 0;
      for (let i = lo; i <= hi; i++) sum += mags[i] as number;
      return sum / (hi - lo + 1);
    };
    tracks.bass[f] = sumBins(bassLo, bassHi);
    tracks.mids[f] = sumBins(midsLo, midsHi);
    tracks.highs[f] = sumBins(highsLo, highsHi);
    tracks.master[f] = sumBins(1, FFT_SIZE / 2 - 1);

    // Spectral flux (positive changes only). `transients` keeps the original
    // linear flux for v0.1 compatibility; `flux` is the same measure exposed
    // under its proper name; `onset` gets a log-compressed variant below,
    // which is far more level-independent (a quiet intro hit and a loud drop
    // hit land in comparable range).
    if (prevMags) {
      let linearFlux = 0;
      let logFlux = 0;
      for (let i = 1; i < mags.length; i++) {
        const diff = (mags[i] as number) - (prevMags[i] as number);
        if (diff > 0) {
          linearFlux += diff;
          logFlux += Math.log1p((mags[i] as number) * 10) - Math.log1p((prevMags[i] as number) * 10);
        }
      }
      tracks.transients[f] = linearFlux;
      tracks.flux[f] = linearFlux;
      tracks.onset[f] = logFlux;
    }
    prevMags = Float32Array.from(mags);
  }

  // Onset strength: subtract an adaptive local mean and half-wave rectify,
  // so sustained texture cancels out and only *changes* survive. This is the
  // envelope the tempo detector consumes.
  {
    const win = Math.max(Math.round(ONSET_MEAN_WINDOW_SEC / (HOP_SIZE / sampleRate)), 1);
    const raw = Float32Array.from(tracks.onset);
    for (let f = 0; f < frameCount; f++) {
      const lo = Math.max(f - win, 0);
      const hi = Math.min(f + win, frameCount - 1);
      let mean = 0;
      for (let i = lo; i <= hi; i++) mean += raw[i] as number;
      mean /= hi - lo + 1;
      tracks.onset[f] = Math.max((raw[f] as number) - mean, 0);
    }
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
  scaleTrack(tracks.peak, percentileRef(tracks.peak));
  scaleTrack(tracks.flux, percentileRef(tracks.flux));
  scaleTrack(tracks.onset, percentileRef(tracks.onset));
  scaleTrack(tracks.transients, percentileRef(tracks.transients));
  // Centroid is deliberately NOT percentile-normalized: its absolute
  // log-frequency mapping (CENTROID_LO_HZ..HI_HZ) is the meaning.

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

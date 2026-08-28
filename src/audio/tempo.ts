import type { AudioAnalysis } from './analysis';

/**
 * Offline BPM + beat-grid detection. Pure functions of the analysis arrays —
 * two runs over the same audio produce identical results, so detected tempo
 * is as deterministic as everything else in the export path.
 *
 * Method: autocorrelation of the onset-strength envelope across the 60–200
 * BPM lag range, a gentle log-normal prior centred near 120 BPM to arbitrate
 * octave (half/double-time) ambiguity, parabolic interpolation for sub-lag
 * precision, then a comb search for the beat phase that maximizes onset
 * energy on the grid.
 *
 * Detection is ADVISORY: it fills the same `timeline.bpm` / `beatOffsetSec`
 * fields the user can type over, and never runs without being asked.
 */

export interface TempoEstimate {
  bpm: number;
  /** 0..1 — autocorrelation peak strength relative to the range. */
  confidence: number;
  beatOffsetSec: number;
  /** Grid beat times across the analysed duration. */
  beatPositions: Float32Array;
  /**
   * Octave ambiguity: alternative tempo whose autocorrelation is nearly as
   * strong (half or double time), or null when the winner is clear.
   */
  alternativeBpm: number | null;
}

export const TEMPO_MIN_BPM = 60;
export const TEMPO_MAX_BPM = 200;
/** Prior centre — favours the danceable octave when halves/doubles tie. */
const PRIOR_CENTER_BPM = 120;
const PRIOR_WIDTH_OCTAVES = 1.1;
/** Alternative is reported when its score is within this factor of the best. */
const AMBIGUITY_RATIO = 0.85;

function autocorrAt(env: Float32Array, lag: number): number {
  let sum = 0;
  const n = env.length - lag;
  if (n <= 0) return 0;
  for (let i = 0; i < n; i++) {
    sum += (env[i] as number) * (env[i + lag] as number);
  }
  return sum / n;
}

function tempoPrior(bpm: number): number {
  const octaves = Math.log2(bpm / PRIOR_CENTER_BPM);
  return Math.exp(-(octaves * octaves) / (2 * PRIOR_WIDTH_OCTAVES * PRIOR_WIDTH_OCTAVES));
}

/** Beat phase: offset (in frames, sub-frame precise) maximizing comb energy. */
function bestPhase(env: Float32Array, periodFrames: number): number {
  const steps = Math.max(Math.round(periodFrames), 1);
  let bestOffset = 0;
  let bestScore = -1;
  for (let offset = 0; offset < steps; offset++) {
    let score = 0;
    for (let t = offset; t < env.length; t += periodFrames) {
      // Round can land exactly on env.length for t in [len-0.5, len);
      // an unclamped read returns undefined and NaN-poisons the whole comb.
      const idx = Math.min(Math.round(t), env.length - 1);
      score += env[idx] as number;
    }
    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }
  return bestOffset;
}

export function detectTempo(analysis: AudioAnalysis): TempoEstimate | null {
  const env = analysis.tracks.onset;
  if (!env || env.length < 64) return null;
  const hop = analysis.hopSec;

  // Ceil/floor so every lag in range maps to a BPM inside the declared range.
  const minLag = Math.max(Math.ceil(60 / TEMPO_MAX_BPM / hop), 2);
  const maxLag = Math.min(Math.floor(60 / TEMPO_MIN_BPM / hop), Math.floor(env.length / 2));
  if (maxLag <= minLag + 2) return null;

  // Degenerate envelope (silence, or a beatless drone whose onsets are flat):
  // detection has nothing to lock to — return null rather than a fabricated
  // tempo at zero confidence.
  let envEnergy = 0;
  for (let i = 0; i < env.length; i++) envEnergy += env[i] as number;
  if (envEnergy < 1e-6) return null;

  // Autocorrelation over the whole lag range (raw, for stats + interpolation).
  const raw = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    raw[lag] = autocorrAt(env, lag);
  }

  // Range statistics for confidence.
  let mean = 0;
  let count = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    mean += raw[lag] as number;
    count++;
  }
  mean /= Math.max(count, 1);
  let variance = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const d = (raw[lag] as number) - mean;
    variance += d * d;
  }
  const std = Math.sqrt(variance / Math.max(count, 1));

  // Prior-weighted peak pick.
  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * hop);
    const score = (raw[lag] as number) * tempoPrior(bpm);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  // Parabolic interpolation around the raw peak for sub-lag precision.
  // The correction is clamped to ±0.5 lag: outside that the three points do
  // not describe a local maximum and the fit would extrapolate nonsense.
  let refinedLag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const y0 = raw[bestLag - 1] as number;
    const y1 = raw[bestLag] as number;
    const y2 = raw[bestLag + 1] as number;
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-12) {
      const delta = Math.min(Math.max((0.5 * (y0 - y2)) / denom, -0.5), 0.5);
      refinedLag = bestLag + delta;
    }
  }
  const bpm = 60 / (refinedLag * hop);

  // Octave ambiguity: does half time (lag×2) or double time (lag÷2) score
  // almost as well? Search a small window around each candidate lag — the
  // integer division can land a lag or two off the actual harmonic peak.
  let alternativeBpm: number | null = null;
  for (const altCenter of [Math.round(bestLag / 2), Math.round(bestLag * 2)]) {
    let altBestScore = -Infinity;
    let altBestLag = -1;
    for (let lag = altCenter - 2; lag <= altCenter + 2; lag++) {
      if (lag < minLag || lag > maxLag) continue;
      const score = (raw[lag] as number) * tempoPrior(60 / (lag * hop));
      if (score > altBestScore) {
        altBestScore = score;
        altBestLag = lag;
      }
    }
    if (altBestLag > 0 && altBestScore > bestScore * AMBIGUITY_RATIO) {
      alternativeBpm = Number((60 / (altBestLag * hop)).toFixed(2));
    }
  }

  // Confidence: z-score of the winning raw autocorrelation, squashed to 0..1.
  const z = std > 1e-9 ? ((raw[bestLag] as number) - mean) / std : 0;
  const confidence = Math.min(Math.max(z / 6, 0), 1);

  // Phase alignment + grid beat positions.
  const periodFrames = refinedLag;
  const phaseFrames = bestPhase(env, periodFrames);
  const beatOffsetSec = phaseFrames * hop;
  const periodSec = 60 / bpm;
  const beatCount = Math.max(Math.floor((analysis.durationSec - beatOffsetSec) / periodSec) + 1, 0);
  const beatPositions = new Float32Array(beatCount);
  for (let k = 0; k < beatCount; k++) {
    beatPositions[k] = beatOffsetSec + k * periodSec;
  }

  return {
    bpm: Number(bpm.toFixed(2)),
    confidence: Number(confidence.toFixed(3)),
    beatOffsetSec: Number(beatOffsetSec.toFixed(4)),
    beatPositions,
    alternativeBpm,
  };
}

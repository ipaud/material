/**
 * v0.4A A5 — RAW → performatively useful 0..1, per source.
 *
 * The problem this solves is the one CE1H measured on audio: a signal can be
 * numerically correct and still be a dead knob. Raw luminance on a dark clip
 * lives in 0.08–0.25; mapped straight through, the control barely moves.
 *
 * An asymmetric two-sided envelope, three numbers of state:
 *   expand fast toward a new extreme, contract slowly back.
 *
 * Fast expansion admits a real change immediately. Slow contraction is what
 * stops one white frame from compressing the range for the next half minute —
 * and because the asymmetry is in EXPANSION, it costs nothing in tracking
 * speed for sustained changes.
 *
 * Finite memory, and the proof matters: sample k's influence at step m is
 * bounded by (1-α_min)^(m-k) where α_min comes from tauContract, the SLOWEST
 * rate the recursion can ever take. The state-dependent switching only ever
 * makes forgetting faster, so the geometric bound holds uniformly over every
 * input sequence — which is the step that normally fails for adaptive filters.
 * That is what lets a bounded export preroll reconstruct the state.
 */

export interface CalibratorState {
  lo: number;
  hi: number;
  elapsedSec: number;
  seeded: boolean;
}

export interface CalibratorParams {
  /** Time constant toward a NEW extreme. */
  tauExpandSec: number;
  /** Time constant giving range back. Must exceed tauExpandSec. */
  tauContractSec: number;
  /** Half-span floor: stops a static source's noise becoming full scale. */
  minHalfSpan: number;
  /** Below this the signal reports `warming` and publishes nothing. */
  warmupSec: number;
}

export const LUMINANCE_CALIBRATION: CalibratorParams = {
  tauExpandSec: 1.5,
  tauContractSec: 4,
  minHalfSpan: 0.05,
  warmupSec: 0.75,
};

/** Motion amount is in analysis texels/frame, so its floor is in those units. */
export const MOTION_AMOUNT_CALIBRATION: CalibratorParams = {
  tauExpandSec: 1.5,
  tauContractSec: 4,
  minHalfSpan: 0.15,
  warmupSec: 0.75,
};

/**
 * Contrast is a standard deviation, so its useful band is narrow: measured
 * 0.10-0.28 across generators, video and camera. The floor is half the
 * luminance floor because the quantity itself is roughly half the scale.
 */
export const CONTRAST_CALIBRATION: CalibratorParams = {
  tauExpandSec: 1.5,
  tauContractSec: 4,
  minHalfSpan: 0.025,
  warmupSec: 0.75,
};

/**
 * Edge energy is luma per analysis texel and lives near zero for soft
 * material — a blurred frame reads an order of magnitude below a graphic one.
 * A small floor is what stops a soft source from being amplified into
 * shimmer; it is deliberately tighter than contrast's.
 */
export const EDGE_CALIBRATION: CalibratorParams = {
  tauExpandSec: 1.5,
  tauContractSec: 4,
  minHalfSpan: 0.01,
  warmupSec: 0.75,
};

/**
 * Preroll needed for a subrange export to agree with a full one.
 * |Δstate| <= exp(-T/tauContract) * range. At tauContract = 4s, 24s is six
 * time constants: state error <= 0.0025, and the calibrated output differs by
 * at most 0.025 in the worst case — a source pinned at the span floor, where
 * dy/dc = 1/(2h) is largest. With real range the error is proportionally
 * smaller.
 */
export const CALIBRATION_PREROLL_SEC = 24;

export function newCalibratorState(): CalibratorState {
  return { lo: 0, hi: 0, elapsedSec: 0, seeded: false };
}

export function calibratorStep(
  state: CalibratorState,
  raw: number,
  dtSec: number,
  p: CalibratorParams,
): CalibratorState {
  if (!Number.isFinite(raw)) return state;
  if (!state.seeded) {
    return { lo: raw, hi: raw, elapsedSec: 0, seeded: true };
  }
  const dt = Math.max(dtSec, 0);
  const aExpand = 1 - Math.exp(-dt / Math.max(p.tauExpandSec, 1e-4));
  const aContract = 1 - Math.exp(-dt / Math.max(p.tauContractSec, 1e-4));
  // Above both envelopes hi closes its gap at the larger rate; between them
  // both converge on x and cannot cross, since a < 1. So lo <= hi is invariant.
  const hi = state.hi + (raw - state.hi) * (raw > state.hi ? aExpand : aContract);
  const lo = state.lo + (raw - state.lo) * (raw < state.lo ? aExpand : aContract);
  return { lo, hi, elapsedSec: state.elapsedSec + dt, seeded: true };
}

/** Calibrated 0..1, or null while warming — null means the key is omitted. */
export function calibratorValue(
  state: CalibratorState,
  raw: number,
  p: CalibratorParams,
): number | null {
  if (!state.seeded || state.elapsedSec < p.warmupSec) return null;
  const centre = 0.5 * (state.lo + state.hi);
  const halfSpan = Math.max(0.5 * (state.hi - state.lo), p.minHalfSpan);
  const y = (raw - centre) / (2 * halfSpan) + 0.5;
  return Math.min(Math.max(y, 0), 1);
}

/** For the scope: the range the calibrator is currently working over. */
export function calibratorRange(
  state: CalibratorState,
  p: CalibratorParams,
): { lo: number; hi: number; halfSpan: number } {
  const halfSpan = Math.max(0.5 * (state.hi - state.lo), p.minHalfSpan);
  return { lo: state.lo, hi: state.hi, halfSpan };
}

import {
  CONTRAST_CALIBRATION,
  EDGE_CALIBRATION,
  LUMINANCE_CALIBRATION,
  MOTION_AMOUNT_CALIBRATION,
  type CalibratorParams,
  type CalibratorState,
  calibratorRange,
  calibratorStep,
  calibratorValue,
  newCalibratorState,
} from './calibration';
import type { RawVisualStats, VisualSignalId } from './types';

/**
 * v0.4A A5 — calibration state, scoped to (pixel origin, signal).
 *
 * Runtime only. Nothing here is serialised: it is derived session state, and
 * persisting moving statistics would make an export irreproducible from a
 * fresh open and would need a schema migration to carry.
 *
 * Bounded by the project's source count, cleared when the document is
 * replaced. Note `modulationRuntime.reset()` exists but is never called from
 * anywhere, so smoothing already leaks across project switches — this store
 * does not copy that.
 */

/**
 * Calibration is CHOSEN per signal, not applied by default. Three kinds of
 * signal opt out, for three different reasons — see VisualSignalDef.calibrated.
 */
const PARAMS: Partial<Record<VisualSignalId, CalibratorParams>> = {
  'image.luminance': LUMINANCE_CALIBRATION,
  'image.contrast': CONTRAST_CALIBRATION,
  'image.edgeEnergy': EDGE_CALIBRATION,
  'motion.amount': MOTION_AMOUNT_CALIBRATION,
  // motion.x/y are intrinsically normalised; motion.activity is already a
  // physical fraction of the frame; the centroids are positions.
};

export class CalibrationStore {
  private states = new Map<string, CalibratorState>();
  /**
   * v0.4C — LOCK freezes the envelopes where they are. RAW keeps moving and
   * CALIBRATED keeps responding; what stops is the range adapting underneath
   * the performer. Useful once a scene is lit and the ranges are right: an
   * envelope that keeps learning will keep drifting.
   *
   * Runtime only, and deliberately not persisted. Storing a moving statistic
   * in the project would make an export irreproducible from a fresh open, so
   * loading a project always starts adapting again.
   */
  locked = false;

  private key(origin: string, id: VisualSignalId): string {
    return `${origin}|${id}`;
  }

  params(id: VisualSignalId): CalibratorParams | null {
    return PARAMS[id] ?? null;
  }

  /** Advance every calibrated signal for one analysed frame. */
  advance(origin: string | null, stats: RawVisualStats | null, dtSec: number): void {
    if (!origin || !stats || this.locked) return;
    this.step(origin, 'image.luminance', stats.luminance, dtSec);
    this.step(origin, 'image.contrast', stats.contrast, dtSec);
    this.step(origin, 'image.edgeEnergy', stats.edgeEnergy, dtSec);
    if (stats.hasFlow) this.step(origin, 'motion.amount', stats.motionAmount, dtSec);
  }

  private step(origin: string, id: VisualSignalId, raw: number, dtSec: number): void {
    const p = PARAMS[id];
    if (!p) return;
    const k = this.key(origin, id);
    const prev = this.states.get(k) ?? newCalibratorState();
    this.states.set(k, calibratorStep(prev, raw, dtSec, p));
  }

  /** Calibrated value, or null while warming (the key is then omitted). */
  value(origin: string | null, id: VisualSignalId, raw: number): number | null {
    const p = PARAMS[id];
    if (!p) return raw; // uncalibrated signals pass straight through
    if (!origin) return null;
    const state = this.states.get(this.key(origin, id));
    return state ? calibratorValue(state, raw, p) : null;
  }

  /** For the scope panel. */
  inspect(
    origin: string | null,
    id: VisualSignalId,
  ): { lo: number; hi: number; halfSpan: number; warming: boolean } | null {
    const p = PARAMS[id];
    if (!p || !origin) return null;
    const state = this.states.get(this.key(origin, id));
    if (!state) return null;
    return { ...calibratorRange(state, p), warming: state.elapsedSec < p.warmupSec };
  }

  get size(): number {
    return this.states.size;
  }

  /** Forget one pixel origin's ranges so they rebuild from what is on screen
   * now — the escape hatch when a scene changed more than the envelope's time
   * constants can follow. */
  resetOrigin(origin: string | null): void {
    if (!origin) return;
    for (const key of [...this.states.keys()]) {
      if (key.startsWith(`${origin}|`)) this.states.delete(key);
    }
  }

  /** Document replaced — drop everything, including the lock. */
  reset(): void {
    this.states.clear();
    this.locked = false;
  }
}

export const calibrationStore = new CalibrationStore();

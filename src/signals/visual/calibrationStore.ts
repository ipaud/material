import {
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

const PARAMS: Partial<Record<VisualSignalId, CalibratorParams>> = {
  'image.luminance': LUMINANCE_CALIBRATION,
  'motion.amount': MOTION_AMOUNT_CALIBRATION,
  // motion.x is intrinsically normalised — never calibrated.
};

export class CalibrationStore {
  private states = new Map<string, CalibratorState>();

  private key(origin: string, id: VisualSignalId): string {
    return `${origin}|${id}`;
  }

  params(id: VisualSignalId): CalibratorParams | null {
    return PARAMS[id] ?? null;
  }

  /** Advance every calibrated signal for one analysed frame. */
  advance(origin: string | null, stats: RawVisualStats | null, dtSec: number): void {
    if (!origin || !stats) return;
    this.step(origin, 'image.luminance', stats.luminance, dtSec);
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

  /** Document replaced — drop everything. */
  reset(): void {
    this.states.clear();
  }
}

export const calibrationStore = new CalibrationStore();

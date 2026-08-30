import type { RawVisualStats, VisualSignalId } from './types';

/**
 * v0.4A — RAW stats → the flat record `evalSources` merges.
 *
 * Only demanded signals are published, and a signal with nothing behind it is
 * OMITTED rather than published as 0. Absence is the evaluator's true neutral
 * (evaluator.ts:120): the mapping is skipped entirely, so `invert`, `curve` and
 * `min` cannot manufacture a contribution out of a source that is not there.
 * Publishing 0 for "no flow" would silently drive every motion mapping to its
 * `min` instead.
 */
export function publishVisualSignals(
  stats: RawVisualStats | null,
  demand: ReadonlySet<VisualSignalId>,
  calibrate: (id: VisualSignalId, raw: number) => number | null,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!stats) return out;

  if (demand.has('image.luminance')) {
    const v = calibrate('image.luminance', stats.luminance);
    if (v !== null) out['image.luminance'] = v;
  }
  // Motion needs a flow field. Without one the signals do not exist — they are
  // not "zero motion". A saturated field IS published (a fast source should peg
  // the knob); what saturation withholds is the right to teach the calibrator,
  // which CalibrationStore.advance enforces.
  if (stats.hasFlow) {
    if (demand.has('motion.amount')) {
      const v = calibrate('motion.amount', stats.motionAmount);
      if (v !== null) out['motion.amount'] = v;
    }
    if (demand.has('motion.x')) {
      // Intrinsically normalised — passes through uncalibrated by design.
      out['motion.x'] = clamp01(stats.motionX);
    }
  }
  return out;
}

const clamp01 = (v: number): number => Math.min(Math.max(v, 0), 1);

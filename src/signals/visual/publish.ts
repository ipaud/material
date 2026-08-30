import { type RawVisualStats, type VisualSignalId, visualSignalDef } from './types';

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

  const put = (id: VisualSignalId, raw: number): void => {
    if (!demand.has(id)) return;
    const v = visualSignalDef(id)?.calibrated ? calibrate(id, raw) : clamp01(raw);
    if (v !== null) out[id] = v;
  };

  put('image.luminance', stats.luminance);
  put('image.contrast', stats.contrast);
  put('image.edgeEnergy', stats.edgeEnergy);

  // Motion needs a flow field. Without one the signals do not exist — they are
  // not "zero motion". A saturated field IS published (a fast source should peg
  // the knob); saturation is diagnostic, not a reason to withhold.
  if (stats.hasFlow) {
    put('motion.amount', stats.motionAmount);
    put('motion.activity', stats.motionActivity);
    put('motion.x', stats.motionX);
    put('motion.y', stats.motionY);
    // Position signals pass through uncalibrated by definition: rescaling a
    // coordinate to "usable travel" would put the effect where the motion is
    // not. When no motion is measurable the reducer holds the last valid
    // position, so a gesture that stops leaves the effect where it ended
    // rather than snapping to centre.
    put('motion.centroidX', stats.centroidX);
    put('motion.centroidY', stats.centroidY);
  }
  return out;
}

const clamp01 = (v: number): number => Math.min(Math.max(v, 0), 1);

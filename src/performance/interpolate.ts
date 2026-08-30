import type {
  LookCore,
  ModulationMapping,
  MorphCurve,
  ParamValue,
  TriggerMapping,
} from '@shared/schemas/project';

/**
 * Deterministic look interpolation.
 *
 * Rules (documented, tested):
 * - Numbers lerp. Booleans/enums/strings switch at the midpoint (p ≥ 0.5).
 * - Different techniques: the whole technique block (id + params) switches at
 *   the midpoint — no shader crossfade in this phase.
 * - Materials: numeric params lerp; identity (materialId/colorMode/assetPath)
 *   switches at the midpoint.
 * - Modulations matched by id: amount/min/max/smoothing lerp; topology
 *   (source/target) and enums switch at midpoint. Frozen values: both frozen
 *   → lerp; mixed → the winning side's state applies from the midpoint.
 * - UNMATCHED modulations fade: A-only mappings ride amount×(1−p) to zero,
 *   B-only rise from zero with amount×p — smooth entry/exit, and topology is
 *   never blended.
 * - Triggers matched by id: envelope numerics lerp, everything else switches
 *   at midpoint. Unmatched triggers SWITCH at midpoint (A-only active while
 *   p < 0.5, B-only from p ≥ 0.5) — envelopes must not half-fire, and the
 *   exclusive boundary prevents duplicate firings.
 * - Seed switches at midpoint.
 */

export function morphCurve(p: number, curve: MorphCurve): number {
  const x = Math.min(Math.max(p, 0), 1);
  switch (curve) {
    case 'easeIn':
      return x * x;
    case 'easeOut':
      return 1 - (1 - x) * (1 - x);
    case 'easeInOut':
      return x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
    case 'exponential':
      return x === 0 ? 0 : Math.pow(2, 10 * (x - 1));
    case 'linear':
    default:
      return x;
  }
}

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

function lerpValue(a: ParamValue | undefined, b: ParamValue | undefined, p: number): ParamValue {
  if (typeof a === 'number' && typeof b === 'number') return lerp(a, b, p);
  // Boolean / string / one-sided: midpoint switch.
  const chosen = p < 0.5 ? a : b;
  const fallback = p < 0.5 ? b : a;
  return (chosen ?? fallback ?? 0) as ParamValue;
}

export interface MorphStats {
  interpolated: number;
  switched: number;
}

function interpolateParams(
  a: Record<string, ParamValue>,
  b: Record<string, ParamValue>,
  p: number,
  stats: MorphStats,
): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const av = a[key];
    const bv = b[key];
    if (typeof av === 'number' && typeof bv === 'number') {
      out[key] = lerp(av, bv, p);
      stats.interpolated++;
    } else if (av === undefined || bv === undefined) {
      // One-sided key: absent means "technique default" on that side, so the
      // key itself switches at the midpoint — endpoints stay byte-exact.
      const chosen = p < 0.5 ? av : bv;
      if (chosen !== undefined) out[key] = chosen;
      stats.switched++;
    } else {
      out[key] = lerpValue(av, bv, p);
      if (av !== bv) stats.switched++;
    }
  }
  return out;
}

function interpolateModulations(
  a: ModulationMapping[],
  b: ModulationMapping[],
  p: number,
  stats: MorphStats,
): ModulationMapping[] {
  const out: ModulationMapping[] = [];
  const bById = new Map(b.map((m) => [m.id, m]));
  const seen = new Set<string>();

  for (const ma of a) {
    const mb = bById.get(ma.id);
    if (mb) {
      seen.add(ma.id);
      const topology = p < 0.5 ? ma : mb;
      let frozenValue: number | null;
      if (ma.frozenValue !== null && mb.frozenValue !== null) {
        frozenValue = lerp(ma.frozenValue, mb.frozenValue, p);
      } else {
        frozenValue = p < 0.5 ? ma.frozenValue : mb.frozenValue;
      }
      out.push({
        ...topology,
        amount: lerp(ma.amount, mb.amount, p),
        min: lerp(ma.min, mb.min, p),
        max: lerp(ma.max, mb.max, p),
        smoothing: lerp(ma.smoothing, mb.smoothing, p),
        frozenValue,
      });
      stats.interpolated++;
    } else {
      // A-only: fade amount to zero across the morph.
      out.push({ ...ma, amount: ma.amount * (1 - p) });
      stats.switched++;
    }
  }
  for (const mb of b) {
    if (seen.has(mb.id)) continue;
    // B-only: rise from zero.
    out.push({ ...mb, amount: mb.amount * p });
    stats.switched++;
  }
  return out;
}

function interpolateTriggers(
  a: TriggerMapping[],
  b: TriggerMapping[],
  p: number,
  stats: MorphStats,
): TriggerMapping[] {
  const out: TriggerMapping[] = [];
  const bById = new Map(b.map((t) => [t.id, t]));
  const seen = new Set<string>();

  for (const ta of a) {
    const tb = bById.get(ta.id);
    if (tb) {
      seen.add(ta.id);
      const topology = p < 0.5 ? ta : tb;
      out.push({
        ...topology,
        amount: lerp(ta.amount, tb.amount, p),
        attackSec: lerp(ta.attackSec, tb.attackSec, p),
        holdSec: lerp(ta.holdSec, tb.holdSec, p),
        decaySec: lerp(ta.decaySec, tb.decaySec, p),
        cooldownSec: lerp(ta.cooldownSec, tb.cooldownSec, p),
      });
      stats.interpolated++;
    } else if (p < 0.5) {
      // A-only: active until the midpoint, then gone.
      out.push(ta);
      stats.switched++;
    } else {
      stats.switched++;
    }
  }
  for (const tb of b) {
    if (seen.has(tb.id)) continue;
    if (p >= 0.5) out.push(tb);
    stats.switched++;
  }
  return out;
}

export function interpolateLookCore(
  a: LookCore,
  b: LookCore,
  progress: number,
  /** Where a cross-technique morph commits to B. CE1G moves this earlier
   * when a pixel transition covers the switch (see transitionWindow.ts). */
  switchAt = 0.5,
): { core: LookCore; stats: MorphStats } {
  const p = Math.min(Math.max(progress, 0), 1);
  const stats: MorphStats = { interpolated: 0, switched: 0 };

  const sameTechnique = a.techniqueId === b.techniqueId;
  const techniqueId = sameTechnique ? a.techniqueId : p < switchAt ? a.techniqueId : b.techniqueId;
  const params = sameTechnique
    ? interpolateParams(a.params, b.params, p, stats)
    : p < switchAt
      ? { ...a.params }
      : { ...b.params };
  if (!sameTechnique) stats.switched++;

  const sameMaterialIdentity =
    a.material.materialId === b.material.materialId &&
    a.material.assetPath === b.material.assetPath;
  const materialIdentity = p < 0.5 ? a.material : b.material;
  const material = {
    ...materialIdentity,
    params: interpolateParams(a.material.params, b.material.params, p, stats),
  };
  if (!sameMaterialIdentity) stats.switched++;

  return {
    core: {
      techniqueId,
      params,
      material,
      modulations: interpolateModulations(a.modulations, b.modulations, p, stats),
      triggers: interpolateTriggers(a.triggers, b.triggers, p, stats),
      seed: p < switchAt ? a.seed : b.seed,
    },
    stats,
  };
}

import type { ModulationMapping, ParamRecord } from '@shared/schemas/project';
import type { NumberParamDef, TechniqueDefinition } from '@/techniques/types';
import { allParams } from '@/techniques/types';

export function applyCurve(v: number, curve: ModulationMapping['curve']): number {
  const clamped = Math.min(Math.max(v, 0), 1);
  if (curve === 'exponential') return clamped * clamped;
  if (curve === 'logarithmic') return Math.sqrt(clamped);
  return clamped;
}

/**
 * Per-mapping smoothing state (exponential moving average).
 * Deterministic when stepped with a fixed dt sequence (export path).
 */
export class SmoothingState {
  private values = new Map<string, number>();

  step(mappingId: string, target: number, smoothing: number, dtSec: number): number {
    if (smoothing <= 0) {
      this.values.set(mappingId, target);
      return target;
    }
    // smoothing 0..1 → time constant up to ~0.8s.
    const tau = smoothing * 0.8;
    const alpha = 1 - Math.exp(-dtSec / Math.max(tau, 1e-4));
    const prev = this.values.get(mappingId) ?? target;
    const next = prev + (target - prev) * alpha;
    this.values.set(mappingId, next);
    return next;
  }

  /** Current smoothed value (for FREEZE capture). */
  peek(mappingId: string): number | undefined {
    return this.values.get(mappingId);
  }

  reset(): void {
    this.values.clear();
  }
}

/** Shaped 0..1 output of one mapping (before scaling into the target range). */
/**
 * The mapping's shaped value in 0..1, BEFORE its output range is applied.
 *
 * This is the quantity FREEZE stores, in preview and in export alike. They
 * used to store different ones: preview captured this pre-range value while
 * export captured the post-range one, and the frozen branch then skipped the
 * range entirely — so freezing a mapping with min 0.2 / max 0.8 jumped its
 * contribution to the full 0..1 span, and the two paths disagreed about what
 * the stored number even meant.
 */
export function shapedUnitValue(
  mapping: ModulationMapping,
  sourceValues: Record<string, number>,
  smoothingState: SmoothingState,
  dtSec: number,
): number {
  if (mapping.frozenValue !== null) return Math.min(Math.max(mapping.frozenValue, 0), 1);
  let v = sourceValues[mapping.source] ?? 0;
  if (mapping.invert) v = 1 - v;
  v = applyCurve(v, mapping.curve);
  return smoothingState.step(mapping.id, v, mapping.smoothing, dtSec);
}

export function shapeMappingValue(
  mapping: ModulationMapping,
  sourceValues: Record<string, number>,
  smoothingState: SmoothingState,
  dtSec: number,
): number {
  const v = shapedUnitValue(mapping, sourceValues, smoothingState, dtSec);
  return mapping.min + (mapping.max - mapping.min) * v;
}

/**
 * Apply enabled mappings additively on top of base params:
 * final = clamp(base + amount * shaped * paramSpan).
 * Targets are leaf parameters — no mapping outputs feed another mapping, so
 * cycles are impossible by construction.
 */
/**
 * CE1F — the same modulation math applied to SOURCE (generator) params.
 * Targets are namespaced `source.<paramId>` so a generator's `scale` can
 * never collide with a technique's `scale`. Authority stays in the editor:
 * the Output receives the resolved values, it never evaluates mappings.
 */
export function applySourceModulations(
  base: ParamRecord,
  mappings: readonly ModulationMapping[],
  sourceValues: Record<string, number>,
  paramDefs: readonly NumberParamDef[],
  smoothingState: SmoothingState,
  dtSec: number,
): ParamRecord {
  const active = mappings.filter((m) => m.enabled && m.target.startsWith('source.'));
  if (active.length === 0) return base;
  const defs = new Map<string, NumberParamDef>();
  for (const d of paramDefs) if (d.modulatable) defs.set(d.id, d);
  const out: Record<string, ParamRecord[string]> = { ...base };
  for (const mapping of active) {
    const def = defs.get(mapping.target.slice('source.'.length));
    if (!def) continue;
    if (mapping.frozenValue === null && sourceValues[mapping.source] === undefined) continue;
    const shaped = shapeMappingValue(mapping, sourceValues, smoothingState, dtSec);
    const span = def.max - def.min;
    const current = typeof out[def.id] === 'number' ? (out[def.id] as number) : def.default;
    out[def.id] = Math.min(Math.max(current + mapping.amount * shaped * span, def.min), def.max);
  }
  return out;
}

export function applyModulations(
  base: ParamRecord,
  mappings: ModulationMapping[],
  sourceValues: Record<string, number>,
  definition: TechniqueDefinition,
  smoothingState: SmoothingState,
  dtSec: number,
): ParamRecord {
  const active = mappings.filter((m) => m.enabled);
  if (active.length === 0) return base;

  const paramDefs = new Map<string, NumberParamDef>();
  for (const def of allParams(definition)) {
    if (def.type === 'number' && def.modulatable) paramDefs.set(def.id, def);
  }

  const out: Record<string, ParamRecord[string]> = { ...base };
  for (const mapping of active) {
    const def = paramDefs.get(mapping.target);
    if (!def) continue;
    // True neutral (P4): a source that emitted NO value this frame (an
    // inactive/degrade-gated pattern, an unknown source id) contributes
    // nothing at all — the mapping is skipped, so invert/curve/min cannot
    // manufacture a contribution from silence. A FROZEN mapping still holds
    // its captured value regardless of the live source.
    if (mapping.frozenValue === null && sourceValues[mapping.source] === undefined) continue;
    const shaped = shapeMappingValue(mapping, sourceValues, smoothingState, dtSec);
    const span = def.max - def.min;
    const current = typeof out[mapping.target] === 'number' ? (out[mapping.target] as number) : def.default;
    out[mapping.target] = Math.min(Math.max(current + mapping.amount * shaped * span, def.min), def.max);
  }
  return out;
}

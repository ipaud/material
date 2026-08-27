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
export function shapeMappingValue(
  mapping: ModulationMapping,
  sourceValues: Record<string, number>,
  smoothingState: SmoothingState,
  dtSec: number,
): number {
  if (mapping.frozenValue !== null) return Math.min(Math.max(mapping.frozenValue, 0), 1);
  let v = sourceValues[mapping.source] ?? 0;
  if (mapping.invert) v = 1 - v;
  v = applyCurve(v, mapping.curve);
  v = smoothingState.step(mapping.id, v, mapping.smoothing, dtSec);
  return mapping.min + (mapping.max - mapping.min) * v;
}

/**
 * Apply enabled mappings additively on top of base params:
 * final = clamp(base + amount * shaped * paramSpan).
 * Targets are leaf parameters — no mapping outputs feed another mapping, so
 * cycles are impossible by construction.
 */
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
    const shaped = shapeMappingValue(mapping, sourceValues, smoothingState, dtSec);
    const span = def.max - def.min;
    const current = typeof out[mapping.target] === 'number' ? (out[mapping.target] as number) : def.default;
    out[mapping.target] = Math.min(Math.max(current + mapping.amount * shaped * span, def.min), def.max);
  }
  return out;
}

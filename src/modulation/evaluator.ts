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
  // Input window first: everything after it works in a clean 0..1, so invert
  // stays exactly `1 - v` and a centred signal's neutral 0.5 keeps mirroring
  // onto itself.
  const inMin = mapping.inMin ?? 0;
  const inMax = mapping.inMax ?? 1;
  if (inMax !== inMin && (inMin !== 0 || inMax !== 1)) {
    v = Math.min(Math.max((v - inMin) / (inMax - inMin), 0), 1);
  }
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
/**
 * v0.4C — how mappings on ONE parameter compose.
 *
 * ```
 * base parameter value
 *   → at most one REPLACE mapping positions it absolutely
 *   → every ADD mapping sums on top
 *   → clamp to the parameter's range
 * ```
 *
 * At most one, deliberately. Two mappings each claiming to *be* the parameter
 * have no meaningful sum, and picking silently by evaluation order would make
 * the result depend on the order rows happen to sit in. The first enabled
 * REPLACE in document order wins and the rest are inert; `replaceConflicts`
 * lets the UI say so out loud rather than leaving a dead row looking live.
 */
export function replaceConflicts(mappings: readonly ModulationMapping[]): Set<string> {
  const claimed = new Set<string>();
  const ignored = new Set<string>();
  for (const m of mappings) {
    if (!m.enabled || m.mode !== 'replace') continue;
    if (claimed.has(m.target)) ignored.add(m.id);
    else claimed.add(m.target);
  }
  return ignored;
}

/** Resolve one parameter through the composition order above. */
function composeTarget(
  baseValue: number,
  def: NumberParamDef,
  forTarget: readonly ModulationMapping[],
  shaped: (m: ModulationMapping) => number,
): number {
  const span = def.max - def.min;
  let value = baseValue;
  const replace = forTarget.find((m) => m.mode === 'replace');
  if (replace) {
    const position = def.min + shaped(replace) * span;
    // `amount` stays meaningful in both modes: here it blends between where
    // the parameter was and where the signal puts it, so the same slider still
    // reads as "how much does this mapping matter".
    const blend = Math.min(Math.max(Math.abs(replace.amount), 0), 1);
    value = value + (position - value) * blend;
  }
  for (const m of forTarget) {
    if (m.mode === 'replace') continue;
    value += m.amount * shaped(m) * span;
  }
  return Math.min(Math.max(value, def.min), def.max);
}

/** Group mappings by target, preserving document order within each group. */
function byTarget(
  mappings: readonly ModulationMapping[],
  key: (m: ModulationMapping) => string,
): Map<string, ModulationMapping[]> {
  const out = new Map<string, ModulationMapping[]>();
  for (const m of mappings) {
    const k = key(m);
    const list = out.get(k);
    if (list) list.push(m);
    else out.set(k, [m]);
  }
  return out;
}

export function applySourceModulations(
  base: ParamRecord,
  mappings: readonly ModulationMapping[],
  sourceValues: Record<string, number>,
  paramDefs: readonly NumberParamDef[],
  smoothingState: SmoothingState,
  dtSec: number,
): ParamRecord {
  const ignored = replaceConflicts(mappings);
  const active = mappings.filter(
    (m) =>
      m.enabled &&
      m.target.startsWith('source.') &&
      !ignored.has(m.id) &&
      // True neutral (P4): a source that emitted NO value this frame
      // contributes nothing at all, so invert/curve/min cannot manufacture one.
      (m.frozenValue !== null || sourceValues[m.source] !== undefined),
  );
  if (active.length === 0) return base;
  const defs = new Map<string, NumberParamDef>();
  for (const d of paramDefs) if (d.modulatable) defs.set(d.id, d);
  const out: Record<string, ParamRecord[string]> = { ...base };
  const shaped = (m: ModulationMapping) =>
    shapeMappingValue(m, sourceValues, smoothingState, dtSec);
  for (const [target, group] of byTarget(active, (m) => m.target)) {
    const def = defs.get(target.slice('source.'.length));
    if (!def) continue;
    const current = typeof out[def.id] === 'number' ? (out[def.id] as number) : def.default;
    out[def.id] = composeTarget(current, def, group, shaped);
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
  const ignored = replaceConflicts(mappings);
  const active = mappings.filter(
    (m) =>
      m.enabled &&
      !ignored.has(m.id) &&
      // True neutral (P4): a source that emitted NO value this frame (an
      // inactive/degrade-gated pattern, an unknown source id) contributes
      // nothing at all — the mapping is skipped, so invert/curve/min cannot
      // manufacture a contribution from silence. A FROZEN mapping still holds
      // its captured value regardless of the live source.
      (m.frozenValue !== null || sourceValues[m.source] !== undefined),
  );
  if (active.length === 0) return base;

  const paramDefs = new Map<string, NumberParamDef>();
  for (const def of allParams(definition)) {
    if (def.type === 'number' && def.modulatable) paramDefs.set(def.id, def);
  }

  const out: Record<string, ParamRecord[string]> = { ...base };
  const shaped = (m: ModulationMapping) =>
    shapeMappingValue(m, sourceValues, smoothingState, dtSec);
  for (const [target, group] of byTarget(active, (m) => m.target)) {
    const def = paramDefs.get(target);
    if (!def) continue;
    const current = typeof out[target] === 'number' ? (out[target] as number) : def.default;
    out[target] = composeTarget(current, def, group, shaped);
  }
  return out;
}

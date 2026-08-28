import type { Macro, MacroMapping, ParamRecord } from '@shared/schemas/project';
import type { NumberParamDef, TechniqueDefinition } from '@/techniques/types';
import { allParams } from '@/techniques/types';
import { applyCurve } from '@/modulation/evaluator';

/**
 * Macro layer (Phase 15): each macro's 0–1 value, shaped per mapping
 * (invert → curve → min/max window), contributes `amount × shaped × span`
 * additively to its target parameters — the same arithmetic as continuous
 * modulation, evaluated one step earlier:
 *
 *   base → MACROS → continuous modulation (freeze) → pulses → clamp
 *
 * Pure and stateless (no smoothing — a macro is a hand, not a signal), so
 * preview and export share it trivially. Macros never mutate stored params
 * or Looks; their values live in project.macros as performance state.
 */

export function shapeMacroValue(mapping: MacroMapping, value: number): number {
  let v = Math.min(Math.max(value, 0), 1);
  if (mapping.invert) v = 1 - v;
  v = applyCurve(v, mapping.curve);
  return mapping.min + (mapping.max - mapping.min) * v;
}

export function applyMacros(
  base: ParamRecord,
  macros: Macro[],
  definition: TechniqueDefinition,
): ParamRecord {
  const active = macros.filter((m) => m.value !== 0 && m.mappings.some((x) => x.enabled));
  if (active.length === 0) return base;

  const paramDefs = new Map<string, NumberParamDef>();
  for (const def of allParams(definition)) {
    if (def.type === 'number' && def.modulatable) paramDefs.set(def.id, def);
  }

  const out: ParamRecord = { ...base };
  for (const macro of active) {
    for (const mapping of macro.mappings) {
      if (!mapping.enabled) continue;
      const def = paramDefs.get(mapping.targetParam);
      if (!def) continue;
      const shaped = shapeMacroValue(mapping, macro.value);
      const span = def.max - def.min;
      const current =
        typeof out[mapping.targetParam] === 'number'
          ? (out[mapping.targetParam] as number)
          : def.default;
      out[mapping.targetParam] = Math.min(
        Math.max(current + mapping.amount * shaped * span, def.min),
        def.max,
      );
    }
  }
  return out;
}

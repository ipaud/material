import type { ParamRecord, TriggerMapping } from '@shared/schemas/project';
import type { NumberParamDef, TechniqueDefinition } from '@/techniques/types';
import { allParams } from '@/techniques/types';
import { envelopeDuration, envelopeValue } from './envelope';
import {
  applyCooldown,
  eventTimesInWindow,
  isDeterministicSource,
  type TriggerContext,
} from './triggerSources';

/**
 * Pulse evaluation is a PURE FUNCTION of composition time.
 *
 * For every trigger event T of the mapping's source with T ≤ t and
 * t − T inside the envelope, the envelope contributes
 * `amount × envelope(t − T)`. Overlapping pulses ACCUMULATE ADDITIVELY and
 * the final parameter is clamped to its definition range — documented choice:
 * additive stacking reads as energy building on fast hits, and the clamp
 * keeps it safe. (Max-combining was considered and rejected: it flattens
 * rolls into a plateau.)
 *
 * Because no state machine is involved, seeks, loops and export replay are
 * correct by construction: the value at time t never depends on how playback
 * arrived at t.
 */

/** Bounded lookback: envelope window plus a few cooldown chains. */
function lookbackSec(mapping: TriggerMapping): number {
  const window = envelopeDuration(mapping);
  return window + Math.min(mapping.cooldownSec * 8, 8);
}

/** Sum of this mapping's active envelope contributions at time t (signed). */
export function pulseContribution(
  mapping: TriggerMapping,
  t: number,
  ctx: TriggerContext,
): number {
  if (!mapping.enabled || mapping.action !== 'pulse') return 0;
  if (!isDeterministicSource(mapping.source)) return 0; // live pulses go through the scheduler
  const window = envelopeDuration(mapping);
  if (window <= 0 || mapping.amount === 0) return 0;
  const events = applyCooldown(
    eventTimesInWindow(mapping.source, t, lookbackSec(mapping), ctx),
    mapping.cooldownSec,
  );
  let sum = 0;
  for (const eventTime of events) {
    const local = t - eventTime;
    if (local < 0 || local > window) continue;
    sum += envelopeValue(local, mapping) * mapping.amount;
  }
  return sum;
}

/**
 * Apply all pulse mappings on top of already-modulated params:
 * final = clamp(current + Σ pulses × paramSpan).
 * Same additive-into-range semantics as continuous modulation.
 */
export function applyPulses(
  params: ParamRecord,
  triggers: TriggerMapping[],
  t: number,
  ctx: TriggerContext,
  definition: TechniqueDefinition,
  extraContribution?: Map<string, number>,
): ParamRecord {
  const pulses = triggers.filter((m) => m.enabled && m.action === 'pulse' && m.targetParam);
  if (pulses.length === 0 && (!extraContribution || extraContribution.size === 0)) return params;

  const paramDefs = new Map<string, NumberParamDef>();
  for (const def of allParams(definition)) {
    if (def.type === 'number' && def.modulatable) paramDefs.set(def.id, def);
  }

  const contributions = new Map<string, number>();
  for (const mapping of pulses) {
    const target = mapping.targetParam;
    if (!target || !paramDefs.has(target)) continue;
    const c = pulseContribution(mapping, t, ctx);
    if (c !== 0) contributions.set(target, (contributions.get(target) ?? 0) + c);
  }
  // Live pulses (manual/keyboard) evaluated by the scheduler arrive here.
  if (extraContribution) {
    for (const [target, c] of extraContribution) {
      if (paramDefs.has(target)) contributions.set(target, (contributions.get(target) ?? 0) + c);
    }
  }
  if (contributions.size === 0) return params;

  const out: Record<string, ParamRecord[string]> = { ...params };
  for (const [target, c] of contributions) {
    const def = paramDefs.get(target);
    if (!def) continue;
    const span = def.max - def.min;
    const current = typeof out[target] === 'number' ? (out[target] as number) : def.default;
    out[target] = Math.min(Math.max(current + c * span, def.min), def.max);
  }
  return out;
}

/** Diagnostic: number of envelopes currently contributing (all mappings). */
export function activePulseCount(triggers: TriggerMapping[], t: number, ctx: TriggerContext): number {
  let count = 0;
  for (const mapping of triggers) {
    if (!mapping.enabled || mapping.action !== 'pulse') continue;
    if (!isDeterministicSource(mapping.source)) continue;
    const window = envelopeDuration(mapping);
    if (window <= 0) continue;
    const events = applyCooldown(
      eventTimesInWindow(mapping.source, t, lookbackSec(mapping), ctx),
      mapping.cooldownSec,
    );
    for (const eventTime of events) {
      const local = t - eventTime;
      if (local >= 0 && local <= window) count++;
    }
  }
  return count;
}

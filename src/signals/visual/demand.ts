import type { ModulationMapping } from '@shared/schemas/project';
import { VISUAL_SIGNALS, type VisualSignalId, isVisualSignalId } from './types';

/**
 * v0.4A — which visual signals anybody actually needs this frame.
 *
 * Analysis is demand-driven like the flow service: nothing mapped and no scope
 * open means the reducer sleeps and releases its targets. `scopes` lets the
 * diagnostics panel keep a signal alive while it is being watched.
 */
export function visualDemand(
  mappings: readonly ModulationMapping[],
  scopes: ReadonlySet<string> = new Set(),
): Set<VisualSignalId> {
  const out = new Set<VisualSignalId>();
  for (const m of mappings) {
    if (!m.enabled) continue;
    if (isVisualSignalId(m.source)) out.add(m.source);
  }
  for (const id of scopes) if (isVisualSignalId(id)) out.add(id);
  return out;
}

/** True when any demanded signal needs the optical-flow field. */
export function demandNeedsFlow(demand: ReadonlySet<VisualSignalId>): boolean {
  return VISUAL_SIGNALS.some((s) => s.family === 'motion' && demand.has(s.id));
}

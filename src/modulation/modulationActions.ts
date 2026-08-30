import { useProjectStore } from '@/state/projectStore';
import { uid } from '@/utils/id';
import { visualSignalDef } from '@/signals/visual/types';
import { modulationRuntime } from './runtime';
import type { ModulationMapping } from '@shared/schemas/project';

export function addMapping(source: string, target: string): void {
  // v0.4A: a CENTRED signal rests at 0.5, so a 0..1 range would make "still"
  // contribute half the parameter span. The signal declares the range that
  // makes it neutral at rest.
  const range = visualSignalDef(source)?.defaultMapping ?? { min: 0, max: 1 };
  const mapping: ModulationMapping = {
    id: uid('mod'),
    enabled: true,
    source,
    target,
    amount: 0.5,
    min: range.min,
    max: range.max,
    invert: false,
    smoothing: 0.25,
    curve: 'linear',
    frozenValue: null,
  };
  useProjectStore.getState().apply((p) => ({ ...p, modulations: [...p.modulations, mapping] }));
}

export function updateMapping(id: string, patch: Partial<ModulationMapping>): void {
  useProjectStore.getState().apply((p) => ({
    ...p,
    modulations: p.modulations.map((m) => (m.id === id ? { ...m, ...patch } : m)),
  }));
}

export function deleteMapping(id: string): void {
  useProjectStore.getState().apply((p) => ({
    ...p,
    modulations: p.modulations.filter((m) => m.id !== id),
  }));
}

/** FREEZE: capture the mapping's current shaped value and hold it. */
export function freezeMapping(id: string): void {
  const shaped = modulationRuntime.currentShapedValue(id);
  updateMapping(id, { frozenValue: shaped ?? 0 });
}

export function unfreezeMapping(id: string): void {
  updateMapping(id, { frozenValue: null });
}

/** Freeze every enabled mapping at its current shaped value. */
export function freezeAll(): void {
  const { project } = useProjectStore.getState();
  for (const m of project.modulations) {
    if (m.enabled && m.frozenValue === null) freezeMapping(m.id);
  }
}

/** Clear every frozen value. */
export function clearAllFreezes(): void {
  const { project } = useProjectStore.getState();
  for (const m of project.modulations) {
    if (m.frozenValue !== null) unfreezeMapping(m.id);
  }
}

/** F key: any frozen → clear all; none frozen → freeze all (§1). */
export function toggleFreezeAll(): void {
  const { project } = useProjectStore.getState();
  const anyFrozen = project.modulations.some((m) => m.frozenValue !== null);
  if (anyFrozen) clearAllFreezes();
  else freezeAll();
}

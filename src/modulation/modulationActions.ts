import { useProjectStore } from '@/state/projectStore';
import { uid } from '@/utils/id';
import { modulationRuntime } from './runtime';
import type { ModulationMapping } from '@shared/schemas/project';

export function addMapping(source: string, target: string): void {
  const mapping: ModulationMapping = {
    id: uid('mod'),
    enabled: true,
    source,
    target,
    amount: 0.5,
    min: 0,
    max: 1,
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

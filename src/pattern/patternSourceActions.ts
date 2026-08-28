import type { PatternSource } from '@shared/schemas/project';
import { useProjectStore } from '@/state/projectStore';
import { uid } from '@/utils/id';

/**
 * P4 — pattern source CRUD over the standard immutable project update path
 * (undo/redo compatible by construction; no UI yet — dev/test surface).
 */

export function addPatternSource(
  source: Omit<PatternSource, 'id'> & { id?: string },
): PatternSource {
  const full: PatternSource = { ...source, id: source.id ?? uid('pat') };
  useProjectStore.getState().apply((p) => ({
    ...p,
    patternSources: [...p.patternSources, full],
  }));
  return full;
}

export function updatePatternSource(id: string, patch: Partial<Omit<PatternSource, 'id'>>): void {
  useProjectStore.getState().apply((p) => ({
    ...p,
    patternSources: p.patternSources.map((s) => (s.id === id ? { ...s, ...patch } : s)),
  }));
}

export function removePatternSource(id: string): void {
  useProjectStore.getState().apply((p) => ({
    ...p,
    patternSources: p.patternSources.filter((s) => s.id !== id),
    // A mapping pointing at a removed pattern would be silently neutral
    // forever — drop it with the source, like other entity removals do.
    modulations: p.modulations.filter((m) => m.source !== `pattern:${id}`),
  }));
}

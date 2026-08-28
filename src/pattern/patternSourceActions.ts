import type { PatternSource, Project } from '@shared/schemas/project';
import { useProjectStore } from '@/state/projectStore';
import { uid } from '@/utils/id';
import { parsePattern, type PatternParseError } from './miniNotation';
import { parsePatternSourceKey, patternSourceKey } from './patternSourceRuntime';

/**
 * P4/P6 — pattern source CRUD over the standard immutable project update
 * path. Every operation is ONE `store.apply` call, so it is one history
 * entry and one dirty transition, exactly like any other project edit.
 *
 * Pattern sources are PROJECT-GLOBAL resources (see docs/DECISIONS.md):
 * looks capture MAPPINGS, never pattern definitions, so these actions are
 * the only thing that creates, edits or destroys a pattern's identity.
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

/** Edit a definition in place — the id, and therefore the probability lane, survives. */
export function updatePatternSource(id: string, patch: Partial<Omit<PatternSource, 'id'>>): void {
  useProjectStore.getState().apply((p) => ({
    ...p,
    patternSources: p.patternSources.map((s) => (s.id === id ? { ...s, ...patch } : s)),
  }));
}

export function setPatternSourceEnabled(id: string, enabled: boolean): void {
  updatePatternSource(id, { enabled });
}

/**
 * Copy a source under a NEW id. The definition is identical but the
 * deterministic probability lane is not — a duplicated Degrade pattern makes
 * its own independent decisions, which is the point of duplicating it.
 * Mappings are deliberately not cloned (P6 §18): the copy starts unassigned.
 */
export function duplicatePatternSource(id: string): PatternSource | null {
  const original = useProjectStore.getState().project.patternSources.find((s) => s.id === id);
  if (!original) return null;
  const copy: PatternSource = {
    ...original,
    id: uid('pat'),
    pattern: structuredClone(original.pattern),
    transforms: structuredClone(original.transforms),
  };
  useProjectStore.getState().apply((p) => ({
    ...p,
    patternSources: [...p.patternSources, copy],
  }));
  return copy;
}

/**
 * Remove a source and every mapping that referenced it, atomically — a
 * mapping pointing at a dead pattern is invisible in the UI but would sit in
 * the file forever. One apply → one undo restores the source AND its
 * mappings, with the same ids and therefore the same random decisions.
 *
 * Note this is an ACTION, never part of parsing: a hand-edited project that
 * arrives with orphan mappings still loads (they resolve neutral at runtime).
 */
export function removePatternSource(id: string): void {
  const key = patternSourceKey(id);
  useProjectStore.getState().apply((p) => ({
    ...p,
    patternSources: p.patternSources.filter((s) => s.id !== id),
    modulations: p.modulations.filter((m) => m.source !== key),
  }));
}

/**
 * P7 — commit mini-notation text to an existing source. Only the `pattern`
 * field is replaced: the id (and therefore the deterministic probability
 * lane), transforms, beatsPerCycle, enabled state and every mapping
 * referencing `pattern:<id>` survive untouched.
 *
 * Invalid text returns the parse error and touches NOTHING — no project
 * update, no history entry, no dirty flag. The runtime keeps rendering the
 * definition already in the project, which is what makes typing safe.
 */
export function updatePatternSourceFromText(
  id: string,
  text: string,
): { ok: true } | { ok: false; error: PatternParseError } {
  const result = parsePattern(text);
  if (!result.ok) return { ok: false, error: result.error };
  updatePatternSource(id, { pattern: result.definition });
  return { ok: true };
}

/** Mapping sources pointing at a pattern that no longer exists (diagnostics). */
export function orphanPatternMappings(project: Project): { mappingId: string; patternId: string }[] {
  const known = new Set(project.patternSources.map((s) => s.id));
  const orphans: { mappingId: string; patternId: string }[] = [];
  for (const mapping of project.modulations) {
    const patternId = parsePatternSourceKey(mapping.source);
    if (patternId !== null && !known.has(patternId)) {
      orphans.push({ mappingId: mapping.id, patternId });
    }
  }
  return orphans;
}

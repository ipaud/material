import { uid } from '@/utils/id';
import type { LayerLook, PinnedLook, Project } from '@shared/schemas/project';

/**
 * v0.6D — a Look is the whole composition.
 *
 * Before layers, "the look" was one technique wearing one material, so a Look
 * captured that. With layers it is the stack: recalling a slot and getting a
 * hybrid — this Look's technique wearing whatever else happened to be loaded —
 * is not what anyone means by recalling a look.
 *
 * A Look pinned BEFORE v0.6 has no stack recorded, and must keep doing exactly
 * what it always did: apply to the selected layer and leave the rest alone.
 * Absence of `layers` is the honest record of "this predates layers"; inventing
 * a one-layer stack for it would silently start wiping layers the performer
 * added afterwards.
 */

export function captureLayerLooks(project: Project): LayerLook[] {
  return project.layers.map((l) => ({
    id: l.id,
    name: l.name,
    enabled: l.enabled,
    opacity: l.opacity,
    blendMode: l.blendMode,
    sourceId: l.sourceId,
    technique: l.technique ? { ...l.technique, params: { ...l.technique.params } } : null,
    material: { ...l.material, params: { ...l.material.params } },
  }));
}

/** Does this Look know about the stack, or does it predate layers? */
export function isCompositionLook(look: PinnedLook): boolean {
  return Array.isArray(look.layers) && look.layers.length > 0;
}

/**
 * Restore a whole stack.
 *
 * Layers are matched by id, so a layer that survived keeps its runtime —
 * a feedback surface or a simulation is not rebuilt just because a Look was
 * recalled, and the recall is therefore instant rather than a visible reset.
 * A layer the Look does not mention is REMOVED, because the Look is the whole
 * composition and leaving strays behind would make recall non-idempotent.
 */
export function projectWithLayerLooks(project: Project, look: PinnedLook): Project {
  const stack = look.layers;
  if (!stack || stack.length === 0) return project;
  const byId = new Map(project.layers.map((l) => [l.id, l]));
  const layers = stack.map((entry) => {
    const existing = byId.get(entry.id);
    return {
      ...(existing ?? {
        id: entry.id,
        name: entry.name,
        enabled: true,
        solo: false,
        opacity: 1,
        blendMode: 'normal' as const,
        sourceId: null,
        technique: null,
        activity: null,
        material: entry.material,
      }),
      id: entry.id,
      name: entry.name,
      enabled: entry.enabled,
      // Solo is live performance state, not part of a look: recalling a Look
      // must not silently re-solo something the performer released.
      solo: existing?.solo ?? false,
      opacity: entry.opacity,
      blendMode: entry.blendMode,
      sourceId: entry.sourceId,
      technique: entry.technique
        ? { ...entry.technique, id: existing?.technique?.id ?? uid('tech'), params: { ...entry.technique.params } }
        : null,
      material: { ...entry.material, params: { ...entry.material.params } },
    };
  });
  // The Look's own selection wins: its `techniques` and `material` describe
  // that layer, and applying them anywhere else produces a hybrid.
  const recorded = look.selectedLayerId;
  const selected =
    recorded && layers.some((l) => l.id === recorded)
      ? recorded
      : layers.some((l) => l.id === project.selectedLayerId)
        ? project.selectedLayerId
        : (layers[0]?.id ?? null);
  return { ...project, layers, selectedLayerId: selected };
}

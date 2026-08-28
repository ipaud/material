import type { LookCore, PinnedLook, Project } from '@shared/schemas/project';
import { uid } from '@/utils/id';

/**
 * LookCore is the morphable/apply-able essence of a look:
 * technique + params + material + modulations + triggers + seed.
 * Deliberately excluded: source media, playback time, UI state, live FIRE
 * state, thumbnails and identity fields.
 */

export function captureLookCore(project: Project): LookCore | null {
  const active = project.techniques.find((t) => t.enabled);
  if (!active) return null;
  return {
    techniqueId: active.techniqueId,
    params: { ...active.params },
    material: {
      ...project.material,
      params: { ...project.material.params },
    },
    modulations: project.modulations.map((m) => ({ ...m })),
    triggers: project.triggers.map((t) => ({ ...t })),
    seed: project.explore.lastSeed ?? 1,
  };
}

export function lookToCore(look: PinnedLook): LookCore {
  const active = look.techniques.find((t) => t.enabled);
  return {
    techniqueId: active?.techniqueId ?? 'mosaic',
    params: { ...(active?.params ?? {}) },
    material: { ...look.material, params: { ...look.material.params } },
    modulations: look.modulations.map((m) => ({ ...m })),
    triggers: look.triggers.map((t) => ({ ...t })),
    seed: look.seed,
  };
}

/**
 * ATOMIC apply: the complete target state is committed in one project
 * update — technique, material, modulations, triggers and seed change
 * together, in a single undo entry, with no intermediate state.
 */
export function projectWithLookCore(
  project: Project,
  core: LookCore,
  activeLookId: string | null,
): Project {
  return {
    ...project,
    techniques: [
      { id: uid('tech'), techniqueId: core.techniqueId, enabled: true, params: { ...core.params } },
    ],
    material: { ...core.material, params: { ...core.material.params } },
    modulations: core.modulations.map((m) => ({ ...m })),
    triggers: core.triggers.map((t) => ({ ...t })),
    explore: { ...project.explore, lastSeed: core.seed },
    activeLookId,
  };
}

/** Stable serialization for dirty comparison — key order independent. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** True when the project's current core differs from the stored look's. */
export function isLookDirty(project: Project, look: PinnedLook): boolean {
  const current = captureLookCore(project);
  if (!current) return false;
  return stable(current) !== stable(lookToCore(look));
}

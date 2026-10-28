import { selectedLayerOf } from '@shared/schemas/project';
import type { LookCore, PinnedLook, Project } from '@shared/schemas/project';
import { uid } from '@/utils/id';

/**
 * LookCore is the morphable/apply-able essence of a look:
 * technique + params + material + modulations + triggers + seed.
 * Deliberately excluded: source media, playback time, UI state, live FIRE
 * state, thumbnails and identity fields.
 */

export function captureLookCore(project: Project): LookCore | null {
  // v0.6: a Look is the SELECTED LAYER's creative state. That preserves what a
  // Look has always meant — one branch's technique, material, mappings and
  // seed — while the composition around it stays where it is. Recalling a
  // whole multi-layer composition is a different job; see docs/PERFORM.md.
  const layer = selectedLayerOf(project);
  const active = layer.technique;
  if (!active) return null;
  return {
    techniqueId: active.techniqueId,
    params: { ...active.params },
    techniqueChain: layer.techniqueChain.map((stage) => ({ ...stage, params: { ...stage.params } })),
    material: {
      ...layer.material,
      params: { ...layer.material.params },
    },
    modulations: project.modulations.map((m) => ({ ...m })),
    triggers: project.triggers.map((t) => ({ ...t })),
    seed: project.explore.lastSeed ?? 1,
  };
}

export function lookToCore(look: PinnedLook): LookCore {
  const active = look.techniques.find((t) => t.enabled);
  const selectedLayer = look.layers?.find((layer) => layer.id === look.selectedLayerId);
  return {
    techniqueId: active?.techniqueId ?? 'mosaic',
    params: { ...(active?.params ?? {}) },
    ...(selectedLayer ? { techniqueChain: selectedLayer.techniqueChain.map((stage) => ({ ...stage, params: { ...stage.params } })) } : {}),
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
  const target = selectedLayerOf(project);
  return {
    ...project,
    // NOTE: this restores the SELECTED layer only. A Look pinned from v0.6 on
    // also carries the stack, and `applyLook` layers that on top — see
    // projectWithLayerLooks. Keeping the single-layer path intact is what lets
    // a pre-v0.6 Look keep behaving exactly as it did.

    layers: project.layers.map((l) =>
      l.id === target.id
        ? {
            ...l,
            technique: {
              id: uid('tech'),
              techniqueId: core.techniqueId,
              enabled: true,
              params: { ...core.params },
            },
            ...(core.techniqueChain ? {
              techniqueChain: core.techniqueChain.map((stage) => ({ ...stage, params: { ...stage.params } })),
            } : {}),
            material: { ...core.material, params: { ...core.material.params } },
          }
        : l,
    ),
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
  const target = lookToCore(look);
  if (target.techniqueChain === undefined) {
    const { techniqueChain: _chain, ...legacyCurrent } = current;
    return stable(legacyCurrent) !== stable(target);
  }
  return stable(current) !== stable(target);
}

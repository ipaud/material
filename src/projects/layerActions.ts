import { MAX_LAYERS, emptyLayer, type BlendMode, type Layer } from '@shared/schemas/project';
import { useProjectStore } from '@/state/projectStore';
import { uid } from '@/utils/id';

/**
 * v0.6 — the layer edits, all of them.
 *
 * Every one goes through the project store's `apply`, so undo/redo, autosave
 * and the engine bridge follow for free. Nothing here touches a runtime: the
 * bridge reconciles branches from the layer list, keyed by id, which is what
 * lets a reorder move a layer without rebuilding what it owns.
 */

export function addLayer(): string | null {
  const { project } = useProjectStore.getState();
  if (project.layers.length >= MAX_LAYERS) return null;
  const id = uid('layer');
  useProjectStore.getState().apply((p) => ({
    ...p,
    // A new layer starts EMPTY. Defaulting it to a generator would spend GPU
    // and, worse, put something on screen the user did not ask for.
    layers: [...p.layers, emptyLayer(id, `Layer ${p.layers.length + 1}`)],
    selectedLayerId: id,
  }));
  return id;
}

export function deleteLayer(layerId: string): void {
  useProjectStore.getState().apply((p) => {
    if (p.layers.length <= 1) return p; // a composition always has one layer
    const layers = p.layers.filter((l) => l.id !== layerId);
    const selected =
      p.selectedLayerId === layerId ? (layers[layers.length - 1]?.id ?? null) : p.selectedLayerId;
    return {
      ...p,
      layers,
      selectedLayerId: selected,
      // Mappings that READ this layer's signals are kept but go inert — see
      // docs/ROUTING.md. Mappings that TARGET it go with it.
      modulations: p.modulations.filter((m) => m.targetLayerId !== layerId),
    };
  });
}

export function selectLayer(layerId: string): void {
  // Selection is editing focus only: it changes what the inspector shows and
  // nothing about what renders.
  useProjectStore.getState().apply((p) => ({ ...p, selectedLayerId: layerId }));
}

export function moveLayer(layerId: string, delta: number): void {
  useProjectStore.getState().apply((p) => {
    const index = p.layers.findIndex((l) => l.id === layerId);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= p.layers.length) return p;
    const layers = [...p.layers];
    const [moved] = layers.splice(index, 1);
    layers.splice(next, 0, moved as Layer);
    return { ...p, layers };
  });
}

export function updateLayer(layerId: string, patch: Partial<Layer>): void {
  useProjectStore.getState().apply((p) => ({
    ...p,
    layers: p.layers.map((l) => (l.id === layerId ? { ...l, ...patch } : l)),
  }));
}

export function setLayerOpacity(layerId: string, opacity: number): void {
  updateLayer(layerId, { opacity: Math.min(Math.max(opacity, 0), 1) });
}

/**
 * Set, patch or clear (null) a layer's activity window. A patch on a layer with
 * no window starts one at 0; an end at or before the start is pushed one second
 * past it, because the schema (rightly) refuses a window that closes before it opens.
 */
export function setLayerActivity(
  layerId: string,
  patch: Partial<NonNullable<Layer['activity']>> | null,
): void {
  const layer = useProjectStore.getState().project.layers.find((l) => l.id === layerId);
  if (!layer) return;
  if (patch === null) {
    updateLayer(layerId, { activity: null });
    return;
  }
  const merged = { start: 0, end: null, fadeIn: 0, fadeOut: 0, ...layer.activity, ...patch };
  const start = Math.max(merged.start, 0);
  const end = merged.end === null ? null : Math.max(merged.end, start + 1);
  updateLayer(layerId, {
    activity: {
      start,
      end,
      fadeIn: Math.max(merged.fadeIn, 0),
      fadeOut: Math.max(merged.fadeOut, 0),
    },
  });
}

export function setLayerBlend(layerId: string, blendMode: BlendMode): void {
  updateLayer(layerId, { blendMode });
}

export function toggleLayerEnabled(layerId: string): void {
  const layer = useProjectStore.getState().project.layers.find((l) => l.id === layerId);
  if (layer) updateLayer(layerId, { enabled: !layer.enabled });
}

/**
 * Solo one layer — or release solo if it already holds it.
 *
 * Solo is exclusive and it is a VIEW: it never touches anyone's `enabled`, so
 * releasing it restores exactly the stack the performer had. That matters
 * live, where solo is a thing you hit to check one layer and then undo without
 * having to remember what was muted.
 */
export function toggleLayerSolo(layerId: string): void {
  const { project, apply } = useProjectStore.getState();
  const layer = project.layers.find((l) => l.id === layerId);
  if (!layer) return;
  const next = !layer.solo;
  apply((p) => ({
    ...p,
    layers: p.layers.map((l) => ({ ...l, solo: l.id === layerId ? next : false })),
  }));
}

/** Release solo without changing which layer it was on. */
export function clearLayerSolo(): void {
  const { project, apply } = useProjectStore.getState();
  if (!project.layers.some((l) => l.solo)) return;
  apply((p) => ({ ...p, layers: p.layers.map((l) => ({ ...l, solo: false })) }));
}

/**
 * Duplicate a layer's CONFIG. The copy gets a new id, so the bridge builds it
 * a fresh runtime — a duplicated feedback layer starts from nothing rather
 * than inheriting frames it never rendered.
 */
export function duplicateLayer(layerId: string): string | null {
  const { project } = useProjectStore.getState();
  if (project.layers.length >= MAX_LAYERS) return null;
  const source = project.layers.find((l) => l.id === layerId);
  if (!source) return null;
  const id = uid('layer');
  useProjectStore.getState().apply((p) => {
    const index = p.layers.findIndex((l) => l.id === layerId);
    const copy: Layer = {
      ...source,
      id,
      name: source.name ? `${source.name} copy` : '',
      technique: source.technique ? { ...source.technique, id: uid('tech') } : null,
    };
    const layers = [...p.layers];
    layers.splice(index + 1, 0, copy);
    return { ...p, layers, selectedLayerId: id };
  });
  return id;
}

/** The layer the inspector, Explore and presets act on. */
export function selectedLayer(project = useProjectStore.getState().project): Layer {
  return project.layers.find((l) => l.id === project.selectedLayerId) ?? (project.layers[0] as Layer);
}

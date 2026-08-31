import { selectedLayerOf } from '@shared/schemas/project';
import { captureLayerLooks, projectWithLayerLooks } from '@/performance/layerLook';
import { isDarkThumbnail, renderThumbnail } from '@/performance/thumbnail';
import { blockedByExport } from '@/export/exportGuard';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { uid } from '@/utils/id';
import { captureLookCore, lookToCore, projectWithLookCore } from '@/performance/lookCore';
import type { PinnedLook, Project } from '@shared/schemas/project';

/** Deterministic look thumbnail via the existing offscreen render path. */
function renderLookThumbnail(project: Project): string | null {
  return renderThumbnail(project, selectedLayerOf(project).technique?.params ?? {}).dataUrl;
}

/** Re-render a look's thumbnail from the CURRENT frame (§14). */
export function rethumbnailLook(lookId: string): void {
  const { project, apply } = useProjectStore.getState();
  const look = project.pinnedLooks.find((l) => l.id === lookId);
  if (!look) return;
  const params = look.techniques.find((t) => t.enabled)?.params ?? {};
  const { dataUrl, luminance } = renderThumbnail(project, params);
  if (!dataUrl) return;
  apply((p) => ({
    ...p,
    pinnedLooks: p.pinnedLooks.map((l) => (l.id === lookId ? { ...l, thumbnail: dataUrl } : l)),
  }));
  if (isDarkThumbnail(luminance)) {
    useUiStore
      .getState()
      .pushToast('info', 'Thumbnail is very dark — try again on a brighter frame');
  }
}

function nextFreeSlot(looks: PinnedLook[]): number | null {
  for (let s = 1; s <= 9; s++) {
    if (!looks.some((l) => l.slot === s)) return s;
  }
  return null;
}

/** Pin the current state as a new Look — instant, one undo entry. */
export function pinCurrentLook(): PinnedLook | null {
  const { project, apply } = useProjectStore.getState();
  const core = captureLookCore(project);
  if (!core) {
    useUiStore.getState().pushToast('info', 'Nothing to pin yet');
    return null;
  }
  const slot = nextFreeSlot(project.pinnedLooks);
  const look: PinnedLook = {
    id: uid('look'),
    createdAt: new Date().toISOString(),
    label: `LOOK ${String(project.pinnedLooks.length + 1).padStart(2, '0')}`,
    note: '',
    slot,
    seed: core.seed,
    thumbnail: renderLookThumbnail(project),
    // The Look records the selected layer's branch, matching captureLookCore.
    techniques: selectedLayerOf(project).technique ? [selectedLayerOf(project).technique!] : [],
    layers: captureLayerLooks(project),
    selectedLayerId: selectedLayerOf(project).id,
    material: selectedLayerOf(project).material,
    modulations: project.modulations,
    triggers: project.triggers,
  };
  apply((p) => ({ ...p, pinnedLooks: [...p.pinnedLooks, look], activeLookId: look.id }));
  useUiStore
    .getState()
    .pushToast('info', slot ? `Pinned ${look.label} → slot ${slot}` : `Pinned ${look.label} — all slots full; Shift+1–9 assigns it over a slot`);
  return look;
}

/**
 * ATOMIC apply: the whole look state commits as one operation (§5).
 *
 * v0.6D — a Look pinned from a composition restores the whole stack; one
 * pinned before layers existed restores the selected layer and leaves the
 * rest alone. Both land in a single project update, so a recall is one undo
 * entry and never shows a half-applied composition.
 */
export function applyLook(lookId: string): void {
  if (blockedByExport('Applying a Look')) return;
  useProjectStore.getState().apply((p) => {
    const look = p.pinnedLooks.find((l) => l.id === lookId);
    if (!look) return p;
    // The stack first, so the core lands on the layer the Look says is
    // selected rather than on whatever was selected a moment ago.
    const stacked = projectWithLayerLooks(p, look);
    return projectWithLookCore(stacked, lookToCore(look), look.id);
  });
}

export function applyLookBySlot(slot: number): boolean {
  const look = useProjectStore.getState().project.pinnedLooks.find((l) => l.slot === slot);
  if (!look) return false;
  applyLook(look.id);
  return true;
}

/** Shift+number: overwrite the slot's look with the current state. */
export function overwriteSlotWithCurrent(slot: number): void {
  const { project } = useProjectStore.getState();
  const existing = project.pinnedLooks.find((l) => l.slot === slot);
  if (existing) {
    updateLook(existing.id);
    useUiStore.getState().pushToast('info', `Slot ${slot} overwritten with current state`);
    return;
  }
  const pinned = pinCurrentLook();
  if (pinned && pinned.slot !== slot) {
    useProjectStore.getState().apply((p) => ({
      ...p,
      pinnedLooks: p.pinnedLooks.map((l) =>
        l.id === pinned.id ? { ...l, slot } : l.slot === slot ? { ...l, slot: null } : l,
      ),
    }));
  }
}

/** Intentional overwrite of a stored look with the current state (§24). */
export function updateLook(lookId: string): void {
  const { project, apply } = useProjectStore.getState();
  const core = captureLookCore(project);
  if (!core) return;
  const thumbnail = renderLookThumbnail(project);
  apply((p) => ({
    ...p,
    pinnedLooks: p.pinnedLooks.map((l) =>
      l.id === lookId
        ? {
            ...l,
            techniques: selectedLayerOf(p).technique ? [selectedLayerOf(p).technique!] : [],
            layers: captureLayerLooks(p),
            selectedLayerId: selectedLayerOf(p).id,
            material: selectedLayerOf(p).material,
            modulations: p.modulations,
            triggers: p.triggers,
            seed: core.seed,
            thumbnail: thumbnail ?? l.thumbnail,
          }
        : l,
    ),
    activeLookId: lookId,
  }));
}

export function renameLook(lookId: string, label: string): void {
  const trimmed = label.trim().slice(0, 40);
  if (!trimmed) return;
  useProjectStore.getState().apply((p) => ({
    ...p,
    pinnedLooks: p.pinnedLooks.map((l) => (l.id === lookId ? { ...l, label: trimmed } : l)),
  }));
}

export function duplicateLook(lookId: string): void {
  useProjectStore.getState().apply((p) => {
    const look = p.pinnedLooks.find((l) => l.id === lookId);
    if (!look) return p;
    const copy: PinnedLook = {
      ...look,
      id: uid('look'),
      createdAt: new Date().toISOString(),
      label: `${look.label} COPY`,
      slot: nextFreeSlot(p.pinnedLooks),
    };
    return { ...p, pinnedLooks: [...p.pinnedLooks, copy] };
  });
}

export function deleteLook(lookId: string): void {
  useProjectStore.getState().apply((p) => ({
    ...p,
    pinnedLooks: p.pinnedLooks.filter((l) => l.id !== lookId),
    activeLookId: p.activeLookId === lookId ? null : p.activeLookId,
  }));
}

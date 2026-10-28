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

/** Pin current composition instantly; Pins stay unslotted until promoted. */
export function pinCurrentLook(): PinnedLook | null {
  const { project, apply } = useProjectStore.getState();
  const pin = createPin(project);
  if (!pin) {
    useUiStore.getState().pushToast('info', 'Nothing to pin yet');
    return null;
  }
  apply((p) => ({ ...p, pinnedLooks: [...p.pinnedLooks, pin] }));
  useUiStore.getState().pushToast('info', `Pinned ${pin.label}`);
  return pin;
}

/** Capture a full, project-owned snapshot without changing the live project. */
export function createPin(
  project: Project,
  snapshot: Project = project,
  thumbnail?: string | null,
  note = '',
): PinnedLook | null {
  const core = captureLookCore(snapshot);
  if (!core) return null;
  const layer = selectedLayerOf(snapshot);
  const number = project.pinnedLooks.reduce((max, look) => {
    const match = /^PIN (\d+)$/.exec(look.label);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0) + 1;
  return {
    id: uid('look'),
    createdAt: new Date().toISOString(),
    label: `PIN ${String(number).padStart(3, '0')}`,
    note,
    slot: null,
    seed: core.seed,
    thumbnail: thumbnail === undefined ? renderLookThumbnail(snapshot) : thumbnail,
    techniques: layer.technique ? [layer.technique] : [],
    layers: captureLayerLooks(snapshot),
    selectedLayerId: layer.id,
    material: layer.material,
    modulations: snapshot.modulations,
    triggers: snapshot.triggers,
  };
}

/** Add `snapshot` as a Pin to `project`; leave `project` unchanged otherwise. */
export function addPin(
  project: Project,
  snapshot: Project = project,
  thumbnail?: string | null,
  note = '',
): Project {
  const pin = createPin(project, snapshot, thumbnail, note);
  return pin ? { ...project, pinnedLooks: [...project.pinnedLooks, pin] } : project;
}

/** Promote an unslotted Pin into the next available performance Look slot. */
export function makeLook(lookId: string): boolean {
  const { project, apply } = useProjectStore.getState();
  const pin = project.pinnedLooks.find((look) => look.id === lookId);
  if (!pin) return false;
  if (pin.slot !== null) return true;
  const slot = nextFreeSlot(project.pinnedLooks);
  if (slot === null) {
    useUiStore.getState().pushToast('info', 'No empty Look slots');
    return false;
  }
  apply((p) => ({
    ...p,
    pinnedLooks: p.pinnedLooks.map((look) =>
      look.id === lookId
        ? {
            ...look,
            slot,
            label: /^PIN \d{3}$/.test(look.label) ? `LOOK ${String(slot).padStart(2, '0')}` : look.label,
          }
        : look,
    ),
  }));
  return true;
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

/** Hold a generator-only Pin in the renderer without changing saved document state. */
export function previewPin(lookId: string): boolean {
  const { project, beginPreview } = useProjectStore.getState();
  const look = project.pinnedLooks.find((item) => item.id === lookId);
  if (!look) return false;
  const preview = projectWithLookCore(projectWithLayerLooks(project, look), lookToCore(look), look.id);
  const hasUnsupportedSource = preview.layers.some((layer) => {
    if (!layer.sourceId) return false;
    const source = preview.sources.find((item) => item.id === layer.sourceId);
    return !source || source.kind !== 'generator';
  });
  if (hasUnsupportedSource) {
    useUiStore.getState().pushToast('info', 'Compare currently supports existing generator sources only');
    return false;
  }
  beginPreview(preview, `Compare ${look.label}`);
  return true;
}

export function endPinPreview(): void {
  useProjectStore.getState().cancelPreview();
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
  // One apply, so one undo removes the new Look entirely — never an orphan Pin.
  const pin = createPin(project);
  if (!pin) {
    useUiStore.getState().pushToast('info', 'Nothing to pin yet');
    return;
  }
  const look = { ...pin, slot, label: `LOOK ${String(slot).padStart(2, '0')}` };
  useProjectStore.getState().apply((p) => ({
    ...p,
    pinnedLooks: [...p.pinnedLooks, look],
    activeLookId: look.id,
  }));
  useUiStore.getState().pushToast('info', `Pinned ${look.label}`);
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

import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { uid } from '@/utils/id';
import type { PinnedLook } from '@shared/schemas/project';

/** Snapshot the current visual state as a Pinned Look (instant, no dialog). */
export function pinCurrentLook(): void {
  const { project, apply } = useProjectStore.getState();
  if (project.techniques.length === 0) {
    useUiStore.getState().pushToast('info', 'Nothing to pin yet');
    return;
  }
  const look: PinnedLook = {
    id: uid('look'),
    createdAt: new Date().toISOString(),
    label: `Look ${project.pinnedLooks.length + 1}`,
    techniques: project.techniques,
    material: project.material,
    modulations: project.modulations,
  };
  apply((p) => ({ ...p, pinnedLooks: [...p.pinnedLooks, look] }));
  useUiStore.getState().pushToast('info', `Pinned ${look.label}`);
}

export function applyLook(lookId: string): void {
  useProjectStore.getState().apply((p) => {
    const look = p.pinnedLooks.find((l) => l.id === lookId);
    if (!look) return p;
    return { ...p, techniques: look.techniques, material: look.material, modulations: look.modulations };
  });
}

export function deleteLook(lookId: string): void {
  useProjectStore.getState().apply((p) => ({
    ...p,
    pinnedLooks: p.pinnedLooks.filter((l) => l.id !== lookId),
  }));
}

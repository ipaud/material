import { useProjectStore } from '@/state/projectStore';
import { reportError, useUiStore } from '@/state/uiStore';
import { uid } from '@/utils/id';
import type { MediaMetadata } from '@shared/schemas/media';

export async function saveProject(forceDialog = false): Promise<void> {
  const { project, projectPath, markSaved } = useProjectStore.getState();
  try {
    let path = projectPath;
    if (forceDialog || !path) {
      path = await window.material.saveProjectDialog(project.name || 'Untitled');
      if (!path) return;
    }
    await window.material.writeProject(path, project);
    markSaved(path);
    useUiStore.getState().pushToast('info', 'Project saved');
  } catch (err) {
    reportError('Save project', err);
  }
}

export async function openProject(): Promise<void> {
  try {
    const path = await window.material.openProjectDialog();
    if (!path) return;
    const result = await window.material.readProject(path);
    useProjectStore.getState().loadProject(result.path, result.project);
  } catch (err) {
    reportError('Open project', err);
  }
}

export function newProject(): void {
  useProjectStore.getState().newProject();
}

/** Import media files (from drag-drop or dialog) into the project library. */
export async function importMediaPaths(paths: string[]): Promise<void> {
  const { apply } = useProjectStore.getState();
  for (const path of paths) {
    let metadata: MediaMetadata;
    try {
      metadata = await window.material.probeMedia(path);
    } catch (err) {
      reportError(`Import ${path.split('/').pop() ?? path}`, err);
      continue;
    }
    const sourceId = uid('src');
    apply((p) => {
      // Skip duplicates by path.
      if (p.sources.some((s) => s.path === path)) return p;
      const sources = [...p.sources, { id: sourceId, kind: metadata.kind, path, metadata }];
      let composition = p.composition;
      // First visual source becomes the active composition source.
      if (!p.composition.sourceId && (metadata.kind === 'image' || metadata.kind === 'video')) {
        composition = {
          ...composition,
          sourceId,
          width: metadata.width ?? composition.width,
          height: metadata.height ?? composition.height,
        };
      }
      if (!p.composition.audioSourceId && metadata.kind === 'audio') {
        composition = { ...composition, audioSourceId: sourceId };
      }
      return { ...p, sources, composition };
    });
  }
}

export async function importMediaViaDialog(): Promise<void> {
  try {
    const paths = await window.material.openMediaDialog();
    if (paths.length > 0) await importMediaPaths(paths);
  } catch (err) {
    reportError('Import media', err);
  }
}

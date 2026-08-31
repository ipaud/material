import { useProjectStore } from '@/state/projectStore';
import { reportError, useUiStore } from '@/state/uiStore';
import { uid } from '@/utils/id';
import { getTechnique } from '@/techniques/registry';
import { defaultParams } from '@/techniques/types';
import type { MediaMetadata } from '@shared/schemas/media';
import { isFileSource, isLiveSource, type Project } from '@shared/schemas/project';
import { selectedLayerOf, withSelectedSource, withSelectedTechnique } from '@shared/schemas/project';

/** Ensure the project has an enabled technique chain (defaults to Mosaic). */
/**
 * v0.6: make sure the SELECTED LAYER has a technique. A layer without one
 * renders its source untouched, which is a valid state — this exists for the
 * paths that need something to apply a preset or a param edit to.
 */
export function withTechniqueEnsured(p: Project): Project {
  const layer = selectedLayerOf(p);
  if (layer.technique) return p;
  const mosaic = getTechnique('mosaic');
  if (!mosaic) return p;
  return withSelectedTechnique(p, () => ({
    id: uid('tech'),
    techniqueId: 'mosaic',
    enabled: true,
    params: defaultParams(mosaic),
  }));
}

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
    await openProjectFromPath(path);
  } catch (err) {
    reportError('Open project', err);
  }
}

export async function openProjectFromPath(path: string): Promise<void> {
  const result = await window.material.readProject(path);
  useProjectStore.getState().loadProject(result.path, result.project);
  await checkOfflineSources();
}

/** Probe every source; mark missing files as MEDIA OFFLINE. */
async function checkOfflineSources(): Promise<void> {
  const { project } = useProjectStore.getState();
  const offline: string[] = [];
  for (const source of project.sources) {
    if (isLiveSource(source) || source.kind === 'generator') continue; // no file to probe
    try {
      await window.material.probeMedia(source.path);
    } catch {
      offline.push(source.id);
    }
  }
  useUiStore.getState().setOfflineSources(offline);
  if (offline.length > 0) {
    useUiStore.getState().pushToast('error', `${offline.length} media file(s) offline`);
  }
}

/** Relink a missing source to a new file chosen in Finder. */
export async function relinkSource(sourceId: string): Promise<void> {
  try {
    const paths = await window.material.openMediaDialog();
    const newPath = paths[0];
    if (!newPath) return;
    const metadata = await window.material.probeMedia(newPath);
    useProjectStore.getState().apply((p) => ({
      ...p,
      sources: p.sources.map((s) =>
        s.id === sourceId ? { ...s, path: newPath, kind: metadata.kind, metadata } : s,
      ),
    }));
    await checkOfflineSources();
  } catch (err) {
    reportError('Relink media', err);
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
      if (p.sources.some((s) => isFileSource(s) && s.path === path)) return p;
      const sources = [...p.sources, { id: sourceId, kind: metadata.kind, path, metadata }];
      let next: Project = { ...p, sources };
      // The first visual source lands on the selected layer, not just on the
      // composition — a layer with no source of its own renders nothing.
      if (!p.composition.sourceId && (metadata.kind === 'image' || metadata.kind === 'video')) {
        next = withSelectedSource(next, sourceId);
        next = {
          ...next,
          composition: {
            ...next.composition,
            width: metadata.width ?? next.composition.width,
            height: metadata.height ?? next.composition.height,
          },
        };
      }
      if (!p.composition.audioSourceId && metadata.kind === 'audio') {
        next = { ...next, composition: { ...next.composition, audioSourceId: sourceId } };
      }
      return withTechniqueEnsured(next);
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

import { useProjectStore } from '@/state/projectStore';
import { reportError, useUiStore } from '@/state/uiStore';
import { uid } from '@/utils/id';
import { getTechnique } from '@/techniques/registry';
import { defaultParams } from '@/techniques/types';
import type { MediaMetadata } from '@shared/schemas/media';
import { planRelink } from './relink';
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

export async function openProjectFromPath(path: string, repair = false): Promise<void> {
  const result = await window.material.readProject(path, repair);
  if (!result.ok) {
    // Leave the open project alone; the repair dialog decides what happens next.
    useUiStore.getState().setPendingRepair({
      path: result.path,
      issues: result.issues,
      repairable: result.repairable,
    });
    return;
  }
  useUiStore.getState().setPendingRepair(null);
  useProjectStore.getState().loadProject(result.path, result.project);
  if (result.repaired.length > 0) {
    const n = result.repaired.length;
    useUiStore
      .getState()
      .pushToast('info', `Repaired ${n} value${n === 1 ? '' : 's'} — save to keep the fix`);
  }
  await checkOfflineSources();
}

/** Probe every source; mark missing files as MEDIA OFFLINE. */
export async function checkOfflineSources(): Promise<void> {
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

/**
 * v0.8 — find every missing file in one folder pick.
 *
 * A project already knows enough to recognise its own media: name, byte size,
 * duration and kind have been in `MediaMetadata` since v3. What was missing was
 * a resolver that uses them. Relinking a four-layer show was five Finder
 * dialogs; it is now one, and a source whose match is ambiguous stays offline
 * and says so rather than being pointed at whichever file sorted first.
 */
export async function relinkAllFromFolder(): Promise<void> {
  try {
    const entries = await window.material.pickMediaFolder();
    if (!entries) return;
    const { project } = useProjectStore.getState();
    const offlineIds = new Set(useUiStore.getState().offlineSources);
    const offline = project.sources
      .filter((s) => isFileSource(s) && offlineIds.has(s.id))
      .map((s) => ({ id: s.id, metadata: (s as { metadata: MediaMetadata | null }).metadata }));
    if (offline.length === 0) {
      useUiStore.getState().pushToast('info', 'Nothing is offline');
      return;
    }

    const plan = planRelink(offline, entries);
    if (plan.resolved.size > 0) {
      // One project transaction, so undo puts the whole relink back.
      useProjectStore.getState().apply((p) => ({
        ...p,
        sources: p.sources.map((s) => {
          const found = plan.resolved.get(s.id);
          return found && isFileSource(s) ? { ...s, path: found.path, kind: found.kind } : s;
        }),
      }));
      // Metadata is re-probed from the file that was actually found: a
      // re-encode legitimately has a different duration and size, and keeping
      // the old numbers would make the NEXT relink match against a fiction.
      for (const [id, found] of plan.resolved) {
        try {
          const metadata = await window.material.probeMedia(found.path);
          useProjectStore.getState().apply((p) => ({
            ...p,
            sources: p.sources.map((s) => (s.id === id ? { ...s, metadata } : s)),
          }));
        } catch {
          /* the file was there a moment ago; checkOfflineSources will catch it */
        }
      }
    }
    await checkOfflineSources();

    const stuck = plan.unresolved.length + plan.ambiguous.size;
    const parts = [`Relinked ${plan.resolved.size}`];
    if (plan.ambiguous.size > 0) parts.push(`${plan.ambiguous.size} ambiguous`);
    if (plan.unresolved.length > 0) parts.push(`${plan.unresolved.length} not found`);
    useUiStore.getState().pushToast(stuck > 0 ? 'error' : 'info', parts.join(' · '));
  } catch (err) {
    reportError('Relink media', err);
  }
}

/**
 * v0.8 — copy the show's media next to the project, so the folder IS the show.
 *
 * Files already at or below the project directory are left alone: they already
 * travel, and moving them would break a layout the user chose. Saving
 * afterwards is what turns the copies into relative paths.
 */
export async function collectMedia(): Promise<void> {
  const { project, projectPath } = useProjectStore.getState();
  if (!projectPath) {
    useUiStore.getState().pushToast('info', 'Save the project first — collect copies media beside it');
    return;
  }
  try {
    const paths = project.sources.filter(isFileSource).map((s) => s.path);
    if (paths.length === 0) {
      useUiStore.getState().pushToast('info', 'No media to collect');
      return;
    }
    const { moved, bytesCopied, missing } = await window.material.collectMedia(projectPath, paths);
    const count = Object.keys(moved).length;
    if (count === 0) {
      useUiStore
        .getState()
        .pushToast(
          missing.length > 0 ? 'error' : 'info',
          missing.length > 0
            ? `Nothing collected — ${missing.length} file(s) offline. Relink them first.`
            : 'Media already travels with the project',
        );
      return;
    }
    useProjectStore.getState().apply((p) => ({
      ...p,
      sources: p.sources.map((s) =>
        isFileSource(s) && moved[s.path] ? { ...s, path: moved[s.path] as string } : s,
      ),
    }));
    await saveProject();
    const mb = (bytesCopied / 1048576).toFixed(0);
    const note = missing.length > 0 ? ` · ${missing.length} offline, not collected` : '';
    useUiStore
      .getState()
      .pushToast(missing.length > 0 ? 'error' : 'info', `Collected ${count} file(s) · ${mb} MB${note}`);
  } catch (err) {
    reportError('Collect media', err);
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

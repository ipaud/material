import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProject, selectedLayerOf, type Project } from '@shared/schemas/project';
import type { MediaMetadata } from '@shared/schemas/media';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import {
  addCaptureSource,
  addGeneratorSource,
  checkOfflineSources,
  collectMedia,
  importMediaPaths,
  importMediaViaDialog,
  openProject,
  relinkSource,
  saveProject,
} from '@/projects/projectActions';

/**
 * The project actions behind File and the Library: save, open, import, relink and collect. These are
 * where a show can be lost (saved to the wrong place, overwritten, pointed at the wrong file), so the
 * tests follow what lands in the project and what the user is told.
 */

function meta(patch: Partial<MediaMetadata> = {}): MediaMetadata {
  return {
    kind: 'video',
    path: '/media/clip.mp4',
    fileName: 'clip.mp4',
    fileSize: 1024,
    durationSec: 10,
    width: 1280,
    height: 720,
    frameRate: 30,
    videoCodec: 'h264',
    audioCodec: null,
    audioChannels: null,
    sampleRate: null,
    ...patch,
  };
}

const bridge = {
  saveProjectDialog: vi.fn(),
  writeProject: vi.fn(async (_path: string, _project: unknown) => undefined),
  openProjectDialog: vi.fn(),
  readProject: vi.fn(),
  probeMedia: vi.fn(),
  openMediaDialog: vi.fn(),
  collectMedia: vi.fn(),
};

const toasts = () => useUiStore.getState().toasts.map((t) => `${t.kind}: ${t.message}`);
const project = () => useProjectStore.getState().project;

function load(p: Project, path: string | null = null) {
  if (path) useProjectStore.getState().loadProject(path, p);
  else useProjectStore.getState().apply(() => p);
}

beforeEach(() => {
  vi.stubGlobal('material', bridge);
  useProjectStore.getState().newProject();
  useUiStore.setState({ toasts: [], offlineSources: [], pendingRepair: null });
  bridge.probeMedia.mockImplementation(async (path: string) => meta({ path, fileName: path.split('/').pop() ?? '' }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('save', () => {
  it('asks where only the first time, then saves in place', async () => {
    bridge.saveProjectDialog.mockResolvedValue('/shows/a.material');
    await saveProject();
    await saveProject();
    expect(bridge.saveProjectDialog).toHaveBeenCalledOnce();
    expect(bridge.writeProject.mock.calls.map((c) => c[0])).toEqual(['/shows/a.material', '/shows/a.material']);
    expect(useProjectStore.getState().projectPath).toBe('/shows/a.material');
  });

  it('Save As always asks; cancelling writes nothing', async () => {
    load(createEmptyProject(), '/shows/a.material');
    bridge.saveProjectDialog.mockResolvedValue(null);
    await saveProject(true);
    expect(bridge.writeProject).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projectPath).toBe('/shows/a.material');
  });

  it('a failed write is reported and the project stays unsaved', async () => {
    load(createEmptyProject(), '/shows/a.material');
    useProjectStore.getState().apply((p) => ({ ...p, name: 'edited' }));
    bridge.writeProject.mockRejectedValueOnce(new Error('disk full'));
    await saveProject();
    expect(toasts().at(-1)).toMatch(/^error: .*disk full/);
    expect(useProjectStore.getState().dirty).toBe(true);
  });
});

describe('open', () => {
  it('cancelling the dialog leaves the current project alone', async () => {
    useProjectStore.getState().apply((p) => ({ ...p, name: 'mine' }));
    bridge.openProjectDialog.mockResolvedValue(null);
    await openProject();
    expect(project().name).toBe('mine');
    expect(bridge.readProject).not.toHaveBeenCalled();
  });

  it('a project that needs repair goes to the repair prompt instead of replacing the open one', async () => {
    useProjectStore.getState().apply((p) => ({ ...p, name: 'mine' }));
    bridge.openProjectDialog.mockResolvedValue('/shows/old.material');
    bridge.readProject.mockResolvedValue({ ok: false, path: '/shows/old.material', issues: ['bad'], repairable: true });
    await openProject();
    expect(project().name).toBe('mine');
    expect(useUiStore.getState().pendingRepair).toMatchObject({ path: '/shows/old.material', repairable: true });
  });

  it('says how many values a repair changed and checks the media', async () => {
    const p = { ...createEmptyProject(), sources: [{ id: 's1', kind: 'video' as const, path: '/gone.mp4', metadata: meta() }] };
    bridge.openProjectDialog.mockResolvedValue('/shows/fixed.material');
    bridge.readProject.mockResolvedValue({ ok: true, path: '/shows/fixed.material', project: p, repaired: ['a', 'b'] });
    bridge.probeMedia.mockRejectedValue(new Error('ENOENT'));
    await openProject();
    expect(useProjectStore.getState().projectPath).toBe('/shows/fixed.material');
    expect(toasts()).toEqual(['info: Repaired 2 values — save to keep the fix', 'error: 1 media file(s) offline']);
    expect(useUiStore.getState().offlineSources).toEqual(['s1']);
  });

  it('a failing dialog is reported, not thrown', async () => {
    bridge.openProjectDialog.mockRejectedValue(new Error('boom'));
    await expect(openProject()).resolves.toBeUndefined();
    expect(toasts().at(-1)).toMatch(/^error: .*boom/);
  });
});

describe('offline media', () => {
  it('only files are probed: generators and live inputs have nothing to lose', async () => {
    load({
      ...createEmptyProject(),
      sources: [
        { id: 'g', kind: 'generator', generator: 'noise', params: {}, seed: 1 },
        { id: 'c', kind: 'camera', deviceId: null },
        { id: 'f', kind: 'video', path: '/media/clip.mp4', metadata: meta() },
      ],
    });
    await checkOfflineSources();
    expect(bridge.probeMedia.mock.calls).toEqual([['/media/clip.mp4']]);
    expect(useUiStore.getState().offlineSources).toEqual([]);
    expect(toasts()).toEqual([]);
  });

  it('relinking points the source at the new file with its own metadata', async () => {
    load({ ...createEmptyProject(), sources: [{ id: 'f', kind: 'video', path: '/old/clip.mp4', metadata: meta() }] });
    bridge.openMediaDialog.mockResolvedValue(['/new/still.png']);
    bridge.probeMedia.mockImplementation(async (path: string) => meta({ kind: 'image', path, width: 640, height: 480 }));
    await relinkSource('f');
    expect(project().sources[0]).toMatchObject({ path: '/new/still.png', kind: 'image', metadata: { width: 640 } });

    bridge.openMediaDialog.mockResolvedValue([]);
    await relinkSource('f');
    expect(project().sources[0]).toMatchObject({ path: '/new/still.png' });
  });
});

describe('collect media', () => {
  const show = () => ({
    ...createEmptyProject(),
    sources: [
      { id: 'a', kind: 'video' as const, path: '/elsewhere/a.mp4', metadata: meta() },
      { id: 'g', kind: 'generator' as const, generator: 'noise', params: {}, seed: 1 },
    ],
  });

  it('needs a saved project to know where to copy', async () => {
    load(show());
    await collectMedia();
    expect(bridge.collectMedia).not.toHaveBeenCalled();
    expect(toasts()).toEqual(['info: Save the project first — collect copies media beside it']);
  });

  it('repoints the copied files and saves, so the paths become relative on disk', async () => {
    load(show(), '/shows/s.material');
    bridge.collectMedia.mockResolvedValue({ moved: { '/elsewhere/a.mp4': '/shows/media/a.mp4' }, bytesCopied: 5 * 1048576, missing: [] });
    await collectMedia();
    expect(bridge.collectMedia).toHaveBeenCalledWith('/shows/s.material', ['/elsewhere/a.mp4']);
    expect(project().sources[0]).toMatchObject({ path: '/shows/media/a.mp4' });
    expect(bridge.writeProject).toHaveBeenCalledWith('/shows/s.material', expect.objectContaining({ sources: expect.any(Array) }));
    expect(toasts().at(-1)).toBe('info: Collected 1 file(s) · 5 MB');
  });

  it('tells apart "already travels" from "offline, relink first"', async () => {
    load(show(), '/shows/s.material');
    bridge.collectMedia.mockResolvedValue({ moved: {}, bytesCopied: 0, missing: [] });
    await collectMedia();
    bridge.collectMedia.mockResolvedValue({ moved: {}, bytesCopied: 0, missing: ['/elsewhere/a.mp4'] });
    await collectMedia();
    expect(toasts()).toEqual([
      'info: Media already travels with the project',
      'error: Nothing collected — 1 file(s) offline. Relink them first.',
    ]);
    expect(bridge.writeProject).not.toHaveBeenCalled();
  });

  it('a show with only generators has nothing to collect', async () => {
    load({ ...show(), sources: [{ id: 'g', kind: 'generator', generator: 'noise', params: {}, seed: 1 }] }, '/shows/s.material');
    await collectMedia();
    expect(toasts()).toEqual(['info: No media to collect']);
  });
});

describe('import', () => {
  it('the first picture becomes the selected layer’s source and sets the canvas size', async () => {
    await importMediaPaths(['/media/a.mp4', '/media/b.mp4']);
    const p = project();
    expect(p.sources.map((s) => ('path' in s ? s.path : s.id))).toEqual(['/media/a.mp4', '/media/b.mp4']);
    expect(selectedLayerOf(p).sourceId).toBe(p.sources[0]!.id);
    expect(p.composition).toMatchObject({ width: 1280, height: 720 });
    expect(selectedLayerOf(p).technique?.techniqueId).toBe('mosaic');
  });

  it('the first song becomes the soundtrack; a duplicate path is not added twice', async () => {
    bridge.probeMedia.mockImplementation(async (path: string) => meta({ kind: 'audio', path, width: null, height: null }));
    await importMediaPaths(['/media/song.mp3', '/media/song.mp3']);
    const p = project();
    expect(p.sources).toHaveLength(1);
    expect(p.composition.audioSourceId).toBe(p.sources[0]!.id);
  });

  it('one unreadable file does not stop the rest', async () => {
    bridge.probeMedia.mockImplementation(async (path: string) => {
      if (path.endsWith('.bad')) throw new Error('not media');
      return meta({ path });
    });
    await importMediaPaths(['/media/x.bad', '/media/ok.mp4']);
    expect(project().sources).toHaveLength(1);
    expect(toasts().at(-1)).toMatch(/^error: Import x\.bad/);
  });

  it('from the dialog: nothing chosen imports nothing', async () => {
    bridge.openMediaDialog.mockResolvedValue([]);
    await importMediaViaDialog();
    expect(bridge.probeMedia).not.toHaveBeenCalled();
    bridge.openMediaDialog.mockRejectedValue(new Error('no window'));
    await importMediaViaDialog();
    expect(toasts().at(-1)).toMatch(/no window/);
  });
});

describe('live and procedural sources', () => {
  it('one camera per project: asking again reselects it', () => {
    expect(addCaptureSource('camera')).toBe(true);
    const id = project().sources[0]!.id;
    useProjectStore.getState().apply((p) => p); // unrelated edit in between
    expect(addCaptureSource('camera')).toBe(true);
    expect(project().sources.filter((s) => s.kind === 'camera')).toHaveLength(1);
    expect(selectedLayerOf(project()).sourceId).toBe(id);

    addCaptureSource('screen');
    expect(project().sources.map((s) => s.kind)).toEqual(['camera', 'screen']);
    expect(selectedLayerOf(project()).technique).toBeTruthy();
  });

  it('an unknown generator is refused', () => {
    expect(addGeneratorSource('does-not-exist')).toBe(false);
    expect(project().sources).toEqual([]);
    expect(addGeneratorSource('noise')).toBe(true);
    expect(project().sources[0]).toMatchObject({ kind: 'generator', generator: 'noise' });
  });
});

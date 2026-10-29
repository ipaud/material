import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProject, emptyLayer, type Project } from '@shared/schemas/project';
import type * as EngineBridge from '@/rendering/engineBridge';
import type * as ProjectStore from '@/state/projectStore';
import type * as UiStore from '@/state/uiStore';
import type * as MediaProxy from '@/sources/mediaProxy';

/**
 * The bridge between the document and the engine, for what a layer is MADE of: loading and
 * releasing sources, the races between loads, failures, proxies, which video drives the clock,
 * and the soundtrack. Sources, managers and the engine are recording fakes; the bridge is real.
 */

type Deferred = { resolve: () => void; reject: (e: unknown) => void };

const h = vi.hoisted(() => {
  const branches = new Map<string, Record<string, ReturnType<typeof vi.fn>>>();
  const branchFor = (id: string) => {
    if (!branches.has(id)) {
      const calls: Record<string, ReturnType<typeof vi.fn>> = {};
      branches.set(
        id,
        new Proxy(calls, {
          get(t, key: string) {
            return (t[key] ??= vi.fn());
          },
        }),
      );
    }
    return branches.get(id)!;
  };
  const engine = new Proxy({} as Record<string, unknown>, {
    get(t, key: string) {
      if (key === 'branchFor') return (id: string) => (h.liveLayers.has(id) ? branchFor(id) : null);
      if (key === 'currentTimeSec') return 0;
      return (t[key] ??= vi.fn());
    },
  });
  const created: { kind: string; path: string; pending: Deferred; disposed: boolean; status: string; video: object }[] = [];
  function fakeSource(kind: string) {
    return class {
      pending!: Deferred;
      disposed = false;
      status = 'connecting';
      video = { tag: 'video' };
      constructor(readonly path: string) {
        created.push(this as never);
        (this as unknown as { kind: string }).kind = kind;
      }
      load() {
        return new Promise<void>((resolve, reject) => {
          this.pending = {
            resolve: () => {
              this.status = 'live';
              resolve();
            },
            reject,
          };
        });
      }
      texture() {
        return `texture:${this.path}`;
      }
      temporalSource() {
        return `temporal:${this.path}`;
      }
      dispose() {
        this.disposed = true;
      }
    };
  }
  return {
    liveLayers: new Set<string>(),
    branches,
    engine,
    created,
    FileImageSource: fakeSource('image'),
    FileVideoSource: fakeSource('video'),
    generators: [] as { kind: string; seed: number; disposed: boolean }[],
    playback: {
      currentVideo: null as unknown,
      hasVideo: false,
      attachVideo: vi.fn((v: unknown) => {
        h.playback.currentVideo = v;
        h.playback.hasVideo = true;
      }),
      detachVideo: vi.fn(() => {
        h.playback.currentVideo = null;
        h.playback.hasVideo = false;
      }),
      seek: vi.fn(),
      audioChanged: vi.fn(),
    },
    audioEngine: { load: vi.fn(async () => undefined), unload: vi.fn() },
    camera: { attach: vi.fn(), detach: vi.fn(), isLive: vi.fn(() => false) },
    capture: { attach: vi.fn(), detach: vi.fn(), isLive: vi.fn(() => false) },
    setProxy: vi.fn(),
  };
});

vi.mock('@/rendering/RenderEngine', () => ({ engine: h.engine }));
vi.mock('@/sources/FileImageSource', () => ({ FileImageSource: h.FileImageSource }));
vi.mock('@/sources/FileVideoSource', () => ({ FileVideoSource: h.FileVideoSource }));
vi.mock('@/sources/generators/GeneratorSource', () => ({
  GeneratorSource: class {
    disposed = false;
    constructor(
      readonly kind: string,
      readonly seed: number,
    ) {
      h.generators.push(this);
    }
    texture() {
      return 'texture:generator';
    }
    temporalSource() {
      return 'temporal:generator';
    }
    dispose() {
      this.disposed = true;
    }
  },
}));
vi.mock('@/playback/PlaybackController', () => ({ playback: h.playback }));
vi.mock('@/audio/AudioEngine', () => ({ audioEngine: h.audioEngine }));
vi.mock('@/materials/materialTextureSlot', () => ({ MaterialTextureSlot: class { sync() {} reset() {} } }));
vi.mock('@/sources/mediaProxy', async (orig) => ({ ...(await orig<object>()), setProxy: h.setProxy }));
vi.mock('@/sources/cameraManager', async (orig) => ({ ...(await orig<object>()), cameraManager: h.camera }));
vi.mock('@/sources/captureManager', async (orig) => ({ ...(await orig<object>()), captureManager: h.capture }));

let bridge: typeof EngineBridge;
let projectStore: typeof ProjectStore;
let uiStore: typeof UiStore;
let mediaProxy: typeof MediaProxy;

const settle = () => new Promise((r) => setTimeout(r, 0));
const branch = (id: string) => h.branches.get(id)!;
const store = () => projectStore.useProjectStore.getState();

function show(patch: (p: Project) => Project): void {
  const base = createEmptyProject();
  const p = patch({ ...base, layers: [{ ...base.layers[0]!, id: 'L1' }], selectedLayerId: 'L1' });
  for (const l of p.layers) h.liveLayers.add(l.id);
  store().loadProject('/show.material', p);
  bridge.resyncFromStore();
}

const withSource = (layerId: string, sourceId: string | null) => (p: Project): Project => ({
  ...p,
  layers: p.layers.map((l) => (l.id === layerId ? { ...l, sourceId } : l)),
});

const FILES = [
  { id: 'img', kind: 'image' as const, path: '/m/a.png', metadata: null },
  { id: 'img2', kind: 'image' as const, path: '/m/b.png', metadata: null },
  { id: 'vid', kind: 'video' as const, path: '/m/clip.mov', metadata: null },
  { id: 'gen', kind: 'generator' as const, generator: 'noise', params: { speed: 1 }, seed: 3 },
  { id: 'song', kind: 'audio' as const, path: '/m/song.wav', metadata: null },
];

beforeEach(async () => {
  vi.resetModules();
  h.branches.clear();
  h.liveLayers.clear();
  h.created.length = 0;
  h.generators.length = 0;
  h.playback.currentVideo = null;
  h.playback.hasVideo = false;
  vi.stubGlobal('material', { findProxy: vi.fn(async () => null) });
  bridge = await import('@/rendering/engineBridge');
  projectStore = await import('@/state/projectStore');
  uiStore = await import('@/state/uiStore');
  mediaProxy = await import('@/sources/mediaProxy');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const toasts = () => uiStore.useUiStore.getState().toasts.map((t) => t.message);

describe('file sources', () => {
  it('an image is shown once it has loaded, with its temporal source', async () => {
    show((p) => withSource('L1', 'img')({ ...p, sources: FILES }));
    expect(branch('L1').setSource).not.toHaveBeenCalledWith('texture:/m/a.png');
    h.created[0]!.pending.resolve();
    await settle();
    expect(branch('L1').setSource).toHaveBeenLastCalledWith('texture:/m/a.png');
    expect(branch('L1').setTemporalSource).toHaveBeenLastCalledWith('temporal:/m/a.png');
  });

  it('a slow load that finishes after the layer moved on is thrown away', async () => {
    show((p) => withSource('L1', 'img')({ ...p, sources: FILES }));
    const first = h.created[0]!;
    store().apply(withSource('L1', 'img2'));
    bridge.resyncFromStore();
    h.created[1]!.pending.resolve();
    first.pending.resolve();
    await settle();
    expect(first.disposed).toBe(true);
    expect(branch('L1').setSource).toHaveBeenLastCalledWith('texture:/m/b.png');
  });

  it('an unchanged source is not reloaded on every sync', () => {
    show((p) => withSource('L1', 'img')({ ...p, sources: FILES }));
    bridge.resyncFromStore();
    store().apply((p) => ({ ...p, name: 'renamed' }));
    bridge.resyncFromStore();
    expect(h.created).toHaveLength(1);
  });

  it('a failed image is reported and the layer goes back to no source', async () => {
    show((p) => withSource('L1', 'img')({ ...p, sources: FILES }));
    h.created[0]!.pending.reject(new Error('decode failed'));
    await settle();
    expect(branch('L1').setSource).toHaveBeenLastCalledWith(null);
    expect(h.created[0]!.disposed).toBe(true);
    expect(toasts().at(-1)).toMatch(/decode failed/);
  });
});

describe('video and the transport clock', () => {
  it('the first live video drives the clock; removing it detaches', async () => {
    show((p) => withSource('L1', 'vid')({ ...p, sources: FILES }));
    expect(h.playback.attachVideo).not.toHaveBeenCalled(); // still connecting
    h.created[0]!.pending.resolve();
    await settle();
    expect(h.playback.attachVideo).toHaveBeenCalledWith(h.created[0]!.video);
    expect(h.playback.seek).toHaveBeenCalledWith(0);

    store().apply(withSource('L1', 'gen'));
    bridge.resyncFromStore();
    expect(h.created[0]!.disposed).toBe(true);
    expect(h.playback.detachVideo).toHaveBeenCalled();
  });

  it('a file that is gone says "Media offline" and is not retried every frame', async () => {
    show((p) => withSource('L1', 'vid')({ ...p, sources: FILES }));
    h.created[0]!.pending.reject(new Error('file missing'));
    await settle();
    expect(toasts().at(-1)).toMatch(/^Media offline/);
    bridge.resyncFromStore();
    expect(h.created).toHaveLength(1);
  });

  it('a codec the viewer cannot play reuses an existing proxy and loads again', async () => {
    (globalThis as unknown as { material: { findProxy: ReturnType<typeof vi.fn> } }).material.findProxy.mockResolvedValue('/proxies/clip.mp4');
    show((p) => withSource('L1', 'vid')({ ...p, sources: FILES }));
    h.created[0]!.pending.reject(new mediaProxy.UnsupportedMediaError('/m/clip.mov', 'prores'));
    await settle();
    await settle();
    expect(h.setProxy).toHaveBeenCalledWith('/m/clip.mov', '/proxies/clip.mp4');
    expect(h.created).toHaveLength(2); // retried
  });

  it('without a proxy it asks before transcoding', async () => {
    show((p) => withSource('L1', 'vid')({ ...p, sources: FILES }));
    h.created[0]!.pending.reject(new mediaProxy.UnsupportedMediaError('/m/clip.mov', 'hevc'));
    await settle();
    await settle();
    expect(uiStore.useUiStore.getState().pendingProxy).toEqual({ path: '/m/clip.mov', codec: 'hevc' });
  });
});

describe('generators and layers', () => {
  it('a generator is built once; later syncs only push its parameters', () => {
    show((p) => withSource('L1', 'gen')({ ...p, sources: FILES }));
    store().apply((p) => ({ ...p, sources: p.sources.map((s) => (s.id === 'gen' ? { ...s, params: { speed: 2 } } : s)) }));
    bridge.resyncFromStore();
    expect(h.generators).toHaveLength(1);
    expect(branch('L1').setSourceParams).toHaveBeenLastCalledWith({ speed: 2 });
    expect(branch('L1').setGeneratorSource).toHaveBeenCalledWith(h.generators[0]);
  });

  it('a new seed is a new generator, and the old one is released', () => {
    show((p) => withSource('L1', 'gen')({ ...p, sources: FILES }));
    store().apply((p) => ({ ...p, sources: p.sources.map((s) => (s.id === 'gen' ? { ...s, seed: 9 } : s)) }));
    bridge.resyncFromStore();
    expect(h.generators.map((g) => [g.seed, g.disposed])).toEqual([
      [3, true],
      [9, false],
    ]);
  });

  it('deleting a layer releases what it owned', () => {
    show((p) => ({
      ...p,
      sources: FILES,
      layers: [{ ...p.layers[0]!, sourceId: 'gen' }, { ...emptyLayer('L2', 'B'), sourceId: 'img' }],
    }));
    store().apply((p) => ({ ...p, layers: p.layers.filter((l) => l.id !== 'L2') }));
    bridge.resyncFromStore();
    expect(h.created[0]!.disposed).toBe(true);
    expect(h.generators[0]!.disposed).toBe(false);
  });

  it('an export following a Look re-syncs generator layers only', () => {
    show((p) => ({
      ...p,
      sources: FILES,
      layers: [{ ...p.layers[0]!, sourceId: 'gen' }, { ...emptyLayer('L2', 'B'), sourceId: 'img' }],
    }));
    const project = store().project;
    bridge.syncLayersForExport({
      ...project,
      sources: [...project.sources, { id: 'gen2', kind: 'generator', generator: 'noise', params: {}, seed: 4 }],
      layers: project.layers.map((l) => (l.id === 'L1' ? { ...l, sourceId: 'gen2' } : { ...l, sourceId: 'img2' })),
    });
    expect(h.generators.map((g) => g.seed)).toEqual([3, 4]);
    expect(h.created.map((c) => c.path)).toEqual(['/m/a.png']); // the file layer was left as it was
  });
});

describe('live inputs and sound', () => {
  it('the camera is attached to the first layer showing it and released when none does', () => {
    show((p) => ({ ...p, sources: [{ id: 'cam', kind: 'camera', deviceId: 'dev-1' }], layers: [{ ...p.layers[0]!, sourceId: 'cam' }] }));
    expect(h.camera.attach).toHaveBeenCalledWith('cam', 'dev-1');
    store().apply(withSource('L1', null));
    bridge.resyncFromStore();
    expect(h.camera.detach).toHaveBeenCalled();
  });

  it('a screen source attaches capture for its display', () => {
    show((p) => ({ ...p, sources: [{ id: 'scr', kind: 'screen', displayId: 2 }], layers: [{ ...p.layers[0]!, sourceId: 'scr' }] }));
    expect(h.capture.attach).toHaveBeenCalledWith('scr', 'screen', 2);
  });

  it('the soundtrack loads once and unloads when removed', async () => {
    show((p) => ({ ...p, sources: FILES, composition: { ...p.composition, audioSourceId: 'song' } }));
    bridge.resyncFromStore();
    await settle();
    expect(h.audioEngine.load).toHaveBeenCalledExactlyOnceWith('/m/song.wav');
    expect(h.playback.audioChanged).toHaveBeenCalled();

    store().apply((p) => ({ ...p, composition: { ...p.composition, audioSourceId: null } }));
    bridge.resyncFromStore();
    expect(h.audioEngine.unload).toHaveBeenCalled();
  });
});

describe('connecting and disconnecting', () => {
  it('follows the stores while connected and releases everything on cleanup', () => {
    show((p) => withSource('L1', 'gen')({ ...p, sources: FILES }));
    const stop = bridge.startEngineBridge();
    store().apply((p) => ({ ...p, sources: p.sources.map((s) => (s.id === 'gen' ? { ...s, seed: 5 } : s)) }));
    expect(h.generators.map((g) => g.seed)).toEqual([3, 5]); // no manual resync needed

    uiStore.useUiStore.getState().setShowOriginal?.(true);
    stop();
    expect(h.generators.every((g) => g.disposed)).toBe(true);
    expect((h.engine as Record<string, ReturnType<typeof vi.fn>>).setParamTransform).toHaveBeenLastCalledWith(null);
  });
});

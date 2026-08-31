import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisplayCaptureSource } from '@/sources/DisplayCaptureSource';
import {
  createEmptyProject,
  isFileSource,
  isLiveSource,
  parseProject,
  projectSchema,
  type Project,
} from '@shared/schemas/project';
import { PROJECT_FORMAT_VERSION } from '@shared/constants/app';

/**
 * Phase 18E — screen/window capture. jsdom has no display capture; the media
 * layer is mocked at the navigator boundary, everything above it is real.
 */

class FakeTrack {
  readyState = 'live';
  onended: (() => void) | null = null;
  stopped = false;
  constructor(private settings: Record<string, unknown>) {}
  getSettings() {
    return this.settings;
  }
  stop() {
    this.stopped = true;
    this.readyState = 'ended';
  }
}

class FakeStream {
  constructor(readonly track: FakeTrack) {}
  getVideoTracks() {
    return [this.track];
  }
  getAudioTracks() {
    return [];
  }
  getTracks() {
    return [this.track];
  }
}

function mockDisplayMedia(options: { fail?: string; width?: number; height?: number } = {}) {
  const track = new FakeTrack({
    width: options.width ?? 3024,
    height: options.height ?? 1964,
    frameRate: 30,
    displaySurface: 'monitor',
  });
  const stream = new FakeStream(track);
  const getDisplayMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
    if (options.fail) throw new DOMException('denied', options.fail);
    expect(constraints.audio).toBe(false); // system audio is never requested
    return stream as unknown as MediaStream;
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia, getUserMedia: vi.fn(), enumerateDevices: vi.fn(async () => []) },
  });
  return { track, stream, getDisplayMedia };
}

function makePlayable() {
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
    configurable: true,
    get() {
      return 3024;
    },
  });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
    configurable: true,
    get() {
      return 1964;
    },
  });
  Object.defineProperty(HTMLVideoElement.prototype, 'readyState', {
    configurable: true,
    get() {
      return 2;
    },
  });
  HTMLVideoElement.prototype.play = vi.fn(async () => undefined);
  HTMLVideoElement.prototype.pause = vi.fn();
}

beforeEach(() => makePlayable());
afterEach(() => vi.restoreAllMocks());

describe('DisplayCaptureSource runtime', () => {
  it('declares honest live capabilities for both kinds', () => {
    for (const kind of ['live-screen', 'live-window'] as const) {
      const src = new DisplayCaptureSource(kind);
      expect(src.kind).toBe(kind);
      expect(src.caps.seekable).toBe(false);
      expect(src.caps.deterministic).toBe(false);
      expect(src.caps.exportable).toBe(false);
      expect(src.caps.duration).toBeNull();
      expect(src.caps.audio).toBe(false);
      expect(src.caps.temporalHistory).toBe('realtime');
      src.dispose();
    }
  });

  it('acquires video-only, reaches live, exposes texture and metadata', async () => {
    const { getUserMedia } = { getUserMedia: null }; // clarity: never used here
    const { getDisplayMedia } = mockDisplayMedia();
    const src = new DisplayCaptureSource('live-screen');
    const seen: string[] = [];
    src.onStatus((s) => seen.push(s));
    await src.connect();
    expect(src.status).toBe('live');
    expect(seen).toEqual(['connecting', 'live']);
    expect(src.texture()).not.toBeNull();
    expect(src.width).toBe(3024);
    expect(src.frameRate).toBe(30);
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(getDisplayMedia.mock.calls[0]?.[0]).toEqual({ video: true, audio: false });
    // 18E: current frame only — no temporal history until 18F.
    expect(src.temporalSource()).toBeNull();
    expect(getUserMedia).toBeNull();
    src.dispose();
  });

  it('maps failures to explicit states', async () => {
    mockDisplayMedia({ fail: 'NotAllowedError' });
    const denied = new DisplayCaptureSource('live-screen');
    await expect(denied.connect()).rejects.toThrow();
    expect(denied.status).toBe('permission-denied');

    mockDisplayMedia({ fail: 'NotFoundError' });
    const missing = new DisplayCaptureSource('live-window');
    await expect(missing.connect()).rejects.toThrow();
    expect(missing.status).toBe('device-lost');
  });

  it('the captured window closing flips to device-lost, once, never recaptures', async () => {
    const { track, getDisplayMedia } = mockDisplayMedia();
    const src = new DisplayCaptureSource('live-window');
    const seen: string[] = [];
    src.onStatus((s) => seen.push(s));
    await src.connect();
    track.onended?.();
    track.onended?.();
    expect(src.status).toBe('device-lost');
    expect(seen.filter((s) => s === 'device-lost')).toHaveLength(1);
    // ended must never trigger another acquisition by itself (§28)
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    src.dispose();
  });

  it('dispose stops every track and kills the texture (no OS indicator left)', async () => {
    const { track } = mockDisplayMedia();
    const src = new DisplayCaptureSource('live-screen');
    await src.connect();
    expect(src.texture()).not.toBeNull();
    src.dispose();
    expect(track.stopped).toBe(true);
    expect(src.texture()).toBeNull();
    expect(src.status).toBe('offline');
  });

  it('a dispose that lands mid-connect still stops the acquired stream', async () => {
    const { track } = mockDisplayMedia();
    const src = new DisplayCaptureSource('live-screen');
    const pending = src.connect();
    src.dispose();
    await pending.catch(() => undefined);
    expect(track.stopped).toBe(true);
    expect(src.texture()).toBeNull();
  });

  it('50 connect/dispose cycles leave no live tracks behind', async () => {
    for (let i = 0; i < 50; i++) {
      const { track } = mockDisplayMedia();
      const src = new DisplayCaptureSource(i % 2 ? 'live-screen' : 'live-window');
      await src.connect();
      src.dispose();
      expect(track.stopped).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Schema — additive inside v3
// ---------------------------------------------------------------------------

describe('schema v3 — screen/window are additive variants', () => {
  const projectWith = (sources: Project['sources']): Project => {
    const p = createEmptyProject('cap');
    return {
      ...p,
      sources,
      composition: { ...p.composition, sourceId: sources[0]?.id ?? null },
    };
  };

  it('18E did NOT bump the format version', () => {
    // 18E was additive inside v3. v0.6 bumped to v4 for layers, which is a
    // different reason — screen/window still add no version of their own.
    expect(PROJECT_FORMAT_VERSION).toBe(4);
  });

  it('screen refs round-trip; displayId nullable', () => {
    const reloaded = parseProject(
      JSON.parse(
        JSON.stringify(
          projectSchema.parse(projectWith([{ id: 's1', kind: 'screen', displayId: 1 }])),
        ),
      ),
    );
    expect(reloaded.sources[0]).toEqual({ id: 's1', kind: 'screen', displayId: 1 });
    const noDisplay = parseProject(
      JSON.parse(JSON.stringify({ ...projectWith([]), sources: [{ id: 's2', kind: 'screen' }] })),
    );
    expect(noDisplay.sources[0]).toEqual({ id: 's2', kind: 'screen', displayId: null });
  });

  it('window refs persist ONLY the human hint — never an OS capture id', () => {
    const reloaded = parseProject(
      JSON.parse(
        JSON.stringify(
          projectSchema.parse(
            projectWith([{ id: 'w1', kind: 'window', titleHint: 'Safari — Vimeo' }]),
          ),
        ),
      ),
    );
    expect(reloaded.sources[0]).toEqual({ id: 'w1', kind: 'window', titleHint: 'Safari — Vimeo' });
    const json = JSON.stringify(projectSchema.parse(projectWith([
      { id: 'w2', kind: 'window', titleHint: null },
    ])).sources);
    for (const banned of ['sourceId', 'captureId', 'windowId', 'stream', 'permission']) {
      expect(json.includes(`"${banned}"`), `must not persist ${banned}`).toBe(false);
    }
  });

  it('guards classify live vs file sources', () => {
    const p = projectWith([
      { id: 's', kind: 'screen', displayId: null },
      { id: 'w', kind: 'window', titleHint: null },
      { id: 'c', kind: 'camera', deviceId: null },
    ]);
    for (const s of p.sources) {
      expect(isLiveSource(s)).toBe(true);
      expect(isFileSource(s)).toBe(false);
    }
  });

  it('v2 fixture still opens and reaches v3 unchanged (no migration churn)', () => {
    const v2 = JSON.parse(
      readFileSync(join(__dirname, 'fixtures', 'project-v2-pattern.json'), 'utf8'),
    ) as Record<string, unknown>;
    const migrated = parseProject(v2);
    expect(migrated.version).toBe(4);
    expect(migrated.sources.every(isFileSource)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Structural invariants (§91)
// ---------------------------------------------------------------------------

describe('structural invariants — 18E', () => {
  const read = (...parts: string[]) => readFileSync(join(__dirname, '..', ...parts), 'utf8');
  const code = (...parts: string[]) =>
    read(...parts)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('getDisplayMedia lives ONLY in the two gated runtimes', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(__dirname, '..', dir), { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const path = join(dir, entry.name);
          if (path.endsWith('sources/DisplayCaptureSource.ts')) continue;
          if (path.endsWith('output-window/outputCaptureSource.ts')) continue;
          if (code(path).includes('getDisplayMedia')) offenders.push(path);
        }
      }
    };
    walk('src');
    expect(offenders).toEqual([]);
  });

  it('desktopCapturer never reaches renderer code or the preload', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(__dirname, '..', dir), { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const path = join(dir, entry.name);
          if (code(path).includes('desktopCapturer')) offenders.push(path);
        }
      }
    };
    walk('src');
    walk(join('electron', 'preload'));
    expect(offenders).toEqual([]);
  });

  it('the Output window has no picker: no enumeration, no intent, no selection UI', () => {
    for (const file of readdirSync(join(__dirname, '..', 'src', 'output-window'))) {
      const src = code('src', 'output-window', file);
      expect(src.includes('listCaptureWindows'), `${file} must not enumerate`).toBe(false);
      expect(src.includes('setCaptureIntent'), `${file} must not arm the gate`).toBe(false);
      expect(src.includes('outputDisplays'), `${file} must not list displays`).toBe(false);
    }
  });

  it('both capture call sites are video-only', () => {
    for (const file of [
      ['src', 'sources', 'DisplayCaptureSource.ts'],
      ['src', 'output-window', 'outputCaptureSource.ts'],
    ] as const) {
      const src = code(...file);
      expect(src.includes('audio: false')).toBe(true);
      expect(src.includes('audio: true')).toBe(false);
    }
  });

  it('main gate: display handler exists, deny-by-default, rejoin bounded by grant', () => {
    const main = read('electron', 'main', 'index.ts');
    expect(main.includes('setDisplayMediaRequestHandler')).toBe(true);
    expect(main.includes('captureIntentTarget()')).toBe(true);
    expect(main.includes('grantedCaptureSource()')).toBe(true);
    expect(main.includes('isOutputFrame')).toBe(true);
    // No system picker — the Output rejoin requirement forbids it (ADR).
    expect(main.includes('useSystemPicker')).toBe(false);
    const handlers = read('electron', 'ipc', 'handlers.ts');
    // Disarming must also revoke the Output's rejoin authorization.
    expect(handlers.includes('captureIntent = null;')).toBe(true);
    expect(handlers.includes('grantedCapture = null;')).toBe(true);
  });

  it('no pixel transport in the new capture path', () => {
    for (const file of ['outputCaptureSource.ts', 'replica.ts']) {
      const src = code('src', 'output-window', file);
      for (const banned of ['captureStream', 'toDataURL', 'ImageBitmap', 'getImageData']) {
        expect(src.includes(banned), `${file}: ${banned}`).toBe(false);
      }
    }
  });

  it('live descriptor is published only while the editor capture is LIVE', () => {
    const bridge = code('src', 'rendering', 'engineBridge.ts');
    expect(bridge.includes('captureManager.isLive()')).toBe(true);
  });

  it('app teardown releases capture as well as camera', () => {
    const app = code('src', 'app', 'App.tsx');
    expect(app.includes('captureManager.detach()')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Undo/redo — capture selection is config, never a runtime action
// ---------------------------------------------------------------------------

describe('undo/redo capture config', () => {
  it('adding a window source undoes/redoes as pure config at IDLE', async () => {
    const { getDisplayMedia } = mockDisplayMedia();
    const { useProjectStore } = await import('@/state/projectStore');
    const { captureManager, useCaptureStore } = await import('@/sources/captureManager');
    const store = useProjectStore.getState();
    const before = store.project.sources.length;

    store.apply((p) => ({
      ...p,
      sources: [...p.sources, { id: 'win-u', kind: 'window', titleHint: 'Safari' }],
    }));
    captureManager.attach('win-u', 'window', null);
    expect(useCaptureStore.getState().status).toBe('idle');
    expect(getDisplayMedia.mock.calls).toHaveLength(0);

    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.sources).toHaveLength(before);
    useProjectStore.getState().redo();
    expect(useProjectStore.getState().project.sources.at(-1)).toEqual({
      id: 'win-u',
      kind: 'window',
      titleHint: 'Safari',
    });
    expect(useCaptureStore.getState().status).toBe('idle');
    expect(getDisplayMedia.mock.calls).toHaveLength(0);
    captureManager.detach();
  });

  it('START with no chosen window is a no-op (never captures something arbitrary)', async () => {
    const { getDisplayMedia } = mockDisplayMedia();
    const { captureManager, useCaptureStore } = await import('@/sources/captureManager');
    captureManager.attach('win-x', 'window', null);
    await captureManager.start();
    expect(useCaptureStore.getState().status).toBe('idle');
    expect(getDisplayMedia.mock.calls).toHaveLength(0);
    captureManager.detach();
  });
});

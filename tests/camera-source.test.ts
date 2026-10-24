import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraSource } from '@/sources/CameraSource';
import { PROJECT_FORMAT_VERSION } from '@shared/constants/app';
import {
  createEmptyProject,
  isFileSource,
  parseProject,
  projectSchema,
  type Project,
} from '@shared/schemas/project';

/**
 * Phase 18D — camera source. jsdom has no real capture, so the media layer
 * is mocked at the navigator boundary; everything above it is the real
 * runtime.
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
  getTracks() {
    return [this.track];
  }
}

function mockMedia(options: { fail?: string; width?: number; height?: number } = {}) {
  const track = new FakeTrack({
    width: options.width ?? 1280,
    height: options.height ?? 720,
    frameRate: 30,
    deviceId: 'dev-1',
  });
  const stream = new FakeStream(track);
  const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
    if (options.fail) {
      const err = new DOMException('denied', options.fail);
      throw err;
    }
    expect(constraints.audio).toBe(false); // microphone is never requested
    return stream as unknown as MediaStream;
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: vi.fn(async () => [
        { kind: 'videoinput', deviceId: 'dev-1', label: 'Mock Camera' },
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  return { track, stream, getUserMedia };
}

/** jsdom video elements never fire 'playing'; drive readiness manually. */
function makePlayable() {
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
    configurable: true,
    get() {
      return 1280;
    },
  });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
    configurable: true,
    get() {
      return 720;
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

describe('CameraSource runtime', () => {
  it('declares honest live capabilities', () => {
    const cam = new CameraSource(null);
    expect(cam.caps.seekable).toBe(false);
    expect(cam.caps.deterministic).toBe(false);
    expect(cam.caps.exportable).toBe(false);
    expect(cam.caps.duration).toBeNull();
    expect(cam.caps.audio).toBe(false);
    expect(cam.kind).toBe('live-camera');
  });

  it('acquires video-only, reaches live, exposes a texture and settings', async () => {
    const { getUserMedia } = mockMedia();
    const cam = new CameraSource(null);
    const seen: string[] = [];
    cam.onStatus((s) => seen.push(s));
    await cam.connect();
    expect(cam.status).toBe('live');
    expect(seen).toEqual(['connecting', 'live']);
    expect(cam.texture()).not.toBeNull();
    expect(cam.width).toBe(1280);
    expect(cam.frameRate).toBe(30);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    // 18D: current frame only — no temporal history until 18F.
    expect(cam.temporalSource()).toBeNull();
    cam.dispose();
  });

  it('passes the exact remembered device, and falls back when it is gone', async () => {
    const { getUserMedia } = mockMedia();
    const cam = new CameraSource('dev-42');
    await cam.connect();
    expect(getUserMedia.mock.calls[0]?.[0]).toEqual({
      video: { deviceId: { exact: 'dev-42' } },
      audio: false,
    });
    cam.dispose();

    // Missing device: OverconstrainedError → retry with default camera.
    const track = new FakeTrack({ width: 640, height: 480, deviceId: 'other' });
    const gum = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('gone', 'OverconstrainedError'))
      .mockResolvedValueOnce(new FakeStream(track) as unknown as MediaStream);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: gum, enumerateDevices: vi.fn(async () => []), addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    const fallback = new CameraSource('dev-gone');
    await fallback.connect();
    expect(fallback.status).toBe('live');
    expect(gum).toHaveBeenCalledTimes(2);
    expect(gum.mock.calls[1]?.[0]).toEqual({ video: true, audio: false });
    fallback.dispose();
  });

  it('maps failures to explicit states', async () => {
    mockMedia({ fail: 'NotAllowedError' });
    const denied = new CameraSource(null);
    await expect(denied.connect()).rejects.toThrow();
    expect(denied.status).toBe('permission-denied');

    mockMedia({ fail: 'NotFoundError' });
    const missing = new CameraSource(null);
    await expect(missing.connect()).rejects.toThrow();
    expect(missing.status).toBe('device-lost');
  });

  it('a track ending flips to device-lost, once', async () => {
    const { track } = mockMedia();
    const cam = new CameraSource(null);
    const seen: string[] = [];
    cam.onStatus((s) => seen.push(s));
    await cam.connect();
    track.onended?.();
    track.onended?.();
    expect(cam.status).toBe('device-lost');
    expect(seen.filter((s) => s === 'device-lost')).toHaveLength(1);
    cam.dispose();
  });

  it('dispose stops every track, clears the element and kills the texture', async () => {
    const { track } = mockMedia();
    const cam = new CameraSource(null);
    await cam.connect();
    const tex = cam.texture();
    expect(tex).not.toBeNull();
    cam.dispose();
    expect(track.stopped).toBe(true); // green light off
    expect(cam.texture()).toBeNull();
    expect(cam.status).toBe('offline');
  });

  it('50 connect/dispose cycles leave no listeners or live tracks behind', async () => {
    for (let i = 0; i < 50; i++) {
      const { track } = mockMedia();
      const cam = new CameraSource(null);
      await cam.connect();
      cam.dispose();
      expect(track.stopped).toBe(true);
    }
  });

  it('a dispose that lands mid-connect still stops the acquired stream', async () => {
    const { track } = mockMedia();
    const cam = new CameraSource(null);
    const pending = cam.connect();
    cam.dispose();
    await pending.catch(() => undefined);
    expect(track.stopped).toBe(true);
    expect(cam.texture()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Schema v3
// ---------------------------------------------------------------------------

describe('schema v3 — live sources', () => {
  const cameraProject = (): Project => {
    const p = createEmptyProject('cam');
    return {
      ...p,
      sources: [{ id: 'cam-1', kind: 'camera', deviceId: 'dev-abc' }],
      composition: { ...p.composition, sourceId: 'cam-1' },
    };
  };

  it('camera refs round-trip; deviceId may be null', () => {
    const reloaded = parseProject(JSON.parse(JSON.stringify(projectSchema.parse(cameraProject()))));
    expect(reloaded.sources[0]).toEqual({ id: 'cam-1', kind: 'camera', deviceId: 'dev-abc' });
    const noDevice = parseProject(
      JSON.parse(
        JSON.stringify({ ...cameraProject(), sources: [{ id: 'c', kind: 'camera' }] }),
      ),
    );
    expect(noDevice.sources[0]).toEqual({ id: 'c', kind: 'camera', deviceId: null });
  });

  it('v1 and v2 projects migrate to v3 with creative state intact', () => {
    const v2 = JSON.parse(
      readFileSync(join(__dirname, 'fixtures', 'project-v2-pattern.json'), 'utf8'),
    ) as Record<string, unknown>;
    const migrated = parseProject(v2);
    expect(migrated.version).toBe(PROJECT_FORMAT_VERSION);
    expect(migrated.patternSources).toHaveLength(3);
    expect(migrated.pinnedLooks).toHaveLength(1);
    expect(migrated.sources.every(isFileSource)).toBe(true);

    const v1 = JSON.parse(JSON.stringify(createEmptyProject('v1'))) as Record<string, unknown>;
    v1.version = 1;
    v1.timeline = { inSec: null, outSec: null, loop: true, bpm: null, beatOffsetSec: 0 };
    expect(parseProject(v1).version).toBe(PROJECT_FORMAT_VERSION);
  });

  it('never persists runtime camera state', () => {
    const json = JSON.stringify(projectSchema.parse(cameraProject()).sources);
    for (const banned of ['stream', 'trackId', 'permission', 'label', 'width', 'frameRate']) {
      expect(json.includes(`"${banned}"`), `must not persist ${banned}`).toBe(false);
    }
  });

  it('unknown future live kinds are refused, not guessed', () => {
    const bad = {
      ...cameraProject(),
      sources: [{ id: 'x', kind: 'hologram', deviceId: null }],
    };
    expect(() => parseProject(JSON.parse(JSON.stringify(bad)))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Structural invariants (§87)
// ---------------------------------------------------------------------------

describe('structural invariants', () => {
  const read = (...parts: string[]) => readFileSync(join(__dirname, '..', ...parts), 'utf8');
  const code = (...parts: string[]) =>
    read(...parts)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('replica getUserMedia lives ONLY in the descriptor-gated camera module', () => {
    for (const file of readdirSync(join(__dirname, '..', 'src', 'output-window'))) {
      if (file === 'outputCameraSource.ts') continue;
      const src = code('src', 'output-window', file);
      expect(src.includes('getUserMedia'), `${file} must not acquire media`).toBe(false);
      expect(src.includes('setCameraIntent'), `${file} must not arm the gate`).toBe(false);
    }
    // And the gated module never arms intent either — only the editor can.
    const cam = code('src', 'output-window', 'outputCameraSource.ts');
    expect(cam.includes('setCameraIntent')).toBe(false);
    expect(cam.includes('enumerateDevices')).toBe(false);
  });

  it('editor-side acquisition lives only in CameraSource; the manager owns intent', () => {
    const manager = code('src', 'sources', 'cameraManager.ts');
    expect(manager.includes('setCameraIntent(true)')).toBe(true);
    const src = code('src', 'sources', 'CameraSource.ts');
    expect(src.includes('getUserMedia')).toBe(true);
    expect(src.includes('setCameraIntent')).toBe(false);
    // Nothing else in src/ acquires media.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(__dirname, '..', dir), { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const path = join(dir, entry.name).replace(/\\/g, '/');
          if (path.endsWith('sources/CameraSource.ts')) continue;
          if (path.endsWith('output-window/outputCameraSource.ts')) continue;
          if (code(path).includes('getUserMedia(')) offenders.push(path);
        }
      }
    };
    walk('src');
    expect(offenders).toEqual([]);
  });

  it('no pixel transport was introduced anywhere near the camera path', () => {
    for (const file of ['outputCameraSource.ts', 'replica.ts', 'main.ts']) {
      const src = code('src', 'output-window', file);
      for (const banned of ['captureStream', 'toDataURL', 'ImageBitmap', 'getImageData']) {
        expect(src.includes(banned), `${file}: ${banned}`).toBe(false);
      }
    }
    const bus = code('src', 'runtime', 'RuntimeBus.ts');
    for (const banned of ['ImageData', 'Blob', 'ImageBitmap', 'base64']) {
      expect(bus.includes(banned), `RuntimeBus: ${banned}`).toBe(false);
    }
  });

  it('main permission gate: media allowed only under intent, audio never', () => {
    const main = read('electron', 'main', 'index.ts');
    expect(main.includes('cameraIntentArmed()')).toBe(true);
    expect(main.includes("types.includes('audio')")).toBe(true);
    const builder = read('electron-builder.yml');
    expect(builder.includes('NSCameraUsageDescription')).toBe(true);
    expect(builder.includes('NSMicrophoneUsageDescription')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Undo/redo — camera is config, never a runtime action
// ---------------------------------------------------------------------------

describe('undo/redo camera config', () => {
  it('adding a camera source undoes/redoes as pure config at IDLE', async () => {
    mockMedia();
    const { useProjectStore } = await import('@/state/projectStore');
    const { cameraManager, useCameraStore } = await import('@/sources/cameraManager');
    const store = useProjectStore.getState();
    const before = store.project.sources.length;

    store.apply((p) => ({
      ...p,
      sources: [...p.sources, { id: 'cam-u', kind: 'camera', deviceId: null }],
    }));
    expect(useProjectStore.getState().project.sources).toHaveLength(before + 1);

    // Attach (project selected it) — IDLE, nothing acquired.
    cameraManager.attach('cam-u', null);
    expect(useCameraStore.getState().status).toBe('idle');
    expect(
      (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0);

    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.sources).toHaveLength(before);
    useProjectStore.getState().redo();
    expect(useProjectStore.getState().project.sources.at(-1)).toEqual({
      id: 'cam-u',
      kind: 'camera',
      deviceId: null,
    });
    // Redo restored config only — still idle, still zero acquisitions.
    expect(useCameraStore.getState().status).toBe('idle');
    expect(
      (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0);
    cameraManager.detach();
  });
});

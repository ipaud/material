import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Camera from '@/sources/cameraManager';
import type * as Capture from '@/sources/captureManager';
import type * as Ui from '@/state/uiStore';

/**
 * Camera and screen/window capture lifecycles (18D/18E): nothing is acquired until START, the
 * permission gate is armed only for that start and never left armed after a failure or a stop,
 * liveness is held only while live, and an unplugged device ends in one clean state without
 * capturing anything else. The device itself is a fake that can connect, fail or be lost.
 */

const h = vi.hoisted(() => {
  type Status = 'idle' | 'connecting' | 'live' | 'permission-denied' | 'device-lost' | 'error' | 'offline';
  class FakeLive {
    static made: FakeLive[] = [];
    static failWith: unknown = null;
    status: Status = 'connecting';
    width = 1280;
    height = 720;
    frameRate = 30;
    disposed = false;
    listener: ((s: Status) => void) | null = null;
    release: (() => void) | null = null;
    constructor(readonly arg: unknown) {
      FakeLive.made.push(this);
    }
    onStatus(cb: (s: Status) => void) {
      this.listener = cb;
    }
    connect() {
      if (FakeLive.failWith) {
        this.status = 'permission-denied';
        this.listener?.('permission-denied');
        return Promise.reject(FakeLive.failWith);
      }
      return new Promise<void>((resolve) => {
        this.release = () => {
          this.status = 'live';
          resolve();
        };
      });
    }
    lose() {
      this.status = 'device-lost';
      this.listener?.('device-lost');
    }
    texture() {
      return `texture-${FakeLive.made.indexOf(this)}`;
    }
    dispose() {
      this.disposed = true;
    }
  }
  return { FakeLive, setLiveSource: vi.fn() };
});

vi.mock('@/rendering/RenderEngine', () => ({ engine: { setLiveSource: h.setLiveSource } }));
vi.mock('@/sources/CameraSource', () => ({ CameraSource: h.FakeLive }));
vi.mock('@/sources/DisplayCaptureSource', () => ({ DisplayCaptureSource: h.FakeLive }));

const bridge = {
  setCameraIntent: vi.fn(async (_on: boolean) => undefined),
  setCaptureIntent: vi.fn(async (_t: unknown) => undefined),
  setLiveness: vi.fn(async (_r: string, _on: boolean) => true),
  outputDisplays: vi.fn(async () => [{ id: 1, label: 'Built-in' }, { id: 2, label: 'Projector' }]),
  listCaptureWindows: vi.fn(async () => [{ sourceId: 'window:5:0', title: 'Notes' }]),
};

let cam: typeof Camera;
let cap: typeof Capture;
let ui: typeof Ui;
const flush = () => new Promise((r) => setTimeout(r, 0));
const last = () => h.FakeLive.made.at(-1)!;
const liveness = () => bridge.setLiveness.mock.calls.map((c) => c[1]);

beforeEach(async () => {
  h.FakeLive.made.length = 0;
  h.FakeLive.failWith = null;
  vi.stubGlobal('material', bridge);
  vi.stubGlobal('navigator', {
    mediaDevices: {
      enumerateDevices: async () => [
        { kind: 'videoinput', deviceId: 'a', label: '' },
        { kind: 'audioinput', deviceId: 'mic', label: 'Mic' },
        { kind: 'videoinput', deviceId: 'b', label: 'USB Cam' },
      ],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  vi.resetModules();
  cam = await import('@/sources/cameraManager');
  cap = await import('@/sources/captureManager');
  ui = await import('@/state/uiStore');
  ui.useUiStore.setState({ toasts: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('camera', () => {
  it('attaching a saved camera acquires nothing and asks for nothing', () => {
    cam.cameraManager.attach('cam', 'b');
    expect(h.FakeLive.made).toHaveLength(0);
    expect(bridge.setCameraIntent).not.toHaveBeenCalled();
    expect(cam.useCameraStore.getState()).toMatchObject({ sourceId: 'cam', status: 'idle' });
  });

  it('START arms the gate, goes live on the chosen device and holds liveness; STOP releases both', async () => {
    cam.cameraManager.attach('cam', 'b');
    const starting = cam.cameraManager.start();
    expect(cam.useCameraStore.getState().status).toBe('connecting');
    await flush();
    expect(bridge.setCameraIntent).toHaveBeenLastCalledWith(true);
    expect(last().arg).toBe('b');
    last().release!();
    await starting;
    await flush();
    expect(cam.useCameraStore.getState()).toMatchObject({ status: 'live', width: 1280, height: 720, frameRate: 30 });
    expect(cam.useCameraStore.getState().devices).toEqual([
      { deviceId: 'a', label: 'Camera 1' },
      { deviceId: 'b', label: 'USB Cam' },
    ]);
    expect(h.setLiveSource).toHaveBeenLastCalledWith('camera', 'texture-0');
    expect(liveness()).toEqual([true]);
    expect(cam.cameraManager.isLive()).toBe(true);

    cam.cameraManager.stop();
    expect(last().disposed).toBe(true);
    expect(h.setLiveSource).toHaveBeenLastCalledWith('camera', null);
    expect(liveness()).toEqual([true, false]);
    expect(bridge.setCameraIntent).toHaveBeenLastCalledWith(false);
    expect(cam.useCameraStore.getState().status).toBe('idle');
  });

  it('a denied permission disarms the gate quietly; other failures are reported', async () => {
    cam.cameraManager.attach('cam', null);
    h.FakeLive.failWith = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    await cam.cameraManager.start();
    expect(bridge.setCameraIntent).toHaveBeenLastCalledWith(false);
    expect(cam.useCameraStore.getState().status).toBe('permission-denied');
    expect(ui.useUiStore.getState().toasts).toEqual([]);
    expect(liveness()).toEqual([]);

    h.FakeLive.failWith = new Error('device busy');
    await cam.cameraManager.start();
    expect(ui.useUiStore.getState().toasts.at(-1)?.message).toMatch(/device busy/);
  });

  it('unplugged while live: one clean state, gate and liveness released, nothing restarted', async () => {
    cam.cameraManager.attach('cam', null);
    const starting = cam.cameraManager.start();
    await flush();
    last().release!();
    await starting;
    last().lose();
    expect(cam.useCameraStore.getState()).toMatchObject({ status: 'device-lost', width: null });
    expect(h.setLiveSource).toHaveBeenLastCalledWith('camera', null);
    expect(liveness()).toEqual([true, false]);
    expect(h.FakeLive.made).toHaveLength(1);
  });

  it('a stop while still connecting wins: the late connection is not shown', async () => {
    cam.cameraManager.attach('cam', null);
    const starting = cam.cameraManager.start();
    await flush();
    const first = last();
    cam.cameraManager.stop();
    first.release!();
    await starting;
    expect(h.setLiveSource).not.toHaveBeenCalledWith('camera', 'texture-0');
    expect(cam.useCameraStore.getState().status).toBe('idle');
  });

  it('choosing another camera while live restarts on it; detach forgets everything', async () => {
    cam.cameraManager.attach('cam', 'a');
    const starting = cam.cameraManager.start();
    await flush();
    last().release!();
    await starting;
    const switching = cam.cameraManager.selectDevice('b');
    await flush();
    expect(last().arg).toBe('b');
    expect(h.FakeLive.made[0]!.disposed).toBe(true);
    last().release!();
    await switching;

    cam.cameraManager.detach();
    expect(cam.useCameraStore.getState()).toMatchObject({ sourceId: null, status: 'idle', devices: [] });
    await cam.cameraManager.start(); // nothing attached: nothing happens
    expect(h.FakeLive.made).toHaveLength(2);
  });
});

describe('screen and window capture', () => {
  it('a screen source lists displays without asking for permission', async () => {
    cap.captureManager.attach('scr', 'screen', 2);
    await flush();
    expect(cap.useCaptureStore.getState().displays).toHaveLength(2);
    expect(bridge.setCaptureIntent).not.toHaveBeenCalled();
    expect(bridge.listCaptureWindows).not.toHaveBeenCalled();
  });

  it('START arms the gate for exactly that display', async () => {
    cap.captureManager.attach('scr', 'screen', 2);
    const starting = cap.captureManager.start();
    await flush();
    expect(bridge.setCaptureIntent).toHaveBeenLastCalledWith({ kind: 'screen', displayId: 2 });
    last().release!();
    await starting;
    expect(cap.useCaptureStore.getState().status).toBe('live');
    expect(cap.captureManager.isLive()).toBe(true);
    expect(h.setLiveSource).toHaveBeenLastCalledWith('capture', 'texture-0');
  });

  it('a window cannot start until one is chosen, and then only that one', async () => {
    cap.captureManager.attach('win', 'window', null);
    await cap.captureManager.start();
    expect(h.FakeLive.made).toHaveLength(0);

    await cap.captureManager.chooseWindow();
    expect(cap.useCaptureStore.getState().windows).toEqual([{ sourceId: 'window:5:0', title: 'Notes' }]);
    cap.captureManager.selectWindow('window:5:0');
    const starting = cap.captureManager.start();
    await flush();
    expect(bridge.setCaptureIntent).toHaveBeenLastCalledWith({ kind: 'window', sourceId: 'window:5:0' });
    last().release!();
    await starting;
  });

  it('a closed window ends capture and forgets the choice, so nothing else is captured', async () => {
    cap.captureManager.attach('win', 'window', null);
    cap.captureManager.selectWindow('window:5:0');
    const starting = cap.captureManager.start();
    await flush();
    last().release!();
    await starting;
    last().lose();
    expect(cap.useCaptureStore.getState()).toMatchObject({ status: 'device-lost', chosenWindowId: null });
    expect(bridge.setCaptureIntent).toHaveBeenLastCalledWith(null);
    expect(liveness()).toEqual([true, false]);
  });

  it('permission-shaped failures are not reported as errors; the gate is disarmed either way', async () => {
    cap.captureManager.attach('scr', 'screen', null);
    h.FakeLive.failWith = Object.assign(new Error('Invalid capture constraints'), { name: 'Error' });
    await cap.captureManager.start();
    expect(bridge.setCaptureIntent).toHaveBeenLastCalledWith(null);
    expect(ui.useUiStore.getState().toasts).toEqual([]);

    h.FakeLive.failWith = new Error('GPU process gone');
    await cap.captureManager.start();
    expect(ui.useUiStore.getState().toasts.at(-1)?.message).toMatch(/GPU process gone/);
  });

  it('listing windows failing is reported and leaves an empty list', async () => {
    bridge.listCaptureWindows.mockRejectedValueOnce(new Error('TCC denied'));
    cap.captureManager.attach('win', 'window', null);
    await cap.captureManager.chooseWindow();
    expect(cap.useCaptureStore.getState().windows).toEqual([]);
    expect(ui.useUiStore.getState().toasts.at(-1)?.message).toMatch(/TCC denied/);
  });

  it('a screen source never lists windows; detach resets to neutral', async () => {
    cap.captureManager.attach('scr', 'screen', null);
    await cap.captureManager.chooseWindow();
    expect(bridge.listCaptureWindows).not.toHaveBeenCalled();
    cap.captureManager.detach();
    expect(cap.useCaptureStore.getState()).toMatchObject({ sourceId: null, kind: null, status: 'idle' });
  });

  it('choosing another display while live restarts onto it', async () => {
    cap.captureManager.attach('scr', 'screen', 1);
    const starting = cap.captureManager.start();
    await flush();
    last().release!();
    await starting;
    const moving = cap.captureManager.selectDisplay(2);
    await flush();
    expect(bridge.setCaptureIntent).toHaveBeenLastCalledWith({ kind: 'screen', displayId: 2 });
    last().release!();
    await moving;
    expect(h.FakeLive.made[0]!.disposed).toBe(true);
  });
});

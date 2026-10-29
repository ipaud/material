import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutputChannelMsg } from '@shared/outputChannel';
import type * as Bridge from '@/output/outputBridge';
import type * as Bus from '@/runtime/RuntimeBus';
import type * as OutputStore from '@/state/outputStore';

/**
 * The editor side of the Output stream: a fresh replica is brought up to date at once, every frame
 * and transport event is forwarded, a clock beacon keeps it in step, and closing the Output tears
 * the subscriptions down.
 */

const h = vi.hoisted(() => ({ time: 4.2 }));
vi.mock('@/playback/PlaybackController', () => ({ playback: { getTime: () => h.time } }));

let bridge: typeof Bridge;
let bus: typeof Bus.runtimeBus;
let outputStore: typeof OutputStore.useOutputStore;
let onMessage: (e: { source: unknown; data: unknown; ports: unknown[] }) => void;
let onStatus: (s: { state: string }) => void;
let onDisplays: (d: unknown[]) => void;

function fakePort() {
  const sent: OutputChannelMsg[] = [];
  return { sent, postMessage: vi.fn((m: OutputChannelMsg) => sent.push(m)), start: vi.fn(), close: vi.fn() };
}

function connect() {
  const port = fakePort();
  onMessage({ source: window, data: { type: 'material:output-port' }, ports: [port] });
  return port;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, fn: never) => {
    if (type === 'message') onMessage = fn;
  }) as never);
  vi.stubGlobal('material', {
    onOutputStatus: (fn: typeof onStatus) => (onStatus = fn),
    onOutputDisplays: (fn: typeof onDisplays) => (onDisplays = fn),
  });
  bridge = await import('@/output/outputBridge');
  bus = (await import('@/runtime/RuntimeBus')).runtimeBus;
  outputStore = (await import('@/state/outputStore')).useOutputStore;
  bridge.startOutputBridge();
});

afterEach(() => {
  onStatus?.({ state: 'closed' });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the output stream', () => {
  it('a new replica gets the render inputs and the clock immediately', () => {
    const port = connect();
    expect(port.start).toHaveBeenCalled();
    expect(port.sent.map((m) => m.type)).toEqual(['render-inputs', 'clock']);
    expect(port.sent[1]).toMatchObject({ type: 'clock', authorityTimeSec: 4.2, playbackRate: 1 });
    expect(bridge.outputBridgeActive()).toBe(true);
  });

  it('forwards frames with the whole resolved stack, transport events, and a 4 Hz clock', () => {
    const port = connect();
    port.sent.length = 0;
    bus.emitFrame(1, { scale: 1 }, false, { speed: 2 }, undefined, {
      layerParams: { L2: { scale: 0.5 } },
      layerStageParams: {},
      layerOpacity: { L2: 0.4 },
      layerSourceParams: {},
    });
    bus.emitTransport('pause', 3);
    vi.advanceTimersByTime(1000);
    const types = port.sent.map((m) => m.type);
    // the resolved stack travels with the frame: dropping it is what once hid layers from the Output
    expect(port.sent[0]).toMatchObject({ type: 'frame', seq: 0, compTime: 1, sourceParams: { speed: 2 }, layerParams: { L2: { scale: 0.5 } }, layerOpacity: { L2: 0.4 } });
    expect(types).toContain('transport');
    expect(port.sent.find((m) => m.type === 'transport')).toMatchObject({ action: 'pause', timeSec: 3 });
    expect(types.filter((t) => t === 'clock').length).toBeGreaterThanOrEqual(4);
  });

  it('closing the Output stops the stream; a new port replaces the old one', () => {
    const first = connect();
    const second = connect();
    expect(first.close).toHaveBeenCalled();
    onStatus({ state: 'closed' });
    expect(second.close).toHaveBeenCalled();
    expect(bridge.outputBridgeActive()).toBe(false);
    second.sent.length = 0;
    vi.advanceTimersByTime(1000);
    expect(second.sent).toEqual([]);
    expect(outputStore.getState().status).toMatchObject({ state: 'closed' });
  });

  it('ignores messages that are not the port hand-off, and starts only once', () => {
    onMessage({ source: null, data: { type: 'material:output-port' }, ports: [fakePort()] });
    onMessage({ source: window, data: { type: 'other' }, ports: [fakePort()] });
    expect(bridge.outputBridgeActive()).toBe(false);
    const registered = onMessage;
    bridge.startOutputBridge();
    expect(onMessage).toBe(registered);
  });

  it('display hot-plug lists go straight to the store', () => {
    onDisplays([{ id: 2, label: 'Projector' }]);
    expect(outputStore.getState().displays).toEqual([{ id: 2, label: 'Projector' }]);
  });
});

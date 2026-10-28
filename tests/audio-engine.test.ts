import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioEngine } from '@/audio/AudioEngine';
import { useAudioStore } from '@/state/audioStore';

const analysis = { bpm: 120 } as never;

describe('audioEngine load and transport', () => {
  let context: AudioContext;
  let nodes: Array<{
    buffer: AudioBuffer | null;
    connect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }>;

  beforeEach(() => {
    audioEngine.unload();
    // Singleton keeps AudioContext across unloads; reset only context between tests.
    (audioEngine as unknown as { ctx: AudioContext | null }).ctx = null;
    nodes = [];
    const buffer = {
      duration: 2,
      length: 4,
      numberOfChannels: 2,
      sampleRate: 48000,
      getChannelData: (channel: number) => channel === 0
        ? Float32Array.from([-1, 0.5, 0, 1])
        : Float32Array.from([1, 0.5, -1, 1]),
    } as AudioBuffer;
    context = {
      currentTime: 10,
      destination: {} as AudioDestinationNode,
      decodeAudioData: vi.fn(async () => buffer),
      resume: vi.fn(async () => undefined),
      createBufferSource: vi.fn(() => {
        const node = {
          buffer: null,
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          disconnect: vi.fn(),
        };
        nodes.push(node);
        return node;
      }),
    } as unknown as AudioContext;
    vi.stubGlobal('AudioContext', function MockAudioContext() { return context; });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    })));
    vi.stubGlobal('Worker', class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      postMessage = vi.fn(() => queueMicrotask(() => this.onmessage?.({ data: analysis } as unknown as MessageEvent)));
      terminate = vi.fn();
    });
  });

  afterEach(() => {
    audioEngine.unload();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads mono analysis and clamps play, seek, pause, and restart positions', async () => {
    await audioEngine.load('/tmp/beat.wav');

    expect(audioEngine.isLoaded).toBe(true);
    expect(audioEngine.duration).toBe(2);
    expect(useAudioStore.getState().path).toBe('/tmp/beat.wav');
    expect(useAudioStore.getState().analysis).toBe(analysis);

    audioEngine.play(9);
    expect(nodes[0]?.start).toHaveBeenCalledWith(0, 2);
    expect(audioEngine.getTime()).toBe(2);
    expect(audioEngine.playing).toBe(true);

    audioEngine.pause();
    expect(nodes[0]?.stop).toHaveBeenCalledOnce();
    expect(nodes[0]?.disconnect).toHaveBeenCalledOnce();
    expect(audioEngine.playing).toBe(false);
    expect(audioEngine.getTime()).toBe(2);

    audioEngine.seek(-1);
    expect(audioEngine.getTime()).toBe(0);
    audioEngine.play();
    audioEngine.seek(1);
    expect(nodes[1]?.stop).toHaveBeenCalledOnce();
    expect(nodes[2]?.start).toHaveBeenCalledWith(0, 1);

    audioEngine.unload();
    expect(audioEngine.isLoaded).toBe(false);
    expect(useAudioStore.getState().path).toBeNull();
    expect(nodes[2]?.stop).toHaveBeenCalledOnce();
  });

  it('clears prior audio when file fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));

    await audioEngine.load('/missing.wav');

    expect(audioEngine.isLoaded).toBe(false);
    expect(audioEngine.analysis).toBeNull();
    expect(useAudioStore.getState().path).toBeNull();
    expect(useAudioStore.getState().loading).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProject } from '@shared/schemas/project';
import { useProjectStore } from '@/state/projectStore';
import { useExportStore } from '@/state/exportStore';
import { useUiStore } from '@/state/uiStore';
import { addGeneratorSource } from '@/projects/projectActions';

/**
 * The export loop's orchestration, against a recording stand-in for the GPU engine (the pixels
 * themselves are checked by the packaged-app gates). What matters here is order and bookkeeping:
 * which audio is muxed, that every frame reaches the encoder, that cancel and failure leave no
 * half-open session, and that the frame-0 decode happens before the feedback prime.
 */

const h = vi.hoisted(() => {
  const log: string[] = [];
  const flags = { isFeedbackTechnique: false, hasStatefulSerialLayers: false, isTemporalActiveAnywhere: false, isTemporalActive: false };
  const fns = new Map<string | symbol, ReturnType<typeof vi.fn>>();
  const engine = new Proxy(
    {},
    {
      get(_t, key) {
        if (key in flags) return flags[key as keyof typeof flags];
        if (key === 'visualSignalStats') return null;
        if (key === 'branchFor') return () => null;
        if (key === 'then') return undefined;
        if (!fns.has(key)) {
          fns.set(
            key,
            vi.fn((...args: unknown[]) => {
              log.push(String(key));
              if (key === 'renderStill') return new Uint8Array([args[0] as number]);
              return undefined;
            }),
          );
        }
        return fns.get(key);
      },
    },
  );
  return { log, flags, fns, engine, playback: { pause: vi.fn(), currentVideo: null as HTMLVideoElement | null } };
});

vi.mock('@/rendering/RenderEngine', () => ({ engine: h.engine }));
vi.mock('@/playback/PlaybackController', () => ({ playback: h.playback }));
vi.mock('@/rendering/engineBridge', () => ({ resyncFromStore: vi.fn(), syncLayersForExport: vi.fn() }));

const { runAnimationExport } = await import('@/export/exportRunner');
const { resyncFromStore } = await import('@/rendering/engineBridge');

const bridge = {
  exportStart: vi.fn(async (_config: Record<string, unknown>) => ({ sessionId: 'sess-1' })),
  exportFrame: vi.fn(async (_id: string, _rgba: Uint8Array) => {
    h.log.push('exportFrame');
  }),
  exportFinish: vi.fn(async (_id: string) => ({ outPath: '/out/show.mp4' })),
  exportCancel: vi.fn(async (_id: string) => undefined),
};

const request = (patch: Partial<Parameters<typeof runAnimationExport>[0]> = {}) => ({
  format: 'h264' as const,
  width: 64,
  height: 36,
  fps: 10,
  startSec: 0,
  durationSec: 0.5,
  outPath: '/out/show.mp4',
  includeAudio: true,
  ...patch,
});

const calls = (name: string) => h.fns.get(name)?.mock.calls ?? [];

beforeEach(() => {
  vi.stubGlobal('material', bridge);
  useProjectStore.getState().newProject();
  useProjectStore.getState().apply(() => ({
    ...createEmptyProject(),
    sources: [{ id: 'song', kind: 'audio', path: '/music/track.wav', metadata: null }],
    composition: { ...createEmptyProject().composition, audioSourceId: 'song' },
  }));
  addGeneratorSource('noise');
  useExportStore.setState({ phase: 'idle', cancelRequested: false, message: null });
  useUiStore.setState({ toasts: [] });
  h.log.length = 0;
  h.fns.clear();
  Object.assign(h.flags, { isFeedbackTechnique: false, hasStatefulSerialLayers: false, isTemporalActiveAnywhere: false });
  h.playback.currentVideo = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('a full export', () => {
  it('opens one session with the soundtrack, sends every frame and closes it', async () => {
    await runAnimationExport(request());

    expect(h.playback.pause).toHaveBeenCalled();
    expect(bridge.exportStart).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'h264', fps: 10, audioPath: '/music/track.wav', audioStartSec: 0, durationSec: 0.5, alpha: false }),
    );
    expect(bridge.exportFrame).toHaveBeenCalledTimes(5);
    expect(bridge.exportFrame.mock.calls.every((c) => c[0] === 'sess-1')).toBe(true);
    expect(calls('setTime').map((c) => c[0])).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
    expect(bridge.exportFinish).toHaveBeenCalledWith('sess-1');
    expect(useExportStore.getState()).toMatchObject({ phase: 'done', progress: 5, message: '/out/show.mp4' });
    expect(useUiStore.getState().toasts.at(-1)?.message).toBe('Exported show.mp4');
    expect(h.log.indexOf('beginExportMode')).toBeLessThan(h.log.indexOf('renderStill'));
    expect(h.log.at(-1)).not.toBe('renderStill');
    expect(calls('endExportMode')).toHaveLength(1);
    expect(resyncFromStore).toHaveBeenCalledOnce();
  });

  it('a PNG sequence has no audio; a CLI override replaces the project song', async () => {
    await runAnimationExport(request({ format: 'png-sequence' }));
    expect(bridge.exportStart.mock.calls[0]![0]).toMatchObject({ audioPath: null });

    await runAnimationExport(request({ audioPathOverride: '/cli/mix.wav' }));
    expect(bridge.exportStart.mock.calls[1]![0]).toMatchObject({ audioPath: '/cli/mix.wav' });

    await runAnimationExport(request({ includeAudio: false }));
    expect(bridge.exportStart.mock.calls[2]![0]).toMatchObject({ audioPath: null });
  });

  it('always renders at least one frame', async () => {
    await runAnimationExport(request({ durationSec: 0 }));
    expect(bridge.exportFrame).toHaveBeenCalledTimes(1);
  });
});

describe('stopping', () => {
  it('cancel between frames closes the session as cancelled, never as finished', async () => {
    bridge.exportFrame.mockImplementation(async () => {
      if (bridge.exportFrame.mock.calls.length === 2) useExportStore.getState().requestCancel();
    });
    await runAnimationExport(request());
    expect(bridge.exportFrame).toHaveBeenCalledTimes(2);
    expect(bridge.exportCancel).toHaveBeenCalledWith('sess-1');
    expect(bridge.exportFinish).not.toHaveBeenCalled();
    expect(useExportStore.getState()).toMatchObject({ phase: 'cancelled', message: 'Export cancelled' });
    expect(calls('endExportMode')).toHaveLength(1);
    expect(resyncFromStore).toHaveBeenCalledOnce();
  });

  it('a failing frame cancels the encoder session and reports the reason', async () => {
    bridge.exportFrame.mockRejectedValueOnce(new Error('ffmpeg exited with 1'));
    await runAnimationExport(request());
    expect(bridge.exportCancel).toHaveBeenCalledWith('sess-1');
    expect(useExportStore.getState()).toMatchObject({ phase: 'error', message: 'ffmpeg exited with 1' });
    expect(calls('endExportMode')).toHaveLength(1);
    expect(resyncFromStore).toHaveBeenCalledOnce();
  });

  it('when the encoder cannot even start, there is no session to cancel', async () => {
    bridge.exportStart.mockRejectedValueOnce(new Error('no ffmpeg'));
    await runAnimationExport(request());
    expect(bridge.exportCancel).not.toHaveBeenCalled();
    expect(useExportStore.getState()).toMatchObject({ phase: 'error', message: 'no ffmpeg' });
  });
});

describe('history before a subrange', () => {
  it('a feedback technique walks its surface from frame 0 up to the range start, then continues it', async () => {
    h.flags.isFeedbackTechnique = true;
    await runAnimationExport(request({ startSec: 0.3, durationSec: 0.2 }));

    const feedback = calls('prepareFeedbackForExport').map((c) => [c[0], c[1]]);
    // three preroll steps (0, 0.1, 0.2), the first one priming; then the range without re-priming
    expect(feedback).toEqual([
      [0, true],
      [0.1, false],
      [0.2, false],
      [0.3, false],
      [0.4, false],
    ]);
    expect(bridge.exportFrame).toHaveBeenCalledTimes(2);
  });

  it('without anything stateful, the preroll touches no GPU work', async () => {
    await runAnimationExport(request({ startSec: 0.3, durationSec: 0.1 }));
    expect(calls('prepareGeneratorForExport').map((c) => c[0])).toEqual([0.3]);
    expect(calls('prepareFlowForExport')[0]![2]).toBe(true); // the range's first frame primes flow
  });
});

describe('video sources', () => {
  /** A video element that seeks asynchronously, like a real decoder. */
  function fakeVideo() {
    const target = new EventTarget();
    let time = 0;
    return Object.defineProperties(target, {
      readyState: { value: 4 },
      duration: { value: 10 },
      currentTime: {
        get: () => time,
        set: (t: number) => {
          time = t;
          setTimeout(() => {
            h.log.push(`seeked:${t.toFixed(4)}`);
            target.dispatchEvent(new Event('seeked'));
          }, 1);
        },
      },
    }) as unknown as HTMLVideoElement;
  }

  it('frame 0 is decoded before the feedback prime copies it (the 0.8.6 black-first-frame bug)', async () => {
    h.playback.currentVideo = fakeVideo();
    await runAnimationExport(request({ durationSec: 0.2 }));

    const firstSeek = h.log.findIndex((e) => e.startsWith('seeked:'));
    const firstPrime = h.log.indexOf('prepareFeedbackForExport');
    expect(firstSeek).toBeGreaterThanOrEqual(0);
    expect(firstSeek).toBeLessThan(firstPrime);
    // the forced seek to the same position still nudges the decoder
    expect(h.log[firstSeek]).toBe('seeked:0.0001');
    expect(h.log.filter((e) => e.startsWith('seeked:'))).toEqual(['seeked:0.0001', 'seeked:0.1000']);
  });
});

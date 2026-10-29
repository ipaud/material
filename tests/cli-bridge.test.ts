import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProject, type Project } from '@shared/schemas/project';
import { useProjectStore } from '@/state/projectStore';
import { useExportStore } from '@/state/exportStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useAudioStore } from '@/state/audioStore';
import { useUiStore } from '@/state/uiStore';

/**
 * The CLI's renderer side: `material render` must run exactly the dialog's export with the job's
 * settings, refuse projects it cannot render honestly, and wait for media before frame 0.
 */

const h = vi.hoisted(() => ({
  open: vi.fn(),
  run: vi.fn(),
  fps: 25 as number | null,
  loadAudio: vi.fn(),
  tempo: { bpm: 120, confidence: 0.9, beatOffsetSec: 0.1, alternativeBpm: 60 } as object | null,
  hasVideo: false,
}));

vi.mock('@/projects/projectActions', () => ({ openProjectFromPath: h.open }));
vi.mock('@/export/exportRunner', () => ({ runAnimationExport: h.run }));
vi.mock('@/export/exportSettings', async (orig) => ({ ...(await orig<object>()), probeSourceFps: async () => h.fps }));
vi.mock('@/audio/AudioEngine', () => ({ audioEngine: { load: h.loadAudio } }));
vi.mock('@/audio/tempo', () => ({ detectTempo: () => h.tempo }));
vi.mock('@/signals/triggerSources', () => ({ onsetEventTimes: () => [0.12345, 1.5] }));
vi.mock('@/playback/PlaybackController', () => ({
  playback: {
    get hasVideo() {
      return h.hasVideo;
    },
  },
}));

await import('@/cli/cliBridge');
const cli = window.__materialCli!;

const job = { project: '/s/a.material', out: '/o/a.mov', codec: 'prores4444' as const, audio: null, fps: null, range: null };

function opens(patch: Partial<Project>) {
  h.open.mockImplementation(async () => {
    useProjectStore.getState().loadProject('/s/a.material', { ...createEmptyProject(), ...patch });
  });
}

beforeEach(() => {
  h.fps = 25;
  h.hasVideo = false;
  h.run.mockImplementation(async () => useExportStore.setState({ phase: 'done', totalFrames: 250 }));
  useUiStore.setState({ pendingRepair: null, pendingProxy: null });
  usePlaybackStore.setState({ durationSec: 10 });
  useAudioStore.setState({ loading: false, analysis: null, durationSec: 0, path: null });
  useExportStore.setState({ phase: 'idle', progress: 0, totalFrames: 0, message: null });
});

afterEach(() => vi.clearAllMocks());

describe('render', () => {
  it('runs the dialog’s export with even dimensions, the footage rate and the whole clip', async () => {
    opens({ composition: { ...createEmptyProject().composition, width: 1919, height: 1081 } });
    await expect(cli.render(job)).resolves.toEqual({ out: '/o/a.mov', frames: 250 });
    expect(h.run).toHaveBeenCalledWith({
      format: 'prores4444',
      width: 1918,
      height: 1080,
      fps: 25,
      startSec: 0,
      durationSec: 10,
      outPath: '/o/a.mov',
      includeAudio: false,
      audioPathOverride: null,
    });
  });

  it('a range, an fps and a replacement soundtrack from the command line win', async () => {
    opens({});
    await cli.render({ ...job, codec: 'h264', fps: 60, range: [2, 5], audio: '/m/mix.wav' });
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ format: 'h264', fps: 60, startSec: 2, durationSec: 3, includeAudio: true, audioPathOverride: '/m/mix.wav' }));
  });

  it('a project without a clock needs an explicit range', async () => {
    opens({});
    usePlaybackStore.setState({ durationSec: 0 });
    await expect(cli.render(job)).rejects.toThrow('pass --range start:end');
    expect(h.run).not.toHaveBeenCalled();
  });

  it('an invalid project is refused with its issues', async () => {
    h.open.mockImplementation(async () =>
      useUiStore.setState({ pendingRepair: { path: '/s/a.material', issues: [{ text: 'layers.0: bad blend' }], repairable: false } as never }),
    );
    await expect(cli.render(job)).rejects.toThrow('Invalid project:\n  layers.0: bad blend');
  });

  it('a codec the viewer cannot decode stops before rendering, with the fix', async () => {
    opens({});
    useUiStore.setState({ pendingProxy: { path: '/m/clip.mov', codec: 'hevc' } });
    await expect(cli.render(job)).rejects.toThrow('Cannot play /m/clip.mov (hevc); open the project once in MATERIAL and make the H.264 proxy');
  });

  it('waits for a video layer to load before frame 0', async () => {
    opens({
      sources: [{ id: 'v', kind: 'video', path: '/m/v.mp4', metadata: null }],
      layers: [{ ...createEmptyProject().layers[0]!, sourceId: 'v' }],
    });
    const rendering = cli.render(job);
    await new Promise((r) => setTimeout(r, 150));
    expect(h.run).not.toHaveBeenCalled();
    h.hasVideo = true;
    await rendering;
    expect(h.run).toHaveBeenCalledOnce();
  });

  it('an export that did not finish is an error, with its message', async () => {
    opens({});
    h.run.mockImplementation(async () => useExportStore.setState({ phase: 'error', message: 'ffmpeg exited with 1' }));
    await expect(cli.render(job)).rejects.toThrow('ffmpeg exited with 1');
  });
});

describe('analyze-audio and status', () => {
  it('reports tempo and onsets (rounded to the millisecond) as markers', async () => {
    h.loadAudio.mockImplementation(async (path: string) => useAudioStore.setState({ analysis: {} as never, durationSec: 42, path }));
    await expect(cli.analyzeAudio('/m/song.wav', 0.3)).resolves.toEqual({
      file: '/m/song.wav',
      durationSec: 42,
      bpm: 120,
      confidence: 0.9,
      beatOffsetSec: 0.1,
      alternativeBpm: 60,
      onsets: [0.123, 1.5],
      markers: [
        { id: 'onset-1', timeSec: 0.123, label: 'onset' },
        { id: 'onset-2', timeSec: 1.5, label: 'onset' },
      ],
    });
  });

  it('no detectable tempo is null, not a guess; a failed load is an error', async () => {
    h.tempo = null;
    h.loadAudio.mockImplementation(async (path: string) => useAudioStore.setState({ analysis: {} as never, durationSec: 3, path }));
    expect(await cli.analyzeAudio('/m/noise.wav')).toMatchObject({ bpm: null, confidence: null });
    h.loadAudio.mockImplementation(async () => useAudioStore.setState({ analysis: null }));
    await expect(cli.analyzeAudio('/m/broken.wav')).rejects.toThrow('Could not analyse /m/broken.wav');
  });

  it('status mirrors the export store', () => {
    useExportStore.setState({ phase: 'running', progress: 12, totalFrames: 99, message: null });
    expect(cli.status()).toEqual({ phase: 'running', frame: 12, totalFrames: 99, message: null });
  });
});

import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createEmptyProject, type Project } from '@shared/schemas/project';
import { useExportStore } from '@/state/exportStore';
import { useProjectStore } from '@/state/projectStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useUiStore } from '@/state/uiStore';

/**
 * The Export dialog: what it offers on this machine and for this project, what it hands the
 * export loop, what it remembers, and how it reports the result.
 */

const h = vi.hoisted(() => ({
  run: vi.fn(async () => undefined),
  still: vi.fn(async () => undefined),
  sourceFps: 25 as number | null,
}));
vi.mock('@/export/exportRunner', () => ({ runAnimationExport: h.run }));
vi.mock('@/export/exportStill', () => ({ exportPngStill: h.still }));
vi.mock('@/export/exportSettings', async (orig) => ({
  ...(await orig<object>()),
  probeSourceFps: async () => h.sourceFps,
}));

const { ExportDialog } = await import('@/export/ExportDialog');

const bridge = {
  getAppInfo: vi.fn(async () => ({ availableEncoders: ['libx264'] })),
  exportSaveDialog: vi.fn(async (_format: string, _name: string) => '/out/show.mp4' as string | null),
  showInFinder: vi.fn(),
};

function open(patch: Partial<Project> = {}, path: string | null = '/shows/show.material') {
  const p = { ...createEmptyProject(), name: 'show', ...patch };
  if (path) useProjectStore.getState().loadProject(path, p);
  else useProjectStore.getState().apply(() => p);
  useExportStore.getState().openDialog();
  render(<ExportDialog />);
}

const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement;
const exportButton = () => screen.getByRole('button', { name: 'Export…' });
const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

/** jsdom here has no Web Storage; a Map is enough for what the dialog remembers. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
    key: (i) => [...data.keys()][i] ?? null,
  };
}

beforeEach(() => {
  vi.stubGlobal('material', bridge);
  vi.stubGlobal('localStorage', memoryStorage());
  h.sourceFps = 25;
  useProjectStore.getState().newProject();
  usePlaybackStore.setState({ durationSec: 12 });
  useExportStore.setState({ dialogOpen: false, phase: 'idle', message: null, progress: 0, totalFrames: 0 });
  useUiStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('what it offers', () => {
  it('defaults the frame rate to the footage, not a fixed 30', async () => {
    open();
    await flush();
    expect(select('Frame rate').value).toBe('25');
    expect(screen.getByRole('option', { name: 'Full (12.0s)' })).toBeInTheDocument();
  });

  it('without a media clock it says the length is a default', async () => {
    usePlaybackStore.setState({ durationSec: 0 });
    open();
    await flush();
    expect(screen.getByRole('option', { name: 'Default (5.0s — no media clock)' })).toBeInTheDocument();
  });

  it('offers ProRes only when this FFmpeg can encode it', async () => {
    open();
    await flush();
    expect([...select('Format').options].map((o) => o.value)).toEqual(['png-still', 'png-sequence', 'h264']);
    cleanup();
    bridge.getAppInfo.mockResolvedValueOnce({ availableEncoders: ['libx264', 'prores_ks'] });
    open();
    await flush();
    expect([...select('Format').options].map((o) => o.value)).toContain('prores4444');
  });

  it('a live camera can only be exported as a still', async () => {
    open({
      sources: [{ id: 'cam', kind: 'camera', deviceId: null }],
      composition: { ...createEmptyProject().composition, sourceId: 'cam' },
    });
    await flush();
    expect(exportButton()).toBeDisabled();
    expect(screen.getByText(/LIVE SOURCE — sequence\/movie export unavailable/)).toBeInTheDocument();
    fireEvent.change(select('Format'), { target: { value: 'png-still' } });
    expect(exportButton()).toBeEnabled();
    fireEvent.click(exportButton());
    await flush();
    expect(h.still).toHaveBeenCalledOnce();
    expect(useExportStore.getState().dialogOpen).toBe(false);
  });
});

describe('starting an export', () => {
  it('passes an even-sized source resolution, the custom range and no audio when there is none', async () => {
    open({ composition: { ...createEmptyProject().composition, width: 1281, height: 721 } });
    await flush();
    fireEvent.change(select('Range'), { target: { value: 'custom' } });
    const [start, duration] = screen.getAllByRole('spinbutton');
    fireEvent.change(start!, { target: { value: '2' } });
    fireEvent.change(duration!, { target: { value: '3' } });
    expect(screen.getByText('1280×720 · 25 fps · ~75 frames')).toBeInTheDocument();
    fireEvent.click(exportButton());
    await flush();
    expect(bridge.exportSaveDialog).toHaveBeenCalledWith('h264', 'show');
    expect(h.run).toHaveBeenCalledWith({
      format: 'h264',
      width: 1280,
      height: 720,
      fps: 25,
      startSec: 2,
      durationSec: 3,
      outPath: '/out/show.mp4',
      includeAudio: false,
      alpha: false,
    });
  });

  it('cancelling the save dialog starts nothing and remembers nothing', async () => {
    bridge.exportSaveDialog.mockResolvedValueOnce(null);
    open();
    await flush();
    fireEvent.click(exportButton());
    await flush();
    expect(h.run).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it('remembers the choices per project for the next export', async () => {
    open();
    await flush();
    fireEvent.change(select('Format'), { target: { value: 'png-sequence' } });
    fireEvent.change(select('Resolution'), { target: { value: '2160' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Transparent background' }));
    fireEvent.click(exportButton());
    await flush();
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ format: 'png-sequence', width: 3840, height: 2160, alpha: true }));

    cleanup();
    open();
    await flush();
    expect(select('Format').value).toBe('png-sequence');
    expect(select('Resolution').value).toBe('2160');
    expect(screen.getByRole('switch', { name: 'Transparent background' })).toHaveAttribute('aria-checked', 'true');
  });

  it('alpha is never asked of a format that cannot carry it', async () => {
    open();
    await flush();
    expect(screen.queryByRole('switch', { name: 'Transparent background' })).not.toBeInTheDocument();
  });

  it('the soundtrack is muxed unless switched off', async () => {
    open({
      sources: [{ id: 'song', kind: 'audio', path: '/m/song.wav', metadata: null }],
      composition: { ...createEmptyProject().composition, audioSourceId: 'song' },
    });
    await flush();
    fireEvent.click(screen.getByRole('switch', { name: 'Include audio' }));
    fireEvent.click(exportButton());
    await flush();
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ includeAudio: false }));
  });
});

describe('progress and result', () => {
  it('while running: progress and Cancel, and clicking outside does not close it', async () => {
    open();
    act(() => useExportStore.setState({ phase: 'running', progress: 30, totalFrames: 120 }));
    expect(screen.getByText('30 / 120 frames')).toBeInTheDocument();
    fireEvent.click(document.querySelector('.export-overlay')!);
    expect(useExportStore.getState().dialogOpen).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useExportStore.getState().cancelRequested).toBe(true);
  });

  it('a finished export closes the dialog with a toast that opens Finder', async () => {
    open();
    act(() => useExportStore.setState({ phase: 'done', message: '/out/show.mp4' }));
    expect(useExportStore.getState().dialogOpen).toBe(false);
    const toast = useUiStore.getState().toasts.at(-1)!;
    expect(toast.message).toBe('Saved show.mp4');
    toast.action!.run();
    expect(bridge.showInFinder).toHaveBeenCalledWith('/out/show.mp4');
  });

  it('a failed export shows why', async () => {
    open();
    act(() => useExportStore.setState({ phase: 'error', message: 'ffmpeg exited with 1' }));
    expect(screen.getByText('ffmpeg exited with 1')).toHaveClass('export-error');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(useExportStore.getState().dialogOpen).toBe(false);
  });
});

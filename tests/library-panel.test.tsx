import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createEmptyProject, selectedLayerOf, type Project } from '@shared/schemas/project';
import type { MediaMetadata } from '@shared/schemas/media';
import { LibraryPanel } from '@/library/LibraryPanel';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { cameraManager, useCameraStore } from '@/sources/cameraManager';
import { captureManager, useCaptureStore } from '@/sources/captureManager';

/**
 * The Library as a user meets it: what clicking a row does to the project, which actions appear
 * when, and that live inputs only ever start from their own START button.
 */

const meta = (patch: Partial<MediaMetadata> = {}): MediaMetadata => ({
  kind: 'video',
  path: '/m/clip.mp4',
  fileName: 'clip.mp4',
  fileSize: 12_300_000,
  durationSec: 8.25,
  width: 1920,
  height: 1080,
  frameRate: 30,
  videoCodec: 'h264',
  audioCodec: null,
  audioChannels: null,
  sampleRate: null,
  ...patch,
});

const project = () => useProjectStore.getState().project;
const load = (patch: Partial<Project>) => useProjectStore.getState().loadProject('/s.material', { ...createEmptyProject(), ...patch });

beforeEach(() => {
  useProjectStore.getState().newProject();
  useUiStore.setState({ toasts: [], offlineSources: [] });
  useCameraStore.setState({ status: 'idle', devices: [], width: null, height: null, frameRate: null } as never);
  useCaptureStore.setState({ sourceId: null, kind: null, status: 'idle', windows: [], chosenWindowId: null, displays: [] } as never);
  vi.spyOn(cameraManager, 'start').mockResolvedValue(undefined as never);
  vi.spyOn(cameraManager, 'stop').mockImplementation(() => undefined);
  vi.spyOn(cameraManager, 'selectDevice').mockResolvedValue(undefined as never);
  vi.spyOn(captureManager, 'start').mockResolvedValue(undefined as never);
  vi.spyOn(captureManager, 'stop').mockImplementation(() => undefined);
  vi.spyOn(captureManager, 'chooseWindow').mockResolvedValue(undefined as never);
  vi.spyOn(captureManager, 'selectWindow').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('files', () => {
  const files = {
    sources: [
      { id: 'v', kind: 'video' as const, path: '/m/clip.mp4', metadata: meta() },
      { id: 'i', kind: 'image' as const, path: '/m/tex.png', metadata: meta({ kind: 'image', fileName: 'tex.png', width: 512, height: 512, durationSec: null }) },
      { id: 'a', kind: 'audio' as const, path: '/m/song.wav', metadata: meta({ kind: 'audio', fileName: 'song.wav', width: null, height: null }) },
    ],
  };

  it('shows each file with its real metadata', () => {
    load(files);
    render(<LibraryPanel />);
    expect(screen.getByRole('button', { name: /clip\.mp4.*1920×1080\s+·\s+8\.3s\s+·\s+12\.3 MB/ })).toBeInTheDocument();
    expect(screen.getByText('3')).toHaveClass('library-count');
  });

  it('clicking a video points the selected layer at it and sizes the canvas to it', () => {
    load(files);
    render(<LibraryPanel />);
    fireEvent.click(screen.getByRole('button', { name: /clip\.mp4/ }));
    expect(selectedLayerOf(project()).sourceId).toBe('v');
    expect(project().composition).toMatchObject({ width: 1920, height: 1080 });
  });

  it('clicking a song makes it the soundtrack; MAT uses an image as the repeated material', () => {
    load(files);
    render(<LibraryPanel />);
    fireEvent.click(screen.getByRole('button', { name: /song\.wav/ }));
    expect(project().composition.audioSourceId).toBe('a');

    fireEvent.click(screen.getByRole('button', { name: 'MAT' }));
    expect(selectedLayerOf(project()).material).toMatchObject({ materialId: 'custom', assetPath: '/m/tex.png' });
    expect(selectedLayerOf(project()).sourceId).not.toBe('i'); // MAT does not also select it as source
  });

  it('an offline file offers relink instead of selecting it, and RELINK ALL appears', () => {
    const openMediaDialog = vi.fn(async () => []);
    vi.stubGlobal('material', { openMediaDialog });
    load(files);
    useUiStore.setState({ offlineSources: ['v'] });
    render(<LibraryPanel />);
    const row = screen.getByRole('button', { name: /clip\.mp4/ });
    expect(within(row).getByText('OFF')).toBeInTheDocument();
    fireEvent.click(row);
    expect(openMediaDialog).toHaveBeenCalled();
    expect(selectedLayerOf(project()).sourceId).not.toBe('v');
    expect(screen.getByRole('button', { name: 'RELINK ALL · 1' })).toBeInTheDocument();
  });

  it('with nothing imported there is nothing to collect or relink', () => {
    render(<LibraryPanel />);
    expect(screen.getByText('No media imported')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'COLLECT MEDIA' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /RELINK ALL/ })).not.toBeInTheDocument();
  });
});

describe('adding sources', () => {
  it('one camera, one screen, one window: each add button goes once it exists', () => {
    render(<LibraryPanel />);
    for (const name of ['+ CAMERA', '+ SCREEN', '+ WINDOW']) fireEvent.click(screen.getByRole('button', { name }));
    fireEvent.click(screen.getByRole('button', { name: '+ GENERATOR' }));
    expect(project().sources.map((s) => s.kind)).toEqual(['camera', 'screen', 'window', 'generator']);
    for (const name of ['+ CAMERA', '+ SCREEN', '+ WINDOW']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ GENERATOR' })).toBeInTheDocument();
    // adding a live input never starts it
    expect(cameraManager.start).not.toHaveBeenCalled();
    expect(captureManager.start).not.toHaveBeenCalled();
  });

  it('switching generator resets its parameters to that generator’s defaults', () => {
    load({ sources: [{ id: 'g', kind: 'generator', generator: 'noise', params: { speed: 9 }, seed: 1 }] });
    render(<LibraryPanel />);
    const select = screen.getByRole('combobox', { name: 'Generator' });
    const other = [...(select as HTMLSelectElement).options].find((o) => o.value !== 'noise')!.value;
    fireEvent.change(select, { target: { value: other } });
    const g = project().sources[0]!;
    expect(g).toMatchObject({ generator: other });
    expect((g as { params: Record<string, unknown> }).params.speed).not.toBe(9);
  });
});

describe('camera row', () => {
  beforeEach(() => load({ sources: [{ id: 'cam', kind: 'camera', deviceId: null }] }));

  it('START is the only thing that starts it; STOP while live', () => {
    render(<LibraryPanel />);
    expect(screen.getByText('NOT STARTED')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Camera'));
    expect(cameraManager.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'START' }));
    expect(cameraManager.start).toHaveBeenCalledOnce();

    act(() => useCameraStore.setState({ status: 'live', width: 1280, height: 720, frameRate: 30 } as never));
    expect(screen.getByText('LIVE · 1280×720 · 30fps')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'STOP' }));
    expect(cameraManager.stop).toHaveBeenCalledOnce();
  });

  it('a denied permission explains where to allow it', () => {
    useCameraStore.setState({ status: 'permission-denied' } as never);
    render(<LibraryPanel />);
    expect(screen.getByText(/System Settings → Privacy & Security/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'TRY AGAIN' })).toBeInTheDocument();
  });

  it('with two cameras the choice is saved in the project', () => {
    useCameraStore.setState({ status: 'live', devices: [{ deviceId: 'd1', label: 'FaceTime' }, { deviceId: 'd2', label: 'USB' }] } as never);
    render(<LibraryPanel />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Camera device' }), { target: { value: 'd2' } });
    expect(project().sources[0]).toMatchObject({ deviceId: 'd2' });
    expect(cameraManager.selectDevice).toHaveBeenCalledWith('d2');
  });
});

describe('window capture row', () => {
  beforeEach(() => load({ sources: [{ id: 'w', kind: 'window', titleHint: 'Notes' }] }));

  it('cannot start until a window is chosen, and remembers only its title', () => {
    useCaptureStore.setState({ sourceId: 'w', kind: 'window', status: 'idle', windows: [{ sourceId: 'window:7:0', title: 'Figma' }] } as never);
    render(<LibraryPanel />);
    expect(screen.getByText('Last: Notes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'START' })).toBeDisabled();

    fireEvent.change(screen.getByRole('combobox', { name: 'Window to capture' }), { target: { value: 'window:7:0' } });
    expect(captureManager.selectWindow).toHaveBeenCalledWith('window:7:0');
    expect(project().sources[0]).toMatchObject({ titleHint: 'Figma' });
    expect(JSON.stringify(project())).not.toContain('window:7:0');

    act(() => useCaptureStore.setState({ chosenWindowId: 'window:7:0' } as never));
    fireEvent.click(screen.getByRole('button', { name: 'START' }));
    expect(captureManager.start).toHaveBeenCalledOnce();
  });

  it('CHOOSE lists windows (the only step that may ask for screen recording)', () => {
    render(<LibraryPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'CHOOSE' }));
    expect(captureManager.chooseWindow).toHaveBeenCalledOnce();
  });

  it('explains a missing screen-recording permission', () => {
    useCaptureStore.setState({ sourceId: 'w', kind: 'window', status: 'permission-denied' } as never);
    render(<LibraryPanel />);
    expect(screen.getByText('SCREEN RECORDING ACCESS REQUIRED')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'TRY AGAIN' })).toBeInTheDocument();
  });
});

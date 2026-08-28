import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  OutputDestinations,
  OutputExportBar,
  OutputSettings,
  OutputStatus,
} from '@/output/OutputWorkspace';
import { useProjectStore } from '@/state/projectStore';
import { useExportStore } from '@/state/exportStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useUiStore } from '@/state/uiStore';
import { createEmptyProject, type Project } from '@shared/schemas/project';

function setProject(mutate: (p: Project) => Project) {
  useProjectStore.setState({ project: mutate(createEmptyProject('OUT test')) });
}

const videoSource = {
  id: 'src1',
  kind: 'video' as const,
  path: '/media/BALAS.mp4',
  metadata: {
    kind: 'video' as const,
    path: '/media/BALAS.mp4',
    fileName: 'BALAS.mp4',
    fileSize: 4_000_000,
    durationSec: 32.5,
    width: 3840,
    height: 2160,
    frameRate: 25,
    videoCodec: 'h264',
    audioCodec: null,
    audioChannels: null,
    sampleRate: null,
  },
};

const audioSource = {
  id: 'aud1',
  kind: 'audio' as const,
  path: '/media/BALAS.m4a',
  metadata: {
    kind: 'audio' as const,
    path: '/media/BALAS.m4a',
    fileName: 'BALAS.m4a',
    fileSize: 900_000,
    durationSec: 32.5,
    width: null,
    height: null,
    frameRate: null,
    videoCodec: null,
    audioCodec: 'aac',
    audioChannels: 2,
    sampleRate: 44100,
  },
};

beforeEach(() => {
  setProject((p) => p);
  useExportStore.setState({
    dialogOpen: false,
    phase: 'idle',
    progress: 0,
    totalFrames: 0,
    message: null,
  });
  usePlaybackStore.setState({ durationSec: 0 });
  useUiStore.setState({ workspace: 'output', offlineSources: [] });
});

afterEach(() => cleanup());

describe('destinations', () => {
  it('marks EDITOR PREVIEW as the active live destination', () => {
    render(<OutputDestinations selected="editor" onSelect={() => {}} />);
    const editor = screen.getByText('EDITOR PREVIEW').closest('button');
    expect(editor).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
    expect(document.querySelector('.output-dest-dot.live')).not.toBeNull();
  });

  it('lets FILE EXPORT be selected', () => {
    let selected = '';
    render(<OutputDestinations selected="editor" onSelect={(id) => (selected = id)} />);
    fireEvent.click(screen.getByText('FILE EXPORT'));
    expect(selected).toBe('file');
  });

  it('never lists camera or screen capture — sources are not destinations', () => {
    render(<OutputDestinations selected="editor" onSelect={() => {}} />);
    expect(screen.queryByText(/CAMERA/)).not.toBeInTheDocument();
    expect(screen.queryByText(/SCREEN INPUT/)).not.toBeInTheDocument();
    expect(screen.queryByText(/NDI/)).not.toBeInTheDocument();
  });

  it('groups the future rows under LIVE OUTPUT and INTEROP headings', () => {
    render(<OutputDestinations selected="editor" onSelect={() => {}} />);
    expect(screen.getByText('LIVE OUTPUT — v0.3')).toBeInTheDocument();
    expect(screen.getByText('INTEROP — FUTURE')).toBeInTheDocument();
    expect(screen.getByText('SYPHON').closest('button')).toBeDisabled();
    expect(screen.getByText('RESEARCH')).toBeInTheDocument();
  });
});

describe('settings from real project state', () => {
  it('shows project vs source resolution separately when they differ', () => {
    setProject((p) => ({
      ...p,
      sources: [videoSource],
      composition: { ...p.composition, sourceId: 'src1', width: 1920, height: 1080 },
    }));
    render(<OutputSettings />);
    expect(screen.getByText('1920 × 1080')).toBeInTheDocument();
    expect(screen.getByText('SOURCE RES')).toBeInTheDocument();
    expect(screen.getByText('3840 × 2160')).toBeInTheDocument();
    expect(screen.getByText('SOURCE FPS')).toBeInTheDocument();
    expect(screen.getByText('25.00')).toBeInTheDocument();
    expect(screen.getByText('BALAS.mp4')).toBeInTheDocument();
  });

  it('shows audio file and BPM only from real state, NONE otherwise', () => {
    setProject((p) => ({
      ...p,
      sources: [audioSource],
      composition: { ...p.composition, audioSourceId: 'aud1' },
      timeline: { ...p.timeline, bpm: 78.03 },
    }));
    const { unmount } = render(<OutputSettings />);
    expect(screen.getByText('BALAS.m4a')).toBeInTheDocument();
    expect(screen.getByText('78.03')).toBeInTheDocument();
    unmount();

    setProject((p) => p);
    render(<OutputSettings />);
    // Both SOURCE and AUDIO honestly read NONE on an empty project.
    expect(screen.getAllByText('NONE')).toHaveLength(2);
  });

  it('CONFIGURE EXPORT opens the one real export dialog', () => {
    render(<OutputSettings />);
    fireEvent.click(screen.getByText('CONFIGURE EXPORT'));
    expect(useExportStore.getState().dialogOpen).toBe(true);
  });
});

describe('export status', () => {
  it('reflects the real export store phases', () => {
    const { rerender } = render(<OutputStatus />);
    expect(screen.getByText('IDLE')).toBeInTheDocument();

    useExportStore.setState({ phase: 'running', progress: 842, totalFrames: 1350 });
    rerender(<OutputStatus />);
    expect(screen.getByText('RENDERING')).toBeInTheDocument();
    expect(screen.getByText('842 / 1350')).toBeInTheDocument();
    expect(screen.getByText('62%')).toBeInTheDocument();

    useExportStore.setState({ phase: 'done', message: 'MATERIAL-01.mp4' });
    rerender(<OutputStatus />);
    expect(screen.getByText('COMPLETE')).toBeInTheDocument();
    expect(screen.getByText('MATERIAL-01.mp4')).toBeInTheDocument();
  });
});

describe('export bar', () => {
  it('opens the existing ExportDialog from EXPORT', () => {
    setProject((p) => ({
      ...p,
      sources: [videoSource],
      composition: { ...p.composition, sourceId: 'src1' },
    }));
    render(<OutputExportBar hasSource emphasized={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Export/i }));
    expect(useExportStore.getState().dialogOpen).toBe(true);
  });

  it('disables EXPORT with a stated reason when there is no media', () => {
    render(<OutputExportBar hasSource={false} emphasized={false} />);
    expect(screen.getByRole('button', { name: /Export/i })).toBeDisabled();
    expect(screen.getByText('NO MEDIA')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Export/i }));
    expect(useExportStore.getState().dialogOpen).toBe(false);
  });
});

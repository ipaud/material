import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EmptyState } from '@/components/EmptyState';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { addCaptureSource } from '@/projects/projectActions';
import { playback } from '@/playback/PlaybackController';
import { usePlaybackStore } from '@/state/playbackStore';
import { createEmptyProject } from '@shared/schemas/project';

// Starting a generator now starts the transport; jsdom has no preload bridge.
beforeEach(() => {
  vi.spyOn(playback, 'play').mockImplementation(() => usePlaybackStore.getState().setPlaying(true));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useProjectStore.getState().newProject();
  useUiStore.setState({ toasts: [] });
});

describe('first-run BUILD', () => {
  it('starts a complete system from a curated recipe', () => {
    render(<EmptyState isDragOver={false} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Start with a recipe' }), {
      target: { value: 'noise-grid' },
    });
    const project = useProjectStore.getState().project;
    expect(project.sources[0]).toMatchObject({ kind: 'generator', generator: 'noise' });
    expect(project.layers[0]?.technique?.techniqueId).toBe('mosaic');
    expect(project.macros[0]?.name).toBe('DENSITY');
    expect(project.performancePads[0]?.label).toBe('PULSE');
  });

  it('a recipe or a generator start leaves the system running, not frozen', () => {
    const play = vi.mocked(playback.play);
    usePlaybackStore.getState().setPlaying(false);
    render(<EmptyState isDragOver={false} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Start with a recipe' }), {
      target: { value: 'noise-grid' },
    });
    expect(play).toHaveBeenCalledOnce();

    usePlaybackStore.getState().setPlaying(false);
    fireEvent.click(screen.getByRole('button', { name: 'NOTHING' }));
    fireEvent.click(screen.getByRole('button', { name: 'GRID' }));
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('moves keyboard focus to new source control after starting a recipe', () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return 1;
    });
    render(<EmptyState isDragOver={false} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Start with a recipe' }), {
      target: { value: 'noise-grid' },
    });

    const sourceId = useProjectStore.getState().project.layers[0]!.sourceId!;
    const row = document.createElement('div');
    row.dataset.sourceId = sourceId;
    const control = document.createElement('button');
    row.append(control);
    document.body.append(row);
    try {
      frameCallbacks[0]?.(0);
      expect(control).toHaveFocus();
    } finally {
      row.remove();
    }
  });

  it('reveals direct generator choices from NOTHING', () => {
    render(<EmptyState isDragOver={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'NOTHING' }));
    fireEvent.click(screen.getByRole('button', { name: 'GRID' }));
    expect(useProjectStore.getState().project.sources[0]).toMatchObject({
      kind: 'generator',
      generator: 'grid',
    });
    expect(useProjectStore.getState().project.layers[0]?.technique?.techniqueId).toBe('mosaic');
  });

  it('selects an already-added capture source instead of pretending to add another', () => {
    const project = createEmptyProject();
    useProjectStore.setState({
      project: {
        ...project,
        sources: [{ id: 'screen-existing', kind: 'screen', displayId: null }],
      },
    });
    expect(addCaptureSource('screen')).toBe(true);
    expect(useProjectStore.getState().project.composition.sourceId).toBe('screen-existing');
  });
});

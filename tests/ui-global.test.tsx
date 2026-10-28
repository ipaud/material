import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WorkspaceNav } from '@/app/WorkspaceNav';
import { ShortcutsOverlay } from '@/app/ShortcutsOverlay';
import { WorkspaceEmpty } from '@/components/WorkspaceEmpty';
import { PerformWorkspace } from '@/workspaces/PerformWorkspace';
import { useUiStore } from '@/state/uiStore';
import { useProjectStore } from '@/state/projectStore';
import { createEmptyProject } from '@shared/schemas/project';

beforeEach(() => {
  useProjectStore.setState({ project: createEmptyProject('Global test') });
  useUiStore.setState({ workspace: 'build', showShortcuts: false, perfHud: false });
});

afterEach(() => cleanup());

describe('navigation is the only workspace surface', () => {
  it('shows exactly the four UI v2 workspaces — no legacy labels', () => {
    render(<WorkspaceNav />);
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['BUILD', 'EXPLORE', 'PLAY', 'OUTPUT']);
    expect(screen.queryByText('CREATE')).not.toBeInTheDocument();
    expect(screen.queryByText('TECHNIQUES')).not.toBeInTheDocument();
    expect(screen.queryByText('MODULATION')).not.toBeInTheDocument();
    expect(screen.queryByText('PERFORM')).not.toBeInTheDocument();
  });

  it('has no legacy bottom tab strip', () => {
    render(<WorkspaceNav />);
    expect(document.querySelector('.workspace-tabs')).toBeNull();
  });
});

describe('shortcuts overlay', () => {
  it('documents only real bindings, grouped honestly', () => {
    useUiStore.setState({ showShortcuts: true });
    render(<ShortcutsOverlay />);
    expect(screen.getByText('Global')).toBeInTheDocument();
    expect(screen.getByText('Candidate (Explore + Play)')).toBeInTheDocument();
    expect(screen.getByText('Play only')).toBeInTheDocument();
    expect(screen.getByText('BUILD · EXPLORE · PLAY · OUTPUT')).toBeInTheDocument();
    // Legacy workspace names must not appear as key targets.
    expect(screen.queryByText(/PERFORMANCE/)).not.toBeInTheDocument();
  });

  it('opens and closes from the store', () => {
    const { rerender } = render(<ShortcutsOverlay />);
    expect(document.querySelector('.shortcuts-card')).toBeNull();
    useUiStore.setState({ showShortcuts: true });
    rerender(<ShortcutsOverlay />);
    expect(document.querySelector('.shortcuts-card')).not.toBeNull();
  });
});

describe('shared empty states', () => {
  it('WorkspaceEmpty routes to BUILD', () => {
    useUiStore.setState({ workspace: 'output' });
    render(<WorkspaceEmpty title="NOTHING TO OUTPUT" hint="hint" />);
    fireEvent.click(screen.getByText('GO TO BUILD'));
    expect(useUiStore.getState().workspace).toBe('build');
  });

  it('PERFORM without a system shows BUILD A SYSTEM FIRST instead of strips', () => {
    useUiStore.setState({ workspace: 'perform' });
    render(<PerformWorkspace />);
    expect(screen.getByText('BUILD A SYSTEM FIRST')).toBeInTheDocument();
    expect(document.querySelector('.perf-looks')).toBeNull();
    expect(document.querySelector('canvas')).toBeNull();
  });
});

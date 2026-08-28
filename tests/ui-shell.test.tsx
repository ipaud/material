import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { normalizeWorkspace, useUiStore } from '@/state/uiStore';
import { WorkspaceNav } from '@/app/WorkspaceNav';
import { OutputDestinationList } from '@/output/OutputWorkspace';

afterEach(() => {
  cleanup();
  useUiStore.setState({ workspace: 'build', techniquesOpen: false });
});

describe('workspace migration', () => {
  it('maps every old workspace id onto a UI v2 workspace', () => {
    expect(normalizeWorkspace('create')).toBe('build');
    expect(normalizeWorkspace('techniques')).toBe('build');
    expect(normalizeWorkspace('modulation')).toBe('build');
    expect(normalizeWorkspace('performance')).toBe('perform');
  });

  it('falls back to BUILD for an unknown id rather than rendering nothing', () => {
    expect(normalizeWorkspace('nonsense')).toBe('build');
    expect(normalizeWorkspace('')).toBe('build');
  });

  it('keeps the new ids untouched', () => {
    for (const id of ['build', 'explore', 'perform', 'output']) {
      expect(normalizeWorkspace(id)).toBe(id);
    }
  });

  it('normalizes through setWorkspace so a stale caller cannot blank the shell', () => {
    useUiStore.getState().setWorkspace('performance');
    expect(useUiStore.getState().workspace).toBe('perform');
    useUiStore.getState().setWorkspace('techniques');
    expect(useUiStore.getState().workspace).toBe('build');
  });
});

describe('WorkspaceNav', () => {
  it('renders the four workspaces and marks the active one for assistive tech', () => {
    render(<WorkspaceNav />);
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['BUILD', 'EXPLORE', 'PERFORM', 'OUTPUT']);
    expect(screen.getByText('BUILD')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('PERFORM')).not.toHaveAttribute('aria-current');
  });

  it('switches the workspace on click', () => {
    render(<WorkspaceNav />);
    fireEvent.click(screen.getByText('PERFORM'));
    expect(useUiStore.getState().workspace).toBe('perform');
    fireEvent.click(screen.getByText('OUTPUT'));
    expect(useUiStore.getState().workspace).toBe('output');
  });
});

describe('OUTPUT future destinations', () => {
  it('renders unsupported v0.3 destinations as inert, labelled controls', () => {
    render(<OutputDestinationList />);
    const future = [
      'Fullscreen',
      'Second Display',
      'Syphon',
      'NDI',
      'Camera Input',
      'Screen Input',
    ];
    for (const name of future) {
      const button = screen.getByText(name).closest('button');
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('aria-disabled', 'true');
      // Clicking must do nothing at all — no handler, no state change.
      fireEvent.click(button!);
    }
    expect(screen.getAllByText('NOT AVAILABLE · v0.3')).toHaveLength(future.length);
    expect(useUiStore.getState().workspace).toBe('build');
  });
});

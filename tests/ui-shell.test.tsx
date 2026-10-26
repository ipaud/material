import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { normalizeWorkspace, useUiStore } from '@/state/uiStore';
import { WorkspaceNav } from '@/app/WorkspaceNav';
import { OutputDestinations } from '@/output/OutputWorkspace';

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
    expect(labels).toEqual(['BUILD', 'EXPLORE', 'PLAY', 'OUTPUT']);
    expect(screen.getByText('BUILD')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('PLAY')).not.toHaveAttribute('aria-current');
  });

  it('switches the workspace on click', () => {
    render(<WorkspaceNav />);
    fireEvent.click(screen.getByText('PLAY'));
    expect(useUiStore.getState().workspace).toBe('perform');
    fireEvent.click(screen.getByText('OUTPUT'));
    expect(useUiStore.getState().workspace).toBe('output');
  });
});

describe('OUTPUT future destinations', () => {
  it('renders unsupported destinations as inert, labelled controls', () => {
    render(<OutputDestinations selected="editor" onSelect={() => {}} />);
    // FULLSCREEN stopped being a placeholder in 18C: it is the DISPLAY
    // destination's mode. What remains genuinely unavailable stays inert.
    for (const name of ['SECOND DISPLAY', 'SYPHON']) {
      const button = screen.getByText(name).closest('button');
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('aria-disabled', 'true');
      // Clicking must do nothing at all — no handler, no state change.
      fireEvent.click(button!);
    }
    expect(useUiStore.getState().workspace).toBe('build');
  });

  it('DISPLAY is a real, selectable destination', () => {
    let picked: string | null = null;
    render(<OutputDestinations selected="editor" onSelect={(id) => (picked = id)} />);
    const button = screen.getByText('DISPLAY').closest('button');
    expect(button).not.toBeDisabled();
    fireEvent.click(button!);
    expect(picked).toBe('display');
  });
});

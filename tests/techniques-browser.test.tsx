import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { selectedLayerOf } from '@shared/schemas/project';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';

/** The technique browser: previews arrive progressively, a card applies its technique, filters narrow. */

const h = vi.hoisted(() => ({ fail: false, disposed: 0 }));
vi.mock('@/techniques/preview/previewRenderer', () => ({
  PREVIEW_PARAMS: { 'mosaic-temporal': { timeMode: 'radial' } },
  TechniquePreviewRenderer: class {
    constructor() {
      if (h.fail) throw new Error('no WebGL');
    }
    async render(_technique: string, card: string) {
      return `data:image/png;base64,${card}`;
    }
    dispose() {
      h.disposed++;
    }
  },
}));

const { TechniquesBrowser } = await import('@/techniques/TechniquesBrowser');
const layer = () => selectedLayerOf(useProjectStore.getState().project);

beforeEach(() => {
  h.fail = false;
  h.disposed = 0;
  useProjectStore.getState().newProject();
  useUiStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('techniques browser', () => {
  it('renders a preview per card, then stops saying it is generating', async () => {
    render(<TechniquesBrowser />);
    expect(screen.getByText('generating previews…')).toBeInTheDocument();
    await screen.findByText('Slit Scan');
    await vi.waitFor(() => expect(screen.queryByText('generating previews…')).not.toBeInTheDocument());
    expect(document.querySelectorAll('.technique-thumb img')).toHaveLength(5);
    expect(h.disposed).toBe(1);
  });

  it('without WebGL the cards still work, just without pictures', async () => {
    h.fail = true;
    render(<TechniquesBrowser />);
    await vi.waitFor(() => expect(screen.queryByText('generating previews…')).not.toBeInTheDocument());
    expect(document.querySelectorAll('.technique-thumb img')).toHaveLength(0);
    fireEvent.click(screen.getByTitle('Apply Echo'));
    expect(layer().technique?.techniqueId).toBe('echo');
  });

  it('applying a card sets the technique with its preview settings, clears mappings and closes', () => {
    const toggle = vi.spyOn(useUiStore.getState(), 'toggleTechniques');
    useProjectStore.getState().apply((p) => ({ ...p, modulations: [{ id: 'm' }] as never }));
    render(<TechniquesBrowser />);
    fireEvent.click(screen.getByTitle('Apply Temporal Mosaic'));
    expect(layer().technique).toMatchObject({ techniqueId: 'mosaic', enabled: true, params: { timeMode: 'radial' } });
    expect(useProjectStore.getState().project.modulations).toEqual([]);
    expect(useUiStore.getState().toasts.at(-1)?.message).toBe('Temporal Mosaic applied');
    expect(toggle).toHaveBeenCalled();
  });

  it('filters by category and marks the active technique', () => {
    render(<TechniquesBrowser />);
    fireEvent.click(screen.getByRole('button', { name: 'SPACE' }));
    const cards = () => [...document.querySelectorAll('.technique-card')].map((c) => c.getAttribute('title'));
    expect(cards()).toEqual(['Apply Mosaic']);
    fireEvent.click(screen.getByRole('button', { name: 'IMAGE' }));
    expect(cards()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'ALL' }));
    fireEvent.click(screen.getByTitle('Apply Step Print'));
    expect(screen.getByTitle('Apply Step Print')).toHaveClass('active');
  });
});

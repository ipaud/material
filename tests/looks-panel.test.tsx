import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useProjectStore } from '@/state/projectStore';

/** The Pins / Looks grid and the Morph launcher, as a performer uses them. */

const h = vi.hoisted(() => ({
  recall: vi.fn(),
  morph: vi.fn(),
  explore: vi.fn(),
  still: vi.fn(async () => undefined),
  morphRuntime: {
    current: null as null | { targetLabel: string },
    stats: null as null | { interpolated: number; switched: number },
    progressAt: vi.fn(() => 0.42),
    setTransition: vi.fn(),
    cancelKeep: vi.fn(),
  },
}));
vi.mock('@/performance/take/gestures', () => ({ performLookRecall: h.recall, performMorph: h.morph }));
vi.mock('@/explore/exploreActions', () => ({ exploreAroundPin: h.explore }));
vi.mock('@/export/exportStill', () => ({ exportPngStill: h.still }));
vi.mock('@/performance/morphRuntime', () => ({ morphRuntime: h.morphRuntime }));
vi.mock('@/performance/thumbnail', () => ({ renderThumbnail: () => ({ dataUrl: 'data:image/png;base64,AA', luminance: 0.5 }), isDarkThumbnail: () => false }));
vi.mock('@/playback/PlaybackController', () => ({ playback: { getTime: () => 1 } }));

const { LooksPanel } = await import('@/library/LooksPanel');
const { addGeneratorSource } = await import('@/projects/projectActions');
const { overwriteSlotWithCurrent, pinCurrentLook } = await import('@/projects/lookActions');

const looks = () => useProjectStore.getState().project.pinnedLooks;
const menu = (label: string) => fireEvent.click(screen.getByRole('button', { name: `Actions for ${label}` }));

beforeEach(() => {
  vi.useFakeTimers();
  useProjectStore.getState().newProject();
  addGeneratorSource('noise');
  h.morphRuntime.current = null;
  h.morphRuntime.stats = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('the grid', () => {
  it('shows nothing until something is pinned', () => {
    const { container } = render(<LooksPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it('a card recalls its Look and names its key', () => {
    overwriteSlotWithCurrent(3);
    render(<LooksPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply LOOK 03 (key 3)' }));
    expect(h.recall).toHaveBeenCalledWith(looks()[0]!.id);
  });

  it('marks the active Look as changed once the state moves away from it, and offers to update it', () => {
    overwriteSlotWithCurrent(1);
    render(<LooksPanel />);
    expect(screen.queryByTitle('Current state differs from this look')).not.toBeInTheDocument();
    act(() =>
      useProjectStore.getState().apply((p) => ({
        ...p,
        layers: p.layers.map((l) => ({ ...l, technique: l.technique && { ...l.technique, params: { ...l.technique.params, scale: 1.77 } } })),
      })),
    );
    expect(screen.getByTitle('Current state differs from this look')).toBeInTheDocument();
    menu('LOOK 01');
    fireEvent.click(screen.getByRole('button', { name: 'Update with current' }));
    expect(screen.queryByTitle('Current state differs from this look')).not.toBeInTheDocument();
  });
});

describe('the actions menu', () => {
  it('a Pin offers Explore Around and Make Look; a Look does not', () => {
    pinCurrentLook();
    render(<LooksPanel />);
    menu('PIN 001');
    fireEvent.click(screen.getByRole('button', { name: 'Explore Around' }));
    expect(h.explore).toHaveBeenCalledWith(looks()[0]);
    menu('PIN 001');
    fireEvent.click(screen.getByRole('button', { name: 'Make Look' }));
    expect(looks()[0]).toMatchObject({ slot: 1, label: 'LOOK 01' });
    menu('LOOK 01');
    expect(screen.queryByRole('button', { name: 'Make Look' })).not.toBeInTheDocument();
  });

  it('rename by menu or double-click; Escape cancels, Enter keeps', () => {
    pinCurrentLook();
    render(<LooksPanel />);
    menu('PIN 001');
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByDisplayValue('PIN 001');
    fireEvent.change(input, { target: { value: 'Chorus' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(looks()[0]!.label).toBe('PIN 001');

    fireEvent.doubleClick(screen.getByText('PIN 001', { selector: '.look-name' }));
    const again = screen.getByDisplayValue('PIN 001');
    fireEvent.change(again, { target: { value: 'Chorus' } });
    fireEvent.keyDown(again, { key: 'Enter' });
    expect(looks()[0]!.label).toBe('Chorus');
  });

  it('duplicate, delete, re-thumbnail and export still', () => {
    pinCurrentLook();
    render(<LooksPanel />);
    menu('PIN 001');
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    expect(looks().map((l) => l.label)).toEqual(['PIN 001', 'PIN 001 COPY']);
    menu('PIN 001 COPY');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(looks()).toHaveLength(1);
    menu('PIN 001');
    fireEvent.click(screen.getByRole('button', { name: 'Export Still' }));
    expect(h.still).toHaveBeenCalledWith(looks()[0]!.id);
    menu('PIN 001');
    fireEvent.click(screen.getByRole('button', { name: 'Re-thumbnail' }));
    expect(looks()[0]!.thumbnail).toBe('data:image/png;base64,AA');
  });

  it('hold to compare previews while held, by pointer or keyboard', () => {
    pinCurrentLook();
    render(<LooksPanel />);
    menu('PIN 001');
    const hold = screen.getByRole('button', { name: 'HOLD TO COMPARE' });
    fireEvent.pointerDown(hold);
    expect(useProjectStore.getState().previewLabel).toBe('Compare PIN 001');
    expect(hold).toHaveAttribute('aria-pressed', 'true');
    fireEvent.pointerUp(hold);
    expect(useProjectStore.getState().previewLabel).toBeNull();
    fireEvent.keyDown(hold, { key: ' ' });
    expect(useProjectStore.getState().previewLabel).toBe('Compare PIN 001');
    fireEvent.keyUp(hold, { key: ' ' });
    expect(useProjectStore.getState().previewLabel).toBeNull();
  });

  it('Escape closes the menu', () => {
    pinCurrentLook();
    render(<LooksPanel />);
    menu('PIN 001');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Rename' }), { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
  });
});

describe('morph launcher', () => {
  it('needs a target; musical starts and lengths need a BPM', () => {
    overwriteSlotWithCurrent(2);
    render(<LooksPanel />);
    expect(screen.getByRole('button', { name: 'MORPH' })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Next Bar' })).toBeDisabled();
    expect(screen.getByRole('option', { name: '2 s' })).toBeEnabled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Morph to Look' }), { target: { value: looks()[0]!.id } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Morph duration' }), { target: { value: '5s' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Morph curve' }), { target: { value: 'linear' } });
    fireEvent.click(screen.getByRole('button', { name: 'MORPH' }));
    expect(h.morph).toHaveBeenCalledWith(looks()[0]!.id, { mode: 'seconds', seconds: 5 }, 'linear', 'off');
  });

  it('style and cancel go to the morph runtime; progress is shown while morphing', () => {
    overwriteSlotWithCurrent(2);
    render(<LooksPanel />);
    const style = screen.getByRole('combobox', { name: 'Transition style' }) as HTMLSelectElement;
    const other = [...style.options].find((o) => o.value !== 'smooth')!.value;
    fireEvent.change(style, { target: { value: other } });
    expect(h.morphRuntime.setTransition).toHaveBeenCalledWith({ style: other });
    fireEvent.click(screen.getByTitle('Cancel & keep current state'));
    expect(h.morphRuntime.cancelKeep).toHaveBeenCalled();

    h.morphRuntime.current = { targetLabel: 'LOOK 02' };
    h.morphRuntime.stats = { interpolated: 12, switched: 2 };
    act(() => vi.advanceTimersByTime(150));
    expect(screen.getByText('MORPHING → LOOK 02 · 42% · 12 lerped / 2 switched')).toBeInTheDocument();
  });
});

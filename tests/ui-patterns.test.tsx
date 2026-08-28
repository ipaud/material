import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PatternsSection } from '@/patterns/PatternsSection';
import { SystemPath } from '@/build/SystemPath';
import { useProjectStore } from '@/state/projectStore';
import { modulationRuntime } from '@/modulation/runtime';
import { resetPatternRuntime, resolvePatternHandles, patternSourceKey } from '@/pattern/patternSourceRuntime';
import { getTechnique } from '@/techniques/registry';
import { defaultParams } from '@/techniques/types';
import {
  createEmptyProject,
  parseProject,
  projectSchema,
  type ModulationMapping,
  type PatternSource,
  type Project,
} from '@shared/schemas/project';

/** P8 — BUILD pattern editor. Behaviour, not pixels. */

const mosaic = getTechnique('mosaic')!;

function mapping(over: Partial<ModulationMapping> = {}): ModulationMapping {
  return {
    id: 'mod-1',
    enabled: true,
    source: patternSourceKey('pat-a'),
    target: 'scale',
    amount: 0.5,
    min: 0,
    max: 1,
    invert: false,
    smoothing: 0,
    curve: 'linear',
    frozenValue: null,
    ...over,
  };
}

function pattern(over: Partial<PatternSource> = {}): PatternSource {
  return {
    id: 'pat-a',
    enabled: true,
    beatsPerCycle: 4,
    pattern: { type: 'sequence', values: [0, 1] },
    transforms: [],
    ...over,
  };
}

function loadProject(over: Partial<Project> = {}): Project {
  const base = createEmptyProject('P8');
  const project: Project = {
    ...base,
    techniques: [
      { id: 'tech-1', techniqueId: 'mosaic', enabled: true, params: defaultParams(mosaic) },
    ],
    timeline: { ...base.timeline, bpm: 96 },
    explore: { lockedParams: [], lastSeed: 12345 },
    ...over,
  };
  useProjectStore.setState({ project, past: [], future: [], transientBase: null, dirty: false });
  resetPatternRuntime();
  modulationRuntime.reset();
  return project;
}

const store = () => useProjectStore.getState();
const source = () => store().project.patternSources[0]!;

/** Live resolved params through the real runtime (what FrameState carries). */
function live(t: number): Record<string, unknown> {
  const project = store().project;
  const instance = project.techniques.find((tq) => tq.enabled) ?? null;
  modulationRuntime.configure(project.modulations, instance?.techniqueId ?? null, {
    analysis: null,
    durationSec: 600,
    bpm: project.timeline.bpm,
    beatOffsetSec: project.timeline.beatOffsetSec,
    beatsPerBar: project.timeline.beatsPerBar,
    patterns: resolvePatternHandles(project.patternSources),
    projectSeed: project.explore.lastSeed ?? 1,
  });
  return modulationRuntime.transform(
    { ...defaultParams(mosaic), ...(instance?.params ?? {}) },
    t,
  ) as Record<string, unknown>;
}

/** Open the editor for the first pattern row. */
function openFirst() {
  fireEvent.click(screen.getByRole('button', { expanded: false }));
}

beforeEach(() => {
  vi.useRealTimers();
  resetPatternRuntime();
  modulationRuntime.reset();
});
afterEach(cleanup);

// ---------------------------------------------------------------------------
// List, creation, status
// ---------------------------------------------------------------------------

describe('pattern list', () => {
  it('shows an empty state and creates a pattern with sane defaults', () => {
    loadProject();
    render(<PatternsSection />);
    expect(screen.getByText(/Temporal sequences/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+ ADD' }));
    const created = store().project.patternSources;
    expect(created).toHaveLength(1);
    expect(created[0]!.pattern).toEqual({ type: 'sequence', values: [0, 1] });
    expect(created[0]!.beatsPerCycle).toBe(4);
    expect(created[0]!.enabled).toBe(true);
    expect(created[0]!.transforms).toEqual([]);
    expect(created[0]!.id).toMatch(/^pat_/);
    expect(store().past).toHaveLength(1); // exactly one history entry
    expect(screen.getByText('PAT 01')).toBeInTheDocument();
  });

  it('labels are positional and never expose the stable id', () => {
    loadProject({
      patternSources: [pattern({ id: 'pat-a' }), pattern({ id: 'pat-b' })],
    });
    const { container } = render(<PatternsSection />);
    expect(screen.getByText('PAT 01')).toBeInTheDocument();
    expect(screen.getByText('PAT 02')).toBeInTheDocument();
    expect(container.textContent).not.toContain('pat-a');
  });

  it('reports each status as text, not colour alone', () => {
    // UNMAPPED — no mapping references it.
    loadProject({ patternSources: [pattern()] });
    const { rerender } = render(<PatternsSection />);
    expect(screen.getByText('UNMAPPED')).toBeInTheDocument();

    // LIVE — mapped, enabled, BPM present.
    loadProject({ patternSources: [pattern()], modulations: [mapping()] });
    rerender(<PatternsSection />);
    expect(screen.getByText('LIVE')).toBeInTheDocument();

    // NO BPM — pattern exists, contributes nothing.
    const base = createEmptyProject('x');
    loadProject({
      patternSources: [pattern()],
      modulations: [mapping()],
      timeline: { ...base.timeline, bpm: null },
    });
    rerender(<PatternsSection />);
    expect(screen.getByText('NO BPM')).toBeInTheDocument();

    // DISABLED wins over everything else.
    loadProject({ patternSources: [pattern({ enabled: false })], modulations: [mapping()] });
    rerender(<PatternsSection />);
    expect(screen.getByText('DISABLED')).toBeInTheDocument();

    // INVALID — structurally fine, semantically impossible.
    loadProject({
      patternSources: [
        pattern({
          pattern: { type: 'euclidean', pulses: 9, steps: 8, rotation: 0, activeValue: 1, inactiveValue: 0 },
        }),
      ],
      modulations: [mapping()],
    });
    rerender(<PatternsSection />);
    expect(screen.getByText('INVALID')).toBeInTheDocument();
  });

  it('enable/disable is a toggle that keeps the definition and is undoable', () => {
    loadProject({ patternSources: [pattern()], modulations: [mapping()] });
    render(<PatternsSection />);
    const toggle = screen.getByRole('switch', { name: /PAT 01 enabled/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    expect(source().enabled).toBe(false);
    expect(source().pattern).toEqual({ type: 'sequence', values: [0, 1] });
    act(() => store().undo());
    expect(source().enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sequence editing
// ---------------------------------------------------------------------------

describe('sequence editor', () => {
  it('shows canonical text and commits a settled valid edit once', async () => {
    vi.useFakeTimers();
    loadProject({
      patternSources: [pattern({ pattern: { type: 'sequence', values: [0, 0.25, 1, 0.25] } })],
      modulations: [mapping()],
    });
    render(<PatternsSection />);
    openFirst();
    const input = screen.getByLabelText('Pattern steps') as HTMLInputElement;
    expect(input.value).toBe('0 0.25 1 0.25');

    const historyBefore = store().past.length;
    // Type in pieces; only the settled result commits.
    for (const text of ['0 0.25 1 0.5', '0 0.25 1 0.75']) {
      fireEvent.change(input, { target: { value: text } });
    }
    expect(store().past).toHaveLength(historyBefore); // nothing yet
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(store().past).toHaveLength(historyBefore + 1); // one entry, not two
    expect(source().pattern).toEqual({ type: 'sequence', values: [0, 0.25, 1, 0.75] });
    vi.useRealTimers();
  });

  it('an invalid draft stays visible, keeps the last valid pattern, and writes nothing', async () => {
    vi.useFakeTimers();
    loadProject({ patternSources: [pattern()], modulations: [mapping()] });
    render(<PatternsSection />);
    openFirst();
    const before = live(1.1);
    const input = screen.getByLabelText('Pattern steps') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '0 .5 1 .' } });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/Invalid · last valid active/i)).toBeInTheDocument();
    expect(screen.getByText(/Unexpected token "\."/)).toBeInTheDocument();
    expect(input.value).toBe('0 .5 1 .'); // the draft is not rewritten under the user
    expect(source().pattern).toEqual({ type: 'sequence', values: [0, 1] });
    expect(store().dirty).toBe(false);
    expect(store().past).toHaveLength(0);
    expect(live(1.1)).toEqual(before); // runtime untouched

    // Finishing the edit commits once and clears the error.
    fireEvent.change(input, { target: { value: '0 .5 1 .25' } });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByText(/Invalid · last valid active/i)).not.toBeInTheDocument();
    expect(source().pattern).toEqual({ type: 'sequence', values: [0, 0.5, 1, 0.25] });
    expect(store().dirty).toBe(true);
    expect(live(1.1)).not.toEqual(before);
    vi.useRealTimers();
  });

  it('editing keeps the id, transforms, cycle, enabled state and mappings', async () => {
    vi.useFakeTimers();
    loadProject({
      patternSources: [
        pattern({
          beatsPerCycle: 8,
          transforms: [
            { type: 'fast', factor: 2 },
            { type: 'every', cycles: 4, transform: { type: 'reverse' } },
            { type: 'degrade', probability: 0.63 },
          ],
        }),
      ],
      modulations: [mapping()],
    });
    render(<PatternsSection />);
    openFirst();
    fireEvent.change(screen.getByLabelText('Pattern steps'), { target: { value: '0 .25 1 .25' } });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    const s = source();
    expect(s.id).toBe('pat-a');
    expect(s.beatsPerCycle).toBe(8);
    expect(s.enabled).toBe(true);
    expect(s.transforms).toEqual([
      { type: 'fast', factor: 2 },
      { type: 'every', cycles: 4, transform: { type: 'reverse' } },
      { type: 'degrade', probability: 0.63 },
    ]);
    expect(store().project.modulations).toEqual([mapping()]);
    vi.useRealTimers();
  });

  it('re-committing identical values does not dirty the project or add history', () => {
    loadProject({ patternSources: [pattern({ pattern: { type: 'sequence', values: [0, 0.5] } })] });
    render(<PatternsSection />);
    openFirst();
    const input = screen.getByLabelText('Pattern steps') as HTMLInputElement;
    // Same values, different whitespace and notation.
    fireEvent.change(input, { target: { value: '  0    .5  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(store().dirty).toBe(false);
    expect(store().past).toHaveLength(0);
    // A real change still commits.
    fireEvent.change(input, { target: { value: '0 .6' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(store().dirty).toBe(true);
    expect(store().past).toHaveLength(1);
  });

  it('Enter flushes immediately and Escape reverts the draft', () => {
    loadProject({ patternSources: [pattern()] });
    render(<PatternsSection />);
    openFirst();
    const input = screen.getByLabelText('Pattern steps') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '0 1 0.5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(source().pattern).toEqual({ type: 'sequence', values: [0, 1, 0.5] });

    fireEvent.change(input, { target: { value: '9 9 9' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('0 1 0.5');
    expect(source().pattern).toEqual({ type: 'sequence', values: [0, 1, 0.5] });
  });

  it('a pending valid edit is flushed on unmount (workspace switch)', () => {
    vi.useFakeTimers();
    loadProject({ patternSources: [pattern()] });
    const view = render(<PatternsSection />);
    openFirst();
    fireEvent.change(screen.getByLabelText('Pattern steps'), { target: { value: '0 1 0.5 0.25' } });
    view.unmount(); // before the debounce fires
    expect(source().pattern).toEqual({ type: 'sequence', values: [0, 1, 0.5, 0.25] });
    vi.useRealTimers();
  });

  it('an invalid draft is discarded on unmount, never committed', () => {
    loadProject({ patternSources: [pattern()] });
    const view = render(<PatternsSection />);
    openFirst();
    fireEvent.change(screen.getByLabelText('Pattern steps'), { target: { value: '0 1 ..' } });
    view.unmount();
    expect(source().pattern).toEqual({ type: 'sequence', values: [0, 1] });
    expect(store().past).toHaveLength(0);
  });

  it('typing never leaks instrument shortcuts to the window', () => {
    loadProject({ patternSources: [pattern()] });
    render(<PatternsSection />);
    openFirst();
    const seen: string[] = [];
    const listener = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener('keydown', listener);
    const input = screen.getByLabelText('Pattern steps');
    for (const key of [' ', 'g', 'b', 'f', '1', '5']) {
      fireEvent.keyDown(input, { key, bubbles: true });
    }
    window.removeEventListener('keydown', listener);
    expect(seen).toEqual([]);
  });

  it('a sequence with no text form is shown read-only rather than mangled', () => {
    loadProject({
      patternSources: [pattern({ pattern: { type: 'sequence', values: [0, true, 1] } })],
    });
    render(<PatternsSection />);
    openFirst();
    expect(screen.queryByLabelText('Pattern steps')).not.toBeInTheDocument();
    expect(screen.getByText(/structured · read only/i)).toBeInTheDocument();
    expect(screen.getByText('0 true 1')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Euclidean
// ---------------------------------------------------------------------------

describe('euclidean editor', () => {
  const euclid = (over: Record<string, number> = {}) =>
    pattern({
      pattern: {
        type: 'euclidean',
        pulses: 5,
        steps: 16,
        rotation: 0,
        activeValue: 1,
        inactiveValue: 0,
        ...over,
      },
    });

  it('edits pulses/steps/rotation through the project action', () => {
    loadProject({ patternSources: [euclid()] });
    render(<PatternsSection />);
    openFirst();
    const pulses = screen.getByLabelText('pulses');
    fireEvent.change(pulses, { target: { value: '7' } });
    fireEvent.blur(pulses);
    expect(source().pattern).toMatchObject({ pulses: 7, steps: 16 });
    const rotate = screen.getByLabelText('rotate');
    fireEvent.change(rotate, { target: { value: '-2' } });
    fireEvent.blur(rotate);
    expect(source().pattern).toMatchObject({ rotation: -2 });
    expect(source().id).toBe('pat-a');
  });

  it('renders one dot per step with the pulses marked', () => {
    loadProject({ patternSources: [euclid()] });
    const { container } = render(<PatternsSection />);
    openFirst();
    const dots = container.querySelectorAll('.pat-step');
    expect(dots).toHaveLength(16);
    const pulseIndices = [...dots].flatMap((d, i) => (d.classList.contains('pulse') ? [i] : []));
    expect(pulseIndices).toEqual([0, 3, 6, 9, 12]); // E(5,16) = 1001001001001000
  });

  it('rotation moves the dots', () => {
    loadProject({ patternSources: [euclid({ rotation: 1 })] });
    const { container } = render(<PatternsSection />);
    openFirst();
    const dots = [...container.querySelectorAll('.pat-step')];
    expect(dots.flatMap((d, i) => (d.classList.contains('pulse') ? [i] : []))).toEqual([
      1, 4, 7, 10, 13,
    ]);
  });

  it('a semantically invalid euclidean opens, explains itself and can be fixed', () => {
    loadProject({ patternSources: [euclid({ pulses: 9, steps: 8 })] });
    render(<PatternsSection />);
    openFirst();
    expect(screen.getByText(/Pulses cannot exceed steps/i)).toBeInTheDocument();
    const pulses = screen.getByLabelText('pulses');
    fireEvent.change(pulses, { target: { value: '3' } });
    fireEvent.blur(pulses);
    expect(screen.queryByText(/Pulses cannot exceed steps/i)).not.toBeInTheDocument();
  });

  it('a numeric field never writes NaN while being typed', () => {
    loadProject({ patternSources: [euclid()] });
    render(<PatternsSection />);
    openFirst();
    const steps = screen.getByLabelText('steps');
    fireEvent.change(steps, { target: { value: '' } });
    expect(steps).toHaveAttribute('aria-invalid', 'true');
    expect(source().pattern).toMatchObject({ steps: 16 });
    fireEvent.change(steps, { target: { value: '-' } });
    expect(source().pattern).toMatchObject({ steps: 16 });
    fireEvent.blur(steps);
    expect(source().pattern).toMatchObject({ steps: 16 }); // reverted, not NaN
  });
});

// ---------------------------------------------------------------------------
// Transforms — ordered list, never a set of toggles
// ---------------------------------------------------------------------------

describe('transform editor', () => {
  const withTransforms = () =>
    pattern({
      transforms: [
        { type: 'fast', factor: 2 },
        { type: 'reverse' },
        { type: 'degrade', probability: 0.63 },
      ],
    });

  it('shows the serialized order with explicit positions', () => {
    loadProject({ patternSources: [withTransforms()] });
    const { container } = render(<PatternsSection />);
    openFirst();
    const rows = [...container.querySelectorAll('.pat-transform')];
    expect(rows.map((r) => r.querySelector('.pat-transform-index')?.textContent)).toEqual([
      '01',
      '02',
      '03',
    ]);
    expect(rows.map((r) => r.querySelector('.pat-transform-name')?.textContent)).toEqual([
      'Fast',
      'Reverse',
      'Probability',
    ]);
  });

  it('reordering rewrites the array in place and changes the result', () => {
    loadProject({
      patternSources: [pattern({ transforms: [{ type: 'fast', factor: 2 }, { type: 'reverse' }] })],
      modulations: [mapping()],
    });
    render(<PatternsSection />);
    openFirst();
    const before = source().transforms;
    fireEvent.click(screen.getByRole('button', { name: /Move Reverse earlier/i }));
    expect(source().transforms).toEqual([{ type: 'reverse' }, { type: 'fast', factor: 2 }]);
    expect(source().transforms).not.toEqual(before);
    // Order is never silently normalized back.
    fireEvent.click(screen.getByRole('button', { name: /Move Reverse later/i }));
    expect(source().transforms).toEqual([{ type: 'fast', factor: 2 }, { type: 'reverse' }]);
    act(() => store().undo());
    expect(source().transforms).toEqual([{ type: 'reverse' }, { type: 'fast', factor: 2 }]);
  });

  it('the first cannot move earlier and the last cannot move later', () => {
    loadProject({ patternSources: [withTransforms()] });
    render(<PatternsSection />);
    openFirst();
    expect(screen.getByRole('button', { name: /Move Fast earlier/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Move Probability later/i })).toBeDisabled();
  });

  it('adds, edits and removes transforms', () => {
    loadProject({ patternSources: [pattern()] });
    render(<PatternsSection />);
    openFirst();
    fireEvent.change(screen.getByLabelText('Add transform'), { target: { value: 'rotate' } });
    expect(source().transforms).toEqual([{ type: 'rotate', steps: 1 }]);
    const steps = screen.getByLabelText('steps');
    fireEvent.change(steps, { target: { value: '3' } });
    fireEvent.blur(steps);
    expect(source().transforms).toEqual([{ type: 'rotate', steps: 3 }]);
    fireEvent.click(screen.getByRole('button', { name: /Remove Rotate/i }));
    expect(source().transforms).toEqual([]);
  });

  it('EVERY exposes its nested transform and refuses to nest another EVERY', () => {
    loadProject({
      patternSources: [
        pattern({ transforms: [{ type: 'every', cycles: 4, transform: { type: 'reverse' } }] }),
      ],
    });
    render(<PatternsSection />);
    openFirst();
    const nested = screen.getByLabelText(/Transform applied every N cycles/i) as HTMLSelectElement;
    expect([...nested.options].map((o) => o.value)).toEqual(['reverse', 'rotate', 'fast', 'slow']);
    fireEvent.change(nested, { target: { value: 'rotate' } });
    expect(source().transforms).toEqual([
      { type: 'every', cycles: 4, transform: { type: 'rotate', steps: 1 } },
    ]);
  });

  it('probability shows percent and stores 0..1 without drift', () => {
    loadProject({ patternSources: [pattern({ transforms: [{ type: 'degrade', probability: 0.63 }] })] });
    render(<PatternsSection />);
    openFirst();
    const chance = screen.getByLabelText('chance') as HTMLInputElement;
    expect(chance.value).toBe('63');
    fireEvent.change(chance, { target: { value: '25' } });
    fireEvent.blur(chance);
    expect(source().transforms).toEqual([{ type: 'degrade', probability: 0.25 }]);
    // Reopening and re-committing the same percent cannot drift the value.
    fireEvent.change(chance, { target: { value: '25' } });
    fireEvent.blur(chance);
    expect(source().transforms).toEqual([{ type: 'degrade', probability: 0.25 }]);
    // The user-facing name is PROBABILITY; "degrade" stays an engine word.
    expect(screen.getAllByText('Probability').length).toBeGreaterThan(0);
    expect(screen.queryByText(/degrade/i)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Type switching, cycle, duplicate, delete
// ---------------------------------------------------------------------------

describe('pattern lifecycle', () => {
  it('switching type keeps id, transforms, cycle and mappings; undo restores', () => {
    loadProject({
      patternSources: [pattern({ beatsPerCycle: 8, transforms: [{ type: 'reverse' }] })],
      modulations: [mapping()],
    });
    render(<PatternsSection />);
    openFirst();
    fireEvent.change(screen.getByLabelText(/PAT 01 type/i), { target: { value: 'euclidean' } });
    const s = source();
    expect(s.pattern).toMatchObject({ type: 'euclidean', pulses: 3, steps: 8 });
    expect(s.id).toBe('pat-a');
    expect(s.beatsPerCycle).toBe(8);
    expect(s.transforms).toEqual([{ type: 'reverse' }]);
    expect(store().project.modulations).toEqual([mapping()]);
    act(() => store().undo());
    expect(source().pattern).toEqual({ type: 'sequence', values: [0, 1] });
  });

  it('cycle length is editable, including fractional values', () => {
    loadProject({ patternSources: [pattern()] });
    render(<PatternsSection />);
    openFirst();
    const cycle = screen.getByLabelText('cycle');
    fireEvent.change(cycle, { target: { value: '0.5' } });
    fireEvent.blur(cycle);
    expect(source().beatsPerCycle).toBe(0.5);
    fireEvent.change(cycle, { target: { value: '0' } });
    fireEvent.blur(cycle);
    expect(source().beatsPerCycle).toBe(0.5); // rejected, not clamped silently
  });

  it('duplicate creates an independent pattern with no mappings', () => {
    loadProject({
      patternSources: [pattern({ transforms: [{ type: 'degrade', probability: 0.5 }] })],
      modulations: [mapping()],
    });
    render(<PatternsSection />);
    openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'DUPLICATE' }));
    const sources = store().project.patternSources;
    expect(sources).toHaveLength(2);
    expect(sources[1]!.id).not.toBe(sources[0]!.id);
    expect(sources[1]!.pattern).toEqual(sources[0]!.pattern);
    expect(sources[1]!.transforms).toEqual(sources[0]!.transforms);
    expect(store().project.modulations).toHaveLength(1); // no cloned mappings
    expect(screen.getByText('PAT 02')).toBeInTheDocument();
  });

  it('delete asks first, names the cost, and removes mappings atomically', () => {
    loadProject({
      patternSources: [pattern()],
      modulations: [
        mapping({ id: 'm1', target: 'scale' }),
        mapping({ id: 'm2', target: 'spacing' }),
        mapping({ id: 'm-other', source: 'bass', target: 'rotation' }),
      ],
    });
    render(<PatternsSection />);
    openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'DELETE' }));
    expect(screen.getByText(/2 mappings will also be removed/i)).toBeInTheDocument();
    // Cancel changes nothing.
    fireEvent.click(screen.getByRole('button', { name: 'CANCEL' }));
    expect(store().project.patternSources).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'DELETE' }));
    fireEvent.click(screen.getByRole('button', { name: 'REMOVE' }));
    expect(store().project.patternSources).toHaveLength(0);
    expect(store().project.modulations.map((m) => m.id)).toEqual(['m-other']);

    act(() => store().undo());
    expect(store().project.patternSources[0]!.id).toBe('pat-a');
    expect(store().project.modulations.map((m) => m.id)).toEqual(['m1', 'm2', 'm-other']);
  });
});

// ---------------------------------------------------------------------------
// Integration with the rest of BUILD
// ---------------------------------------------------------------------------

describe('build integration', () => {
  it('the System Path shows one PATTERN segment, never instance labels', () => {
    loadProject({
      patternSources: [pattern({ id: 'pat-a' }), pattern({ id: 'pat-b' })],
      modulations: [
        mapping({ id: 'm1', source: patternSourceKey('pat-a') }),
        mapping({ id: 'm2', source: patternSourceKey('pat-b'), target: 'spacing' }),
        mapping({ id: 'm3', source: 'bass', target: 'rotation' }),
      ],
    });
    const { container } = render(<SystemPath />);
    expect(container.textContent).toContain('PATTERN');
    expect(container.textContent).not.toContain('PAT 01');
    expect(container.textContent).not.toContain('pattern:');
    expect(container.textContent).toContain('BASS');
  });

  it('no enabled pattern mapping means no PATTERN segment', () => {
    loadProject({
      patternSources: [pattern()],
      modulations: [mapping({ enabled: false })],
    });
    const { container } = render(<SystemPath />);
    expect(container.textContent).not.toContain('PATTERN');
  });

  it('project reload rebuilds the editor from canonical persisted state', () => {
    loadProject({
      patternSources: [
        pattern({
          pattern: { type: 'sequence', values: [0, 0.25, 1, 0.25] },
          transforms: [{ type: 'fast', factor: 2 }, { type: 'reverse' }],
        }),
      ],
      modulations: [mapping()],
    });
    const saved = JSON.parse(JSON.stringify(projectSchema.parse(store().project)));
    const reloaded = parseProject(saved);
    useProjectStore.setState({ project: reloaded, past: [], future: [], dirty: false });
    render(<PatternsSection />);
    openFirst();
    expect((screen.getByLabelText('Pattern steps') as HTMLInputElement).value).toBe(
      '0 0.25 1 0.25',
    );
    const names = [...document.querySelectorAll('.pat-transform-name')].map((n) => n.textContent);
    expect(names).toEqual(['Fast', 'Reverse']);
  });

  it('switching to a project without patterns clears the list and selection', () => {
    loadProject({ patternSources: [pattern()], modulations: [mapping()] });
    const view = render(<PatternsSection />);
    openFirst();
    expect(screen.getByLabelText('Pattern steps')).toBeInTheDocument();
    act(() => {
      useProjectStore.setState({
        project: { ...createEmptyProject('B'), timeline: { ...createEmptyProject('B').timeline } },
        past: [],
        future: [],
      });
    });
    view.rerender(<PatternsSection />);
    expect(screen.queryByLabelText('Pattern steps')).not.toBeInTheDocument();
    expect(screen.getByText(/Temporal sequences/i)).toBeInTheDocument();
  });

  it('playing does not dirty the project or grow history', async () => {
    loadProject({ patternSources: [pattern()], modulations: [mapping()] });
    render(<PatternsSection />);
    openFirst();
    for (let f = 0; f < 240; f++) live(f / 120);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120)); // let the 20Hz readout tick
    });
    expect(store().dirty).toBe(false);
    expect(store().past).toHaveLength(0);
  });
});

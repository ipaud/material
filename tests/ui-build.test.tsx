import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SystemPath } from '@/build/SystemPath';
import { ParameterSlider } from '@/components/ParameterSlider';
import { groupParams } from '@/inspector/paramGroups';
import { TIMELINE_MIN_HEIGHT, useUiStore } from '@/state/uiStore';
import { useProjectStore } from '@/state/projectStore';
import { getTechnique, listTechniques } from '@/techniques/registry';
import { allParams, defaultParams } from '@/techniques/types';
import { createEmptyProject } from '@shared/schemas/project';
import { uid } from '@/utils/id';

vi.mock('@/components/Gutter', () => ({ Gutter: () => <div /> }));
vi.mock('@/components/EmptyState', () => ({ EmptyState: () => null }));
vi.mock('@/library/LibraryPanel', () => ({ LibraryPanel: () => <div>Library content</div> }));
vi.mock('@/viewport/Viewport', () => ({ Viewport: () => <div /> }));
vi.mock('@/inspector/InspectorPanel', () => ({ InspectorPanel: () => <div>Inspector content</div> }));
vi.mock('@/timeline/TimelinePanel', () => ({ TimelinePanel: () => <div /> }));
vi.mock('@/techniques/TechniquesBrowser', () => ({ TechniquesBrowser: () => null }));
import { BuildWorkspace } from '@/workspaces/BuildWorkspace';

function loadProject(
  mutate: (p: ReturnType<typeof createEmptyProject>) => ReturnType<typeof createEmptyProject>,
) {
  const base = createEmptyProject('Test');
  useProjectStore.setState({ project: mutate(base) });
}

function withSource(kind: 'video' | 'image' = 'video') {
  return (p: ReturnType<typeof createEmptyProject>) => ({
    ...p,
    sources: [
      {
        id: 'src1',
        kind,
        path: `/tmp/clip.${kind === 'video' ? 'mp4' : 'png'}`,
        metadata: null,
      },
    ],
    composition: { ...p.composition, sourceId: 'src1' },
  });
}

function withTechnique(techniqueId: string) {
  const definition = getTechnique(techniqueId);
  if (!definition) throw new Error(`missing technique ${techniqueId}`);
  return (p: ReturnType<typeof createEmptyProject>) => ({
    ...p,
    layers: p.layers.map((l, i) =>
      i === 0
        ? { ...l, technique: { id: uid('tech'), techniqueId, enabled: true, params: defaultParams(definition) } }
        : l,
    ),
  });
}

beforeEach(() => {
  loadProject((p) => p);
  // jsdom has no pointer capture; the slider only uses it to keep the drag.
  if (!HTMLElement.prototype.setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = () => {};
    HTMLElement.prototype.releasePointerCapture = () => {};
  }
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ techniquesOpen: false, timelineHeight: 96 });
});

describe('SystemPath', () => {
  it('reads every segment off real project state', () => {
    loadProject((p) => withTechnique('mosaic')(withSource('video')(p)));
    useProjectStore.setState((s) => ({
      project: {
        ...s.project,
        modulations: [
          {
            id: 'm1',
            source: 'bass',
            target: 'scale',
            amount: 0.5,
            smoothing: 0.25,
            min: 0,
            max: 1,
            curve: 'linear' as const,
            invert: false,
            enabled: true,
            frozenValue: null,
          },
        ],
      },
    }));
    render(<SystemPath />);
    expect(screen.getByText('VIDEO')).toBeInTheDocument();
    expect(screen.getByText('MOSAIC')).toBeInTheDocument();
    expect(screen.getByText('SQUARE')).toBeInTheDocument();
    expect(screen.getByText('BASS')).toBeInTheDocument();
    expect(screen.getByText('OUTPUT')).toBeInTheDocument();
  });

  it('falls back to SOURCE and NO SIGNAL rather than inventing labels', () => {
    loadProject((p) => withTechnique('mosaic')(p));
    render(<SystemPath />);
    expect(screen.getByText('SOURCE')).toBeInTheDocument();
    expect(screen.getByText('NO SIGNAL')).toBeInTheDocument();
  });

  it('ignores disabled mappings when deciding whether a signal is live', () => {
    loadProject((p) => ({
      ...withTechnique('mosaic')(withSource()(p)),
      modulations: [
        {
          id: 'm1',
          source: 'bass',
          target: 'scale',
          amount: 0.5,
          smoothing: 0.25,
          min: 0,
          max: 1,
          curve: 'linear' as const,
          invert: false,
          enabled: false,
          frozenValue: null,
        },
      ],
    }));
    render(<SystemPath />);
    expect(screen.getByText('NO SIGNAL')).toBeInTheDocument();
  });

  it('marks a temporal technique as temporal from its own params', () => {
    loadProject((p) => {
      const withTech = withTechnique('mosaic')(withSource()(p));
      return {
        ...withTech,
        layers: withTech.layers.map((l) =>
          l.technique
            ? { ...l, technique: { ...l.technique, params: { ...l.technique.params, tileMode: 'tile' } } }
            : l,
        ),
      };
    });
    render(<SystemPath />);
    expect(screen.getByText('TEMPORAL MOSAIC')).toBeInTheDocument();
  });

  it('caps the signal list and says how many are hidden', () => {
    const mapping = (id: string, source: string) => ({
      id,
      source,
      target: 'scale',
      amount: 0.5,
      smoothing: 0.25,
      min: 0,
      max: 1,
      curve: 'linear' as const,
      invert: false,
      enabled: true,
      frozenValue: null,
    });
    loadProject((p) => ({
      ...withTechnique('mosaic')(withSource()(p)),
      modulations: [
        mapping('m1', 'bass'),
        mapping('m2', 'onset'),
        mapping('m3', 'highs'),
        mapping('m4', 'centroid'),
      ],
    }));
    render(<SystemPath />);
    expect(screen.getByText('BASS / ONSET / HIGHS +1')).toBeInTheDocument();
  });
});

describe('BUILD narrow panel controls', () => {
  it('opens one side panel at a time and closes it on second activation', () => {
    render(<BuildWorkspace isDragOver={false} />);
    expect(screen.getByRole('group', { name: 'Workspace panels' })).toBeInTheDocument();
    const library = screen.getByRole('button', { name: 'Library' });
    const inspector = screen.getByRole('button', { name: 'Inspector' });

    expect(library).toHaveAttribute('aria-controls', 'build-library-panel');
    expect(library).toHaveAttribute('aria-expanded', 'false');
    const viewport = document.querySelector('.viewport-area');
    expect(viewport).not.toHaveAttribute('inert');
    fireEvent.click(library);
    expect(library).toHaveAttribute('aria-expanded', 'true');
    expect(inspector).toHaveAttribute('aria-expanded', 'false');
    expect(viewport).toHaveAttribute('inert');
    fireEvent.click(inspector);
    expect(library).toHaveAttribute('aria-expanded', 'false');
    expect(inspector).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(inspector);
    expect(inspector).toHaveAttribute('aria-expanded', 'false');
    expect(viewport).not.toHaveAttribute('inert');
  });
});

describe('Inspector parameter grouping', () => {
  it('keeps every technique parameter exactly once', () => {
    for (const definition of listTechniques()) {
      const grouped = groupParams(definition).flatMap((g) => g.params.map((p) => p.id));
      const declared = allParams(definition).map((p) => p.id);
      expect(grouped.slice().sort()).toEqual(declared.slice().sort());
      expect(new Set(grouped).size).toBe(grouped.length);
    }
  });

  it('groups mosaic under the conceptual headings', () => {
    const definition = getTechnique('mosaic');
    if (!definition) throw new Error('mosaic missing');
    const groups = Object.fromEntries(
      groupParams(definition).map((g) => [g.label, g.params.map((p) => p.id)]),
    );
    expect(groups.STRUCTURE).toContain('columns');
    expect(groups.STRUCTURE).toContain('depth');
    expect(groups.SAMPLING).toContain('threshold');
    expect(groups.SAMPLING).toContain('lumToScale');
    expect(groups.TIME).toContain('tileMode');
    expect(groups.BEHAVIOR).toContain('jitterX');
    expect(groups.BEHAVIOR).not.toContain('columns');
  });

  it('gives an unknown parameter its own technique section rather than dropping it', () => {
    const fake = {
      id: 'fake',
      name: 'Fake',
      category: 'space' as const,
      chainBehavior: 'stateless' as const,
      description: '',
      sections: [
        {
          label: 'Exotic',
          params: [
            {
              type: 'number' as const,
              id: 'wormhole',
              label: 'Wormhole',
              min: 0,
              max: 1,
              step: 0.1,
              default: 0,
            },
          ],
        },
      ],
      createRenderer: () => {
        throw new Error('not used');
      },
    };
    const groups = groupParams(fake);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe('EXOTIC');
    expect(groups[0]?.params[0]?.id).toBe('wormhole');
  });
});

describe('BUILD panel sizing', () => {
  it('clamps every panel to its usable range', () => {
    const ui = useUiStore.getState();
    ui.setPanelSize('library', 10);
    expect(useUiStore.getState().libraryWidth).toBe(160);
    ui.setPanelSize('library', 9999);
    expect(useUiStore.getState().libraryWidth).toBe(400);
    ui.setPanelSize('inspector', 0);
    expect(useUiStore.getState().inspectorWidth).toBe(220);
    ui.setPanelSize('inspector', 9999);
    expect(useUiStore.getState().inspectorWidth).toBe(460);
  });

  it('lets the timeline shrink to a compact band instead of a tall empty strip', () => {
    useUiStore.getState().setPanelSize('timeline', 0);
    expect(useUiStore.getState().timelineHeight).toBe(TIMELINE_MIN_HEIGHT);
    expect(TIMELINE_MIN_HEIGHT).toBeLessThan(96);
    useUiStore.getState().setPanelSize('timeline', 9999);
    expect(useUiStore.getState().timelineHeight).toBe(320);
  });
});

describe('Techniques browser', () => {
  it('opens and closes from BUILD without changing workspace', () => {
    useUiStore.setState({ workspace: 'build' });
    useUiStore.getState().toggleTechniques();
    expect(useUiStore.getState().techniquesOpen).toBe(true);
    expect(useUiStore.getState().workspace).toBe('build');
    useUiStore.getState().toggleTechniques();
    expect(useUiStore.getState().techniquesOpen).toBe(false);
    expect(useUiStore.getState().workspace).toBe('build');
  });
});

describe('ParameterSlider interaction', () => {
  it('keeps drag, fine drag, typed entry and double-click reset', () => {
    const seen: number[] = [];
    const { container } = render(
      <ParameterSlider
        label="Scale"
        value={0.5}
        min={0}
        max={1}
        step={0.01}
        defaultValue={0.25}
        onChange={(v) => seen.push(v)}
      />,
    );
    const track = container.querySelector('.param-track') as HTMLElement;
    Object.defineProperty(track, 'clientWidth', { value: 100, configurable: true });

    // drag
    fireEvent.pointerDown(track, { clientX: 0, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 20, pointerId: 1 });
    fireEvent.pointerUp(track, { pointerId: 1 });
    expect(seen.at(-1)).toBeCloseTo(0.7, 5);

    // shift = fine
    fireEvent.pointerDown(track, { clientX: 0, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 20, pointerId: 1, shiftKey: true });
    fireEvent.pointerUp(track, { pointerId: 1 });
    expect(seen.at(-1)).toBeCloseTo(0.52, 5);

    // double-click resets to the default
    fireEvent.doubleClick(track);
    expect(seen.at(-1)).toBe(0.25);

    // click the value, type an exact number
    fireEvent.click(screen.getByText('0.50'));
    const input = container.querySelector('.param-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0.9' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(seen.at(-1)).toBe(0.9);
  });

  it('still shows modulated state as more than a colour', () => {
    const { container } = render(
      <ParameterSlider
        label="Scale"
        value={0.5}
        min={0}
        max={1}
        step={0.01}
        defaultValue={0.25}
        modulated
        modulatedValue={0.8}
        onChange={() => {}}
      />,
    );
    expect(container.querySelector('.param-row')).toHaveClass('modulated');
    expect(container.querySelector('.param-mod-dot')).toBeInTheDocument();
    expect(container.querySelector('.param-mod-marker')).toBeInTheDocument();
  });
});

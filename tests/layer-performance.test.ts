import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createEmptyProject,
  emptyLayer,
  type PinnedLook,
  type Project,
} from '@shared/schemas/project';
import {
  captureLayerLooks,
  isCompositionLook,
  projectWithLayerLooks,
} from '@/performance/layerLook';

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');

function stack(): Project {
  const p = createEmptyProject('perf');
  return {
    ...p,
    layers: [
      { ...p.layers[0]!, id: 'a', name: 'A', opacity: 1, blendMode: 'normal' },
      { ...emptyLayer('b', 'B'), opacity: 0.4, blendMode: 'screen', sourceId: 'src-b' },
      { ...emptyLayer('c', 'C'), enabled: false },
    ],
    selectedLayerId: 'b',
  };
}

const lookFrom = (p: Project, over: Partial<PinnedLook> = {}): PinnedLook =>
  ({
    id: 'L',
    createdAt: '2026-01-01T00:00:00.000Z',
    label: 'L',
    note: '',
    slot: 1,
    seed: 1,
    thumbnail: null,
    techniques: [],
    material: p.material,
    modulations: [],
    triggers: [],
    layers: captureLayerLooks(p),
    ...over,
  }) as PinnedLook;

describe('v0.6D — a Look is the whole composition', () => {
  it('captures every layer, in order', () => {
    const captured = captureLayerLooks(stack());
    expect(captured.map((l) => l.id)).toEqual(['a', 'b', 'c']);
    expect(captured[1]!.opacity).toBe(0.4);
    expect(captured[1]!.blendMode).toBe('screen');
    expect(captured[2]!.enabled).toBe(false);
  });

  it('captures and restores input routing and activity windows', () => {
    const p = stack();
    const source = {
      ...p.layers[0]!,
      input: 'below' as const,
      activity: { start: 2, end: 8, fadeIn: 1, fadeOut: 1 },
    };
    const saved = lookFrom({ ...p, layers: [source, ...p.layers.slice(1)] });
    const changed: Project = {
      ...p,
      layers: [{ ...source, input: 'source', activity: null }, ...p.layers.slice(1)],
    };

    const restored = projectWithLayerLooks(changed, saved).layers[0]!;
    expect(restored.input).toBe('below');
    expect(restored.activity).toEqual({ start: 2, end: 8, fadeIn: 1, fadeOut: 1 });
  });

  it('legacy layer snapshots preserve input routing and activity when fields are absent', () => {
    const p = stack();
    const current = {
      ...p.layers[0]!,
      input: 'below' as const,
      activity: { start: 3, end: null, fadeIn: 0, fadeOut: 0 },
    };
    const legacy = lookFrom(p, {
      layers: captureLayerLooks(p).map(({ input: _input, activity: _activity, ...layer }) => layer),
    });

    const restored = projectWithLayerLooks({ ...p, layers: [current, ...p.layers.slice(1)] }, legacy).layers[0]!;
    expect(restored.input).toBe('below');
    expect(restored.activity).toEqual(current.activity);
  });

  it('recall is idempotent — a layer the Look does not mention is removed', () => {
    const p = stack();
    const look = lookFrom(p);
    const withExtra: Project = { ...p, layers: [...p.layers, emptyLayer('d', 'D')] };
    const restored = projectWithLayerLooks(withExtra, look);
    expect(restored.layers.map((l) => l.id)).toEqual(['a', 'b', 'c']);
    // And restoring twice is the same as restoring once.
    expect(projectWithLayerLooks(restored, look).layers.map((l) => l.id)).toEqual(['a', 'b', 'c']);
  });

  it('a surviving layer keeps its identity, so its runtime is not rebuilt', () => {
    // The bridge keys runtimes on the layer id. Recalling a Look must not
    // hand every layer a new id, or a feedback surface or a simulation would
    // visibly reset on every recall.
    const p = stack();
    const look = lookFrom(p);
    const restored = projectWithLayerLooks(p, look);
    expect(restored.layers.map((l) => l.id)).toEqual(p.layers.map((l) => l.id));
  });

  it('recall restores pinned chain stage ids, which stage modulations target', () => {
    const p = stack();
    const pinned = { ...p.layers[0]!, techniqueChain: [{ id: 'stage-pinned', techniqueId: 'mosaic', enabled: true, params: {} }] };
    const look = lookFrom({ ...p, layers: [pinned, ...p.layers.slice(1)] });
    // The performer deleted that stage and added another after pinning.
    const edited = { ...pinned, techniqueChain: [{ id: 'stage-live', techniqueId: 'echo', enabled: true, params: {} }] };
    const restored = projectWithLayerLooks({ ...p, layers: [edited, ...p.layers.slice(1)] }, look);
    expect(restored.layers[0]!.techniqueChain.map((s) => s.id)).toEqual(['stage-pinned']);
  });

  it('recall does not re-solo something the performer released', () => {
    // Solo is live performance state, not part of a look.
    const p = stack();
    const look = lookFrom({ ...p, layers: p.layers.map((l) => ({ ...l, solo: l.id === 'a' })) });
    const restored = projectWithLayerLooks(p, look);
    expect(restored.layers.every((l) => !l.solo)).toBe(true);
  });

  it('selection survives recall when the layer is still there', () => {
    const p = stack();
    expect(projectWithLayerLooks(p, lookFrom(p)).selectedLayerId).toBe('b');
  });

  it("the Look's own selection wins, so the core lands on the right layer", () => {
    // The Look's techniques/material describe ONE layer. Without a recorded
    // selection the core landed wherever the fallback pointed — measured:
    // recalling a three-layer Look put layer 2's technique onto layer 1
    // whenever the previously selected layer no longer existed.
    const p = stack();
    const look = lookFrom(p, { selectedLayerId: 'c' });
    const elsewhere: Project = { ...p, selectedLayerId: 'a' };
    expect(projectWithLayerLooks(elsewhere, look).selectedLayerId).toBe('c');
  });

  it('a recorded selection that no longer exists falls back rather than throwing', () => {
    const p = stack();
    const look = lookFrom(p, { selectedLayerId: 'ghost' });
    expect(projectWithLayerLooks(p, look).selectedLayerId).toBe('b');
  });

  it('selection falls back when the selected layer is gone', () => {
    const p = stack();
    const look = lookFrom({ ...p, layers: [p.layers[0]!] }, { selectedLayerId: null });
    expect(projectWithLayerLooks({ ...p, selectedLayerId: 'c' }, look).selectedLayerId).toBe('a');
  });

  it('a Look pinned before layers leaves the stack completely alone', () => {
    // Absence of `layers` is the honest record of "this predates v0.6".
    // Inventing a one-layer stack for it would silently wipe layers the
    // performer added afterwards.
    const p = stack();
    const legacy = lookFrom(p, { layers: undefined });
    expect(isCompositionLook(legacy)).toBe(false);
    expect(projectWithLayerLooks(p, legacy)).toBe(p);
  });

  it('an empty recorded stack is treated as absent, not as "delete everything"', () => {
    const p = stack();
    expect(projectWithLayerLooks(p, lookFrom(p, { layers: [] }))).toBe(p);
  });

  it('pin and apply both go through the stack path', () => {
    const actions = read('src', 'projects', 'lookActions.ts');
    expect(actions).toContain('layers: captureLayerLooks(');
    expect(actions).toContain('selectedLayerId: selectedLayerOf(');
    const apply = actions.slice(actions.indexOf('export function applyLook('));
    expect(apply.slice(0, 700)).toContain('projectWithLayerLooks(p, look)');
    // The stack lands FIRST, so the core is applied to the layer the Look says
    // is selected rather than to whatever was selected a moment ago.
    expect(apply.indexOf('projectWithLayerLooks')).toBeLessThan(
      apply.indexOf('projectWithLookCore'),
    );
  });
});

describe('v0.6D — morph and freeze with a stack', () => {
  it('only the primary layer interpolates; the rest arrive at the end', () => {
    // There is no meaningful interpolation between "three layers" and "two":
    // the stack is structure, not a value.
    const src = read('src', 'performance', 'morphRuntime.ts');
    const complete = src.slice(src.indexOf('private complete(atTime: number)'));
    expect(complete.slice(0, 1200)).toContain('projectWithLayerLooks(p, target)');
    // One atomic commit, so the performer never sees a stack settling in pieces.
    const applyCount = (complete.slice(0, 1400).match(/\.apply\(/g) ?? []).length;
    expect(applyCount).toBe(1);
  });

  it('freeze still works per mapping regardless of which layer it drives', () => {
    // Mapping ids are unique project-wide and one SmoothingState serves every
    // layer, so freeze needed no layer dimension — assert that it did not grow
    // one by accident.
    const runtime = read('src', 'modulation', 'runtime.ts');
    const fn = runtime.slice(runtime.indexOf('currentShapedValue(mappingId: string)'));
    expect(fn.slice(0, 200)).toContain('this.smoothing.peek(mappingId)');
    expect(fn.slice(0, 200).includes('layerId')).toBe(false);
  });
});

describe('v0.6D — the layer strip', () => {
  it('renders the stack bottom-first, matching the compositor', () => {
    const src = read('src', 'performance', 'ui', 'LayerStrip.tsx');
    expect(src).toContain('layers.map((layer, i)');
    expect(src.includes('.reverse()'), 'the strip must not reverse the stack').toBe(false);
  });

  it('shows the resolved opacity next to the stored one', () => {
    // Showing only the stored value makes a modulated layer look broken;
    // showing only the live one makes the fader impossible to aim.
    const src = read('src', 'performance', 'ui', 'LayerStrip.tsx');
    expect(src).toContain('engine.resolvedOpacity(layer.id)');
    expect(src).toContain('layer.opacity.toFixed(2)');
    expect(src).toContain('live.toFixed(2)');
  });

  it('every control is reachable and labelled', () => {
    const src = read('src', 'performance', 'ui', 'LayerStrip.tsx');
    expect(src).toContain('role="slider"');
    expect(src).toContain('aria-valuenow');
    expect(src).toContain('tabIndex={0}');
    expect(src).toContain('onKeyDown');
    expect(src).toContain('aria-label');
  });

  it('is mounted in the performance workspace', () => {
    const ws = read('src', 'workspaces', 'PerformWorkspace.tsx');
    expect(ws).toContain('<LayerStrip />');
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_NEW_LAYERS, type Project } from '@shared/schemas/project';
import { useProjectStore } from '@/state/projectStore';
import {
  addLayer,
  clearLayerSolo,
  deleteLayer,
  duplicateLayer,
  moveLayer,
  selectedLayer,
  setLayerActivity,
  setLayerBlend,
  toggleLayerEnabled,
  toggleLayerSolo,
} from '@/projects/layerActions';

/** Layer edits as a performer meets them: the stack, the selection, solo and copies. */

const project = () => useProjectStore.getState().project;
const ids = () => project().layers.map((l) => l.id);

beforeEach(() => {
  useProjectStore.getState().newProject();
});

describe('the stack', () => {
  it('the last layer cannot be deleted', () => {
    const only = ids()[0]!;
    deleteLayer(only);
    expect(ids()).toEqual([only]);
  });

  it('deleting the selected layer selects the top one, and drops mappings that targeted it', () => {
    const base = ids()[0]!;
    const a = addLayer()!;
    const b = addLayer()!;
    useProjectStore.getState().apply((p) => ({
      ...p,
      selectedLayerId: a,
      modulations: [
        { id: 'to-a', targetLayerId: a },
        { id: 'to-b', targetLayerId: b },
      ] as unknown as Project['modulations'],
    }));
    deleteLayer(a);
    expect(ids()).toEqual([base, b]);
    expect(project().selectedLayerId).toBe(b);
    expect(project().modulations.map((m) => m.id)).toEqual(['to-b']);

    // deleting another layer keeps the selection where it was
    deleteLayer(base);
    expect(project().selectedLayerId).toBe(b);
  });

  it('moves within bounds only', () => {
    const base = ids()[0]!;
    const a = addLayer()!;
    moveLayer(a, -1);
    expect(ids()).toEqual([a, base]);
    moveLayer(a, -1);
    moveLayer(base, 5);
    moveLayer('missing', 1);
    expect(ids()).toEqual([a, base]);
  });

  it('stops adding at the limit', () => {
    while (project().layers.length < MAX_NEW_LAYERS) addLayer();
    expect(addLayer()).toBeNull();
    expect(duplicateLayer(ids()[0]!)).toBeNull();
    expect(project().layers).toHaveLength(MAX_NEW_LAYERS);
  });

  it('when the selected id is stale, the first layer is the one edited', () => {
    useProjectStore.getState().apply((p) => ({ ...p, selectedLayerId: 'gone' }));
    expect(selectedLayer().id).toBe(ids()[0]);
  });
});

describe('solo and mute', () => {
  it('solo is exclusive and releasing it restores exactly what was muted', () => {
    const base = ids()[0]!;
    const a = addLayer()!;
    const b = addLayer()!;
    toggleLayerEnabled(b); // muted before solo
    toggleLayerSolo(a);
    toggleLayerSolo(base);
    expect(project().layers.map((l) => l.solo)).toEqual([true, false, false]);

    toggleLayerSolo(base);
    expect(project().layers.every((l) => !l.solo)).toBe(true);
    expect(project().layers.map((l) => l.enabled)).toEqual([true, true, false]);
  });

  it('clearing solo with none held changes nothing (no undo step)', () => {
    const before = project();
    clearLayerSolo();
    expect(project()).toBe(before);
    toggleLayerSolo(ids()[0]!);
    clearLayerSolo();
    expect(project().layers[0]!.solo).toBe(false);
  });

  it('unknown layers are ignored', () => {
    const before = project();
    toggleLayerSolo('nope');
    toggleLayerEnabled('nope');
    setLayerActivity('nope', { start: 2 });
    expect(project()).toBe(before);
  });
});

describe('copies', () => {
  it('a duplicate sits right above the original, selected, with fresh ids for everything it owns', () => {
    const base = ids()[0]!;
    const top = addLayer()!;
    useProjectStore.getState().apply((p) => ({
      ...p,
      layers: p.layers.map((l) =>
        l.id === base
          ? {
              ...l,
              name: 'Letters',
              technique: { id: 't1', techniqueId: 'mosaic', enabled: true, params: { columns: 12 } },
              techniqueChain: [{ id: 't2', techniqueId: 'echo', enabled: true, params: {} }],
            }
          : l,
      ),
    }));
    setLayerBlend(base, 'screen');

    const copy = duplicateLayer(base)!;

    expect(ids()).toEqual([base, copy, top]);
    expect(project().selectedLayerId).toBe(copy);
    const [orig, dup] = project().layers;
    expect(dup).toMatchObject({ name: 'Letters copy', blendMode: 'screen', technique: { techniqueId: 'mosaic', params: { columns: 12 } } });
    expect(dup!.technique!.id).not.toBe(orig!.technique!.id);
    expect(dup!.techniqueChain[0]!.id).not.toBe('t2');
    expect(dup!.techniqueChain[0]!.techniqueId).toBe('echo');
    expect(duplicateLayer('nope')).toBeNull();
  });

  it('an unnamed layer stays unnamed when copied', () => {
    useProjectStore.getState().apply((p) => ({ ...p, layers: p.layers.map((l) => ({ ...l, name: '' })) }));
    const copy = duplicateLayer(ids()[0]!)!;
    expect(project().layers.find((l) => l.id === copy)!.name).toBe('');
  });
});

describe('activity window', () => {
  it('clamps negative times and keeps the end after the start; null removes it', () => {
    const id = ids()[0]!;
    setLayerActivity(id, { start: -3, end: 0, fadeIn: -1 });
    expect(project().layers[0]!.activity).toEqual({ start: 0, end: 1, fadeIn: 0, fadeOut: 0 });
    setLayerActivity(id, { start: 5 });
    expect(project().layers[0]!.activity).toEqual({ start: 5, end: 6, fadeIn: 0, fadeOut: 0 });
    setLayerActivity(id, null);
    expect(project().layers[0]!.activity).toBeNull();
  });
});

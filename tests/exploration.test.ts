import { describe, expect, test } from 'vitest';
import {
  applyVariationToProject,
  emptyLocks,
  generatePopulation,
  generateVariation,
  mutatePopulation,
  type Variation,
} from '@/explore/exploration';
import { mosaicDefinition } from '@/techniques/mosaic/definition';
import { allParams, defaultParams } from '@/techniques/types';
import { createEmptyProject, type ModulationMapping } from '@shared/schemas/project';
import { useExploreStore } from '@/state/exploreStore';
import { emptyMutationLocks } from '@/performance/mutation';
import { useProjectStore } from '@/state/projectStore';

const mapping: ModulationMapping = {
  id: 'map1',
  enabled: true,
  source: 'bass',
  target: 'depth',
  amount: 0.5,
  min: 0,
  max: 1,
  invert: false,
  smoothing: 0.25,
  curve: 'linear',
  frozenValue: null,
};

describe('exploration', () => {
  test('same seed → identical patch (reproducible)', () => {
    const a = generateVariation(mosaicDefinition, [mapping], 841295, emptyLocks());
    const b = generateVariation(mosaicDefinition, [mapping], 841295, emptyLocks());
    expect(a).toEqual(b);
  });

  test('different seeds → different patches', () => {
    const a = generateVariation(mosaicDefinition, [mapping], 1, emptyLocks());
    const b = generateVariation(mosaicDefinition, [mapping], 2, emptyLocks());
    expect(a).not.toEqual(b);
  });

  test('locked params never randomized', () => {
    const locks = emptyLocks();
    locks.params.add('columns');
    locks.params.add('rows');
    for (let seed = 0; seed < 20; seed++) {
      const patch = generateVariation(mosaicDefinition, [mapping], seed, locks);
      expect(patch.params.columns).toBeUndefined();
      expect(patch.params.rows).toBeUndefined();
    }
  });

  test('locked modulations never mutated', () => {
    const locks = emptyLocks();
    locks.modulations.add('map1');
    for (let seed = 0; seed < 20; seed++) {
      const patch = generateVariation(mosaicDefinition, [mapping], seed, locks);
      expect(patch.modulations.map1).toBeUndefined();
    }
  });

  test('values stay within exploration ranges', () => {
    const defs = new Map(allParams(mosaicDefinition).map((p) => [p.id, p]));
    for (let seed = 0; seed < 50; seed++) {
      const patch = generateVariation(mosaicDefinition, [mapping], seed, emptyLocks());
      for (const [id, value] of Object.entries(patch.params)) {
        const def = defs.get(id);
        if (def?.type === 'number' && typeof value === 'number') {
          const lo = def.explore?.min ?? def.min;
          const hi = def.explore?.max ?? def.max;
          expect(value).toBeGreaterThanOrEqual(lo);
          expect(value).toBeLessThanOrEqual(hi);
        }
      }
      const mod = patch.modulations.map1;
      if (mod?.amount !== undefined) {
        expect(mod.amount).toBeGreaterThanOrEqual(-1);
        expect(mod.amount).toBeLessThanOrEqual(1);
      }
      if (mod?.smoothing !== undefined) {
        expect(mod.smoothing).toBeGreaterThanOrEqual(0);
        expect(mod.smoothing).toBeLessThanOrEqual(1);
      }
    }
  });

  test('population is deterministic per population seed', () => {
    const a = generatePopulation(mosaicDefinition, [mapping], 555, 8, emptyLocks());
    const b = generatePopulation(mosaicDefinition, [mapping], 555, 8, emptyLocks());
    expect(a).toEqual(b);
    expect(a).toHaveLength(8);
    expect(new Set(a.map((v) => v.seed)).size).toBe(8);
  });

  test('mutate keeps parent in slot 0 and stays near parent values', () => {
    const parent = generatePopulation(mosaicDefinition, [mapping], 999, 4, emptyLocks())[0];
    if (!parent) throw new Error('no parent');
    const kids = mutatePopulation(mosaicDefinition, [mapping], parent, 1234, 6, emptyLocks());
    expect(kids[0]).toMatchObject({ seed: parent.seed });
    expect(kids).toHaveLength(6);
    const defs = new Map(allParams(mosaicDefinition).map((p) => [p.id, p]));
    for (const kid of kids.slice(1)) {
      expect(kid.generation).toBe(parent.generation + 1);
      expect(kid.parentSeed).toBe(parent.seed);
      for (const [id, value] of Object.entries(kid.patch.params)) {
        const def = defs.get(id);
        const parentValue = parent.patch.params[id];
        if (def?.type === 'number' && typeof value === 'number' && typeof parentValue === 'number') {
          const lo = def.explore?.min ?? def.min;
          const hi = def.explore?.max ?? def.max;
          const sigma = (hi - lo) * 0.25;
          expect(Math.abs(value - parentValue)).toBeLessThanOrEqual(sigma + 1); // +1 for rounding
        }
      }
    }
  });

  test('mutation is deterministic per mutate seed', () => {
    const parent = generatePopulation(mosaicDefinition, [mapping], 999, 1, emptyLocks())[0];
    if (!parent) throw new Error('no parent');
    const a = mutatePopulation(mosaicDefinition, [mapping], parent, 42, 5, emptyLocks());
    const b = mutatePopulation(mosaicDefinition, [mapping], parent, 42, 5, emptyLocks());
    expect(a).toEqual(b);
  });

  test('mutation modes are deterministic, bounded by mode, and honor family locks', () => {
    const parent: Variation = {
      seed: 900,
      generation: 0,
      parentSeed: null,
      patch: { params: defaultParams(mosaicDefinition), modulations: { map1: { amount: 0.5 } } },
    };
    const low = mutatePopulation(mosaicDefinition, [mapping], parent, 37, 20, emptyLocks(), 'subtle');
    const high = mutatePopulation(mosaicDefinition, [mapping], parent, 37, 20, emptyLocks(), 'wild');
    expect(low).toEqual(mutatePopulation(mosaicDefinition, [mapping], parent, 37, 20, emptyLocks(), 'subtle'));
    const distance = (population: Variation[]) => population.slice(1).reduce((sum, item) =>
      sum + Object.keys(item.patch.params).filter((key) => item.patch.params[key] !== parent.patch.params[key]).length, 0);
    expect(distance(high)).toBeGreaterThan(distance(low));

    const locks = emptyMutationLocks();
    locks.color = true;
    locks.signals = true;
    const locked = mutatePopulation(mosaicDefinition, [mapping], parent, 37, 20, emptyLocks(), 'wild', locks)[1]!;
    expect(locked.patch.params.threshold).toBe(parent.patch.params.threshold);
    expect(locked.patch.modulations.map1).toEqual(parent.patch.modulations.map1);
  });

  test('structure mode mutates structural sections only and locked values stay anchored', () => {
    const parent: Variation = {
      seed: 901,
      generation: 0,
      parentSeed: null,
      patch: { params: defaultParams(mosaicDefinition), modulations: {} },
    };
    const children = mutatePopulation(mosaicDefinition, [], parent, 88, 20, emptyLocks(), 'structure');
    expect(children.slice(1).some((child) => child.patch.params.columns !== parent.patch.params.columns)).toBe(true);
    expect(children.slice(1).every((child) => child.patch.params.threshold === parent.patch.params.threshold)).toBe(true);
    const locks = emptyLocks();
    locks.params.add('columns');
    const locked = mutatePopulation(mosaicDefinition, [], parent, 88, 20, locks, 'variation');
    expect(locked.slice(1).every((child) => child.patch.params.columns === parent.patch.params.columns)).toBe(true);
  });

  test('generation back restores transient population, thumbnails, and selection only', () => {
    const explore = useExploreStore.getState();
    explore.clear();
    const initialProject = createEmptyProject('History boundary');
    useProjectStore.getState().loadProject('', initialProject);
    const first: Variation = { seed: 101, generation: 0, parentSeed: null, patch: { params: {}, modulations: {} } };
    const second: Variation = { seed: 202, generation: 1, parentSeed: 101, patch: { params: {}, modulations: {} } };
    explore.startGeneration(1, [first]);
    useExploreStore.getState().finishGeneration();
    useExploreStore.getState().setThumbnail(101, 'thumb-a');
    useExploreStore.getState().select(101);
    useExploreStore.getState().startGeneration(2, [second]);
    useExploreStore.getState().finishGeneration();
    useExploreStore.getState().goBack();
    expect(useExploreStore.getState()).toMatchObject({
      populationSeed: 1, variations: [first], thumbnails: { 101: 'thumb-a' }, selectedSeed: 101,
    });
    expect(useProjectStore.getState().project).toEqual(initialProject);
    expect(useExploreStore.getState().history).toHaveLength(0);
  });

  test('applyVariationToProject merges patch and records seed', () => {
    let project = createEmptyProject();
    project = {
      ...project,
      // v0.6: Explore mutates the SELECTED layer's technique.
      layers: [
        {
          ...project.layers[0]!,
          technique: {
            id: 't1',
            techniqueId: 'mosaic',
            enabled: true,
            params: defaultParams(mosaicDefinition),
          },
        },
      ],
      modulations: [mapping],
    };
    const variation = {
      seed: 777,
      patch: { params: { columns: 99 }, modulations: { map1: { amount: -0.5 } } },
      generation: 0,
      parentSeed: null,
    };
    const next = applyVariationToProject(project, variation);
    expect(next.layers[0]?.technique?.params.columns).toBe(99);
    expect(next.modulations[0]?.amount).toBe(-0.5);
    expect(next.explore.lastSeed).toBe(777);
    // Source/target untouched.
    expect(next.modulations[0]?.source).toBe('bass');
    expect(next.modulations[0]?.target).toBe('depth');
  });
});

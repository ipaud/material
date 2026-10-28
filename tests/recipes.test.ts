import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectFile, writeProjectFile } from '../electron/filesystem/projects';
import { parseProject } from '@shared/schemas/project';
import { BUILTIN_MATERIALS } from '@/materials/builtins';
import { getGenerator } from '@/sources/generators/definitions';
import { getTechnique } from '@/techniques/registry';
import { allParams } from '@/techniques/types';
import { MOD_SOURCES } from '@/modulation/sources';
import { emptyMutationLocks, mutateLookCore } from '@/performance/mutation';
import { listRecipes, buildRecipeProject, applyRecipe } from '@/projects/recipes';
import { useProjectStore } from '@/state/projectStore';
import { assessTechniqueChain } from '@/techniques/chainCompatibility';

afterEach(() => {
  useProjectStore.getState().newProject();
});

describe('starter recipes', () => {
  it('provides 12–20 complete, validated starting systems', () => {
    const recipes = listRecipes();
    expect(recipes.length).toBeGreaterThanOrEqual(12);
    expect(recipes.length).toBeLessThanOrEqual(20);
    expect(new Set(recipes.map((recipe) => recipe.id)).size).toBe(recipes.length);

    for (const recipe of recipes) {
      const project = parseProject(buildRecipeProject(recipe.id));
      expect(parseProject(JSON.parse(JSON.stringify(project)))).toEqual(project);
      const layer = project.layers.find((entry) => entry.id === project.selectedLayerId)!;
      const source = project.sources[0];
      expect(source?.kind).toBe('generator');
      if (source?.kind === 'generator') expect(getGenerator(source.generator)).not.toBeNull();
      expect(layer.sourceId).toBe(source?.id);
      expect(layer.technique).not.toBeNull();
      expect(BUILTIN_MATERIALS.some((material) => material.id === layer.material.materialId)).toBe(
        true,
      );
      expect(recipe.description.length).toBeGreaterThan(10);
      const definition = getTechnique(recipe.techniqueId)!;
      const params = new Map(allParams(definition).map((param) => [param.id, param] as const));
      for (const [paramId, value] of Object.entries(layer.technique!.params)) {
        const param = params.get(paramId);
        expect(param, `${recipe.name}.${paramId}`).toBeDefined();
        if (param?.type === 'number' && typeof value === 'number') {
          expect(value).toBeGreaterThanOrEqual(param.min);
          expect(value).toBeLessThanOrEqual(param.max);
        }
      }
      expect(
        MOD_SOURCES.some((sourceEntry) => sourceEntry.id === project.modulations[0]?.source),
      ).toBe(true);
      expect(params.has(project.modulations[0]!.target)).toBe(true);
      const macroTarget = params.get(project.macros[0]!.mappings[0]!.targetParam);
      expect(macroTarget?.type).toBe('number');
      if (macroTarget?.type === 'number') expect(macroTarget.modulatable).toBe(true);
      expect(project.performancePads[0]?.trigger?.targetParam).toBeTruthy();
      const core = {
        techniqueId: layer.technique!.techniqueId,
        params: layer.technique!.params,
        material: layer.material,
        modulations: project.modulations,
        triggers: project.triggers,
        seed: 1,
      };
      const first = mutateLookCore(core, definition, 417, 'high', emptyMutationLocks());
      const replay = mutateLookCore(core, definition, 417, 'high', emptyMutationLocks());
      expect(first.metadata.changedParams, recipe.name).toBeGreaterThan(0);
      expect(replay).toEqual(first);
    }
  });

  it('a typography recipe draws its letters, and any extra stages are chain-compatible', () => {
    for (const recipe of listRecipes()) {
      const project = buildRecipeProject(recipe.id)!;
      const layer = project.layers[0]!;
      // Only Mosaic draws the material; anything else silently drops the type
      // (Liquid Letter on 0.9.0–0.9.1 showed no letters at all).
      if (layer.material.materialId === 'typography') {
        expect(layer.technique!.techniqueId, recipe.name).toBe('mosaic');
      }
      if (layer.techniqueChain.length > 0) {
        expect(assessTechniqueChain([layer.technique!, ...layer.techniqueChain]).compatible, recipe.name).toBe(true);
      }
    }
    expect(buildRecipeProject('liquid-letter')!.layers[0]!.techniqueChain.map((s) => s.techniqueId)).toEqual(['flow-displace']);
  });

  it('applying a chained recipe twice gives each layer its own stage ids', () => {
    expect(applyRecipe('liquid-letter')).toBe(true);
    expect(applyRecipe('liquid-letter')).toBe(true);
    const stageIds = useProjectStore.getState().project.layers.flatMap((l) => l.techniqueChain.map((s) => s.id));
    expect(stageIds).toHaveLength(2);
    expect(new Set(stageIds).size).toBe(2);
  });

  it('saves and reopens a recipe through the project file path', async () => {
    const project = buildRecipeProject('noise-grid')!;
    const directory = await mkdtemp(join(tmpdir(), 'material-recipe-'));
    const file = join(directory, 'noise-grid.material');
    try {
      await writeProjectFile(file, project);
      const result = await readProjectFile(file);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Saved recipe did not reopen');
      expect(result.project).toEqual(project);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('adds selected recipe to empty system and keeps operation undoable', () => {
    const recipe = listRecipes()[0]!;
    expect(applyRecipe(recipe.id)).toBe(true);
    const project = useProjectStore.getState().project;
    expect(project.sources).toHaveLength(1);
    expect(
      project.layers.find((layer) => layer.id === project.selectedLayerId)?.technique?.techniqueId,
    ).toBe(recipe.techniqueId);
    expect(useProjectStore.getState().dirty).toBe(true);
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.sources).toHaveLength(0);
  });

  it('preserves existing source-less layer state when adding a recipe', () => {
    const original = useProjectStore.getState().project;
    const originalLayer = {
      ...original.layers[0]!,
      name: 'Keep me',
      technique: { id: 'existing-technique', techniqueId: 'mosaic', enabled: true, params: {} },
    };
    useProjectStore.setState({ project: { ...original, layers: [originalLayer] } });
    const recipe = listRecipes()[0]!;
    expect(applyRecipe(recipe.id)).toBe(true);
    const layers = useProjectStore.getState().project.layers;
    expect(layers).toHaveLength(2);
    expect(layers[0]?.name).toBe('Keep me');
    expect(layers[0]?.technique?.id).toBe('existing-technique');
  });

  it('does not reuse a source-less layer with user settings', () => {
    const original = useProjectStore.getState().project;
    const savedLayer = { ...original.layers[0]!, name: 'Pinned layout', opacity: 0.4 };
    useProjectStore.setState({ project: { ...original, layers: [savedLayer] } });
    expect(applyRecipe(listRecipes()[0]!.id)).toBe(true);
    const layers = useProjectStore.getState().project.layers;
    expect(layers).toHaveLength(2);
    expect(layers[0]).toMatchObject({ name: 'Pinned layout', opacity: 0.4 });
  });

  it('rejects unknown recipe IDs without changing project', () => {
    const before = useProjectStore.getState().project;
    expect(applyRecipe('missing')).toBe(false);
    expect(useProjectStore.getState().project).toBe(before);
  });
});

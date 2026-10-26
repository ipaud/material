import { selectedLayerOf, type ParamRecord, type PinnedLook, type Project } from '@shared/schemas/project';
import { engine } from '@/rendering/RenderEngine';
import { useProjectStore } from '@/state/projectStore';
import { useExploreStore } from '@/state/exploreStore';
import { candidateRuntime, useCandidateStore } from '@/performance/candidateRuntime';
import { reportError, useUiStore } from '@/state/uiStore';
import { getTechnique } from '@/techniques/registry';
import { freshSeed } from '@/utils/prng';
import { addPin } from '@/projects/lookActions';
import {
  applyVariationToProject,
  emptyLocks,
  mutatePopulation,
  type ExploreLocks,
  type Variation,
} from './exploration';

const THUMB_WIDTH = 220;

let thumbGeneration = 0;

function currentLocks(): ExploreLocks {
  const { project } = useProjectStore.getState();
  const locks = emptyLocks();
  for (const id of project.explore.lockedParams) {
    if (id === 'material') locks.material = true;
    else if (id.startsWith('mod:')) locks.modulations.add(id.slice(4));
    else locks.params.add(id);
  }
  return locks;
}

export function toggleLock(lockId: string): void {
  useProjectStore.getState().apply((p) => {
    const locked = p.explore.lockedParams.includes(lockId);
    return {
      ...p,
      explore: {
        ...p.explore,
        lockedParams: locked
          ? p.explore.lockedParams.filter((l) => l !== lockId)
          : [...p.explore.lockedParams, lockId],
      },
    };
  });
}

function activeTechnique() {
  const { project } = useProjectStore.getState();
  const instance = selectedLayerOf(project).technique;
  if (!instance) return null;
  const definition = getTechnique(instance.techniqueId);
  return definition ? { instance, definition } : null;
}

export function generateExploration(populationSeed = freshSeed()): void {
  const active = activeTechnique();
  if (!active) {
    useUiStore.getState().pushToast('info', 'Add a source first — nothing to explore');
    return;
  }
  const { project } = useProjectStore.getState();
  const count = useExploreStore.getState().count;
  const parent = currentVariation(project, active.instance.params, project.explore.lastSeed ?? 1);
  const variations = mutatePopulation(
    active.definition, project.modulations, parent, populationSeed, count, currentLocks(),
    useExploreStore.getState().mode, useCandidateStore.getState().locks,
  );
  useProjectStore.getState().cancelPreview();
  candidateRuntime.setPreview(false);
  useExploreStore.getState().startGeneration(populationSeed, variations);
  useExploreStore.getState().select(parent.seed);
  void generateThumbnails(variations, project);
}

export function mutateSelected(): void {
  const active = activeTechnique();
  const { variations, selectedSeed, count } = useExploreStore.getState();
  const parent = variations.find((v) => v.seed === selectedSeed);
  if (!active || !parent) return;
  const { project } = useProjectStore.getState();
  const mutateSeed = freshSeed();
  const population = mutatePopulation(
    active.definition,
    project.modulations,
    parent,
    mutateSeed,
    count,
    currentLocks(),
    useExploreStore.getState().mode,
    useCandidateStore.getState().locks,
  );
  useProjectStore.getState().cancelPreview();
  candidateRuntime.setPreview(false);
  useExploreStore.getState().startGeneration(mutateSeed, population);
  useExploreStore.getState().select(parent.seed);
  void generateThumbnails(population, project);
}

/** Generate a mutation population centered on a compatible saved Pin. */
export function exploreAroundPin(look: PinnedLook): void {
  const { project } = useProjectStore.getState();
  const layer = look.layers?.find((item) => item.id === look.selectedLayerId);
  const active = activeTechnique();
  if (!layer?.technique || !active || layer.technique.techniqueId !== active.instance.techniqueId ||
      layer.sourceId !== selectedLayerOf(project).sourceId) {
    useUiStore.getState().pushToast('info', 'Explore Around needs the same selected source and technique');
    return;
  }
  const parent: Variation = {
    seed: look.seed,
    patch: {
      params: { ...layer.technique.params },
      modulations: Object.fromEntries(look.modulations.map((mapping) => [mapping.id, {
        amount: mapping.amount, smoothing: mapping.smoothing, curve: mapping.curve,
      }])),
    },
    generation: 0,
    parentSeed: null,
  };
  const seed = freshSeed();
  const population = mutatePopulation(
    active.definition, project.modulations, parent, seed, useExploreStore.getState().count, currentLocks(),
    useExploreStore.getState().mode, useCandidateStore.getState().locks,
  );
  useProjectStore.getState().cancelPreview();
  candidateRuntime.setPreview(false);
  useExploreStore.getState().startGeneration(seed, population);
  useExploreStore.getState().select(parent.seed);
  useUiStore.getState().setWorkspace('explore');
  void generateThumbnails(population, project);
}

function currentVariation(project: Project, params: ParamRecord, seed: number): Variation {
  return {
    seed,
    generation: 0,
    parentSeed: null,
    patch: {
      params: { ...params },
      modulations: Object.fromEntries(project.modulations.map((mapping) => [mapping.id, {
        amount: mapping.amount, smoothing: mapping.smoothing, curve: mapping.curve,
      }])),
    },
  };
}

export function backExploreGeneration(): void {
  thumbGeneration++;
  useProjectStore.getState().cancelPreview();
  useExploreStore.getState().goBack();
}

export function previewVariation(variation: Variation): void {
  const projectStore = useProjectStore.getState();
  candidateRuntime.setPreview(false);
  projectStore.beginPreview(applyVariationToProject(projectStore.project, variation), `Variation ${variation.seed}`);
}

export function endVariationPreview(): void {
  useProjectStore.getState().cancelPreview();
}

async function generateThumbnails(variations: Variation[], sourceProject: Project): Promise<void> {
  const generation = ++thumbGeneration;
  const sourceGeneration = useProjectStore.getState().projectGeneration;
  const store = useExploreStore.getState();
  const active = activeTechnique();
  if (!active) {
    store.finishGeneration();
    return;
  }
  const project = sourceProject;
  const aspect = project.composition.width / project.composition.height;
  const thumbH = Math.max(Math.round(THUMB_WIDTH / aspect), 16);

  const canvas = document.createElement('canvas');
  canvas.width = THUMB_WIDTH;
  canvas.height = thumbH;
  const ctx = canvas.getContext('2d');

  for (let i = 0; i < variations.length; i++) {
    if (generation !== thumbGeneration) return; // superseded
    const projectState = useProjectStore.getState();
    if (projectState.projectGeneration !== sourceGeneration) return;
    if (projectState.project !== sourceProject) {
      useExploreStore.getState().finishGeneration();
      return;
    }
    const variation = variations[i];
    if (!variation) continue;
    try {
      const preview = applyVariationToProject(sourceProject, variation);
      useProjectStore.getState().beginPreview(preview, null);
      const pixels = engine.renderStill(THUMB_WIDTH, thumbH);
      if (ctx) {
        ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), THUMB_WIDTH, thumbH), 0, 0);
        useExploreStore.getState().setThumbnail(variation.seed, canvas.toDataURL('image/png'));
      }
    } catch (err) {
      reportError('Explore thumbnail', err);
      break;
    } finally {
      useProjectStore.getState().cancelPreview();
    }
    useExploreStore.getState().setProgress(i + 1);
    // Yield so the UI stays responsive during generation.
    await new Promise((r) => setTimeout(r, 0));
  }
  if (generation === thumbGeneration) useExploreStore.getState().finishGeneration();
}

export function applySelectedVariation(): void {
  const { variations, selectedSeed } = useExploreStore.getState();
  const variation = variations.find((v) => v.seed === selectedSeed);
  if (!variation) return;
  useProjectStore.getState().apply((p) => applyVariationToProject(p, variation));
  useUiStore.getState().pushToast('info', `Applied variation ${variation.seed}`);
}

/** Pin the selected variation as a full composition snapshot without applying it. */
export function pinSelectedVariation(): void {
  const { variations, selectedSeed, thumbnails } = useExploreStore.getState();
  const variation = variations.find((v) => v.seed === selectedSeed);
  if (!variation) return;
  useProjectStore.getState().apply((p) => {
    const snapshot = applyVariationToProject(p, variation);
    return addPin(p, snapshot, thumbnails[variation.seed] ?? null, `variation seed ${variation.seed}`);
  });
  useUiStore.getState().pushToast('info', 'Variation pinned');
}

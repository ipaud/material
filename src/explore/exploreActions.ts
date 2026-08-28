import { engine } from '@/rendering/RenderEngine';
import { useProjectStore } from '@/state/projectStore';
import { useExploreStore } from '@/state/exploreStore';
import { reportError, useUiStore } from '@/state/uiStore';
import { getTechnique } from '@/techniques/registry';
import { freshSeed } from '@/utils/prng';
import { uid } from '@/utils/id';
import {
  applyVariationToProject,
  emptyLocks,
  generatePopulation,
  mutatePopulation,
  variationParams,
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
  const instance = project.techniques.find((t) => t.enabled);
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
  const variations = generatePopulation(
    active.definition,
    project.modulations,
    populationSeed,
    count,
    currentLocks(),
  );
  useExploreStore.getState().startGeneration(populationSeed, variations);
  void generateThumbnails(variations);
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
  );
  useExploreStore.getState().startGeneration(mutateSeed, population);
  useExploreStore.getState().select(parent.seed);
  void generateThumbnails(population);
}

async function generateThumbnails(variations: Variation[]): Promise<void> {
  const generation = ++thumbGeneration;
  const store = useExploreStore.getState();
  const active = activeTechnique();
  if (!active) {
    store.finishGeneration();
    return;
  }
  const { project } = useProjectStore.getState();
  const aspect = project.composition.width / project.composition.height;
  const thumbH = Math.max(Math.round(THUMB_WIDTH / aspect), 16);

  const canvas = document.createElement('canvas');
  canvas.width = THUMB_WIDTH;
  canvas.height = thumbH;
  const ctx = canvas.getContext('2d');

  for (let i = 0; i < variations.length; i++) {
    if (generation !== thumbGeneration) return; // superseded
    const variation = variations[i];
    if (!variation) continue;
    try {
      const params = variationParams(active.instance.params, variation);
      const pixels = engine.renderStill(THUMB_WIDTH, thumbH, params);
      if (ctx) {
        ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), THUMB_WIDTH, thumbH), 0, 0);
        useExploreStore.getState().setThumbnail(variation.seed, canvas.toDataURL('image/png'));
      }
    } catch (err) {
      reportError('Explore thumbnail', err);
      break;
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

/** Pin the selected variation as a Look without applying it. */
export function pinSelectedVariation(): void {
  const { variations, selectedSeed } = useExploreStore.getState();
  const variation = variations.find((v) => v.seed === selectedSeed);
  if (!variation) return;
  useProjectStore.getState().apply((p) => {
    const applied = applyVariationToProject(p, variation);
    const look = {
      id: uid('look'),
      createdAt: new Date().toISOString(),
      label: `Var ${String(variation.seed).slice(0, 6)}`,
      note: '',
      slot: null,
      seed: variation.seed,
      thumbnail: null,
      techniques: applied.techniques,
      material: applied.material,
      modulations: applied.modulations,
      triggers: applied.triggers,
    };
    // Keep current state; only add the look.
    return { ...p, pinnedLooks: [...p.pinnedLooks, look] };
  });
  useUiStore.getState().pushToast('info', 'Variation pinned as look');
}

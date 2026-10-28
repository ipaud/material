import {
  createEmptyProject,
  emptyLayer,
  MAX_NEW_LAYERS,
  parseProject,
  type Layer,
  type Project,
} from '@shared/schemas/project';
import { getTechnique } from '@/techniques/registry';
import { defaultParams } from '@/techniques/types';
import { generatorDefaults, getGenerator } from '@/sources/generators/definitions';
import { uid } from '@/utils/id';
import { useProjectStore } from '@/state/projectStore';
import { reportError, useUiStore } from '@/state/uiStore';

interface RecipeSpec {
  id: string;
  name: string;
  category: string;
  description: string;
  generator: string;
  source: Record<string, number | string | boolean>;
  technique: string;
  params: Record<string, number | string | boolean>;
  material: string;
  materialParams: Record<string, number | string | boolean>;
  behavior: { source: string; target: string; min: number; max: number };
  macro: { name: string; target: string; amount: number };
  pad: { label: string; target: string };
  bpm: number;
}

const RECIPE_SPECS: RecipeSpec[] = [
  {
    id: 'noise-grid',
    name: 'Noise Grid',
    category: 'Minimal',
    description: 'Noise field broken into a calm, controllable grid.',
    generator: 'noise',
    source: { scale: 3.5, speed: 0.16, detail: 3, contrast: 1.2 },
    technique: 'mosaic',
    params: { columns: 72, rows: 40, spacing: 0.08, scale: 1.05 },
    material: 'square',
    materialParams: { aspect: 1 },
    behavior: { source: 'image.luminance', target: 'scale', min: 0.65, max: 1.3 },
    macro: { name: 'DENSITY', target: 'spacing', amount: -0.2 },
    pad: { label: 'PULSE', target: 'rotation' },
    bpm: 100,
  },
  {
    id: 'interference-dots',
    name: 'Interference Dots',
    category: 'Organic',
    description: 'Moving waves resolve into a field of optical dots.',
    generator: 'waves',
    source: { frequency: 18, count: 3, speed: 0.42, spread: 0.5 },
    technique: 'mosaic',
    params: { columns: 80, rows: 45, spacing: 0.12, lumToScale: 1 },
    material: 'dot',
    materialParams: { aspect: 1 },
    behavior: { source: 'image.edgeEnergy', target: 'spacing', min: 0.02, max: 0.32 },
    macro: { name: 'ENERGY', target: 'scale', amount: 0.25 },
    pad: { label: 'ROTATE', target: 'rotation' },
    bpm: 110,
  },
  {
    id: 'crystal-map',
    name: 'Crystal Map',
    category: 'Geometry',
    description: 'Voronoi cells translated into a shifting circular map.',
    generator: 'voronoi',
    source: { scale: 10, jitter: 0.8, speed: 0.18, edge: 0.12 },
    technique: 'mosaic',
    params: { columns: 48, rows: 48, spacing: 0.04, scale: 1.2 },
    material: 'circle',
    materialParams: { aspect: 1 },
    behavior: { source: 'image.contrast', target: 'threshold', min: 0, max: 0.24 },
    macro: { name: 'SCALE', target: 'scale', amount: 0.3 },
    pad: { label: 'SHIFT', target: 'rotation' },
    bpm: 96,
  },
  {
    id: 'lattice-lines',
    name: 'Lattice Lines',
    category: 'Geometry',
    description: 'A precise line generator with a playable geometric grid.',
    generator: 'grid',
    source: { scale: 16, width: 0.09, rotation: 12, mode: 0 },
    technique: 'mosaic',
    params: { columns: 64, rows: 36, spacing: 0, scale: 1 },
    material: 'line',
    materialParams: { aspect: 1 },
    behavior: { source: 'image.luminance', target: 'rotation', min: -18, max: 18 },
    macro: { name: 'DENSITY', target: 'spacing', amount: -0.2 },
    pad: { label: 'KICK', target: 'rotation' },
    bpm: 120,
  },
  {
    id: 'chladni-script',
    name: 'Chladni Script',
    category: 'Typography',
    description: 'Standing-wave forms reconstructed from repeated characters.',
    generator: 'chladni',
    source: { modeX: 3, modeY: 5, threshold: 0.08, softness: 0.2 },
    technique: 'mosaic',
    params: { columns: 54, rows: 32, glyphIndex: 0, lumToScale: 0.9 },
    material: 'typography',
    materialParams: {
      text: 'MATERIAL',
      mode: 'character',
      fontId: 'noto-sans-mono',
      weight: 500,
      size: 144,
      tracking: 4,
    },
    behavior: { source: 'image.luminance', target: 'glyphIndex', min: 0, max: 20 },
    macro: { name: 'TYPE', target: 'glyphIndex', amount: 0.25 },
    pad: { label: 'STEP', target: 'rotation' },
    bpm: 108,
  },
  {
    id: 'weather-type',
    name: 'Weather Type',
    category: 'Typography',
    description: 'A word field whose texture shifts with the moving noise.',
    generator: 'noise',
    source: { scale: 6, speed: 0.35, detail: 4, warp: 0.45 },
    technique: 'mosaic',
    params: { columns: 42, rows: 28, glyphIndex: 4, spacing: 0.08, scale: 1.2 },
    material: 'typography',
    materialParams: {
      text: 'STORM / SIGNAL / FIELD',
      mode: 'word',
      fontId: 'noto-sans-mono',
      weight: 600,
      size: 120,
      tracking: 2,
    },
    behavior: { source: 'image.luminance', target: 'rotation', min: -22, max: 22 },
    macro: { name: 'CHAOS', target: 'jitterX', amount: 0.3 },
    pad: { label: 'WIND', target: 'jitterY' },
    bpm: 92,
  },
  {
    id: 'cellular-orbit',
    name: 'Cellular Orbit',
    category: 'Organic',
    description: 'Cellular source and circular material make a slow moving organism.',
    generator: 'cellular',
    source: { scale: 7, speed: 0.2 },
    technique: 'mosaic',
    params: { columns: 58, rows: 34, spacing: 0.1, scale: 1.15 },
    material: 'circle',
    materialParams: { aspect: 1 },
    behavior: { source: 'image.edgeEnergy', target: 'scale', min: 0.55, max: 1.4 },
    macro: { name: 'PULSE', target: 'scale', amount: 0.24 },
    pad: { label: 'ORBIT', target: 'rotation' },
    bpm: 84,
  },
  {
    id: 'chemical-bloom',
    name: 'Chemical Bloom',
    category: 'Organic',
    description: 'Reaction diffusion generates a living surface for granular cells.',
    generator: 'reaction-diffusion',
    source: { feed: 0.055, kill: 0.062, speed: 1 },
    technique: 'mosaic',
    params: { columns: 72, rows: 40, spacing: 0.04, threshold: 0.18 },
    material: 'dot',
    materialParams: { aspect: 1 },
    behavior: { source: 'image.luminance', target: 'scale', min: 0.35, max: 1.4 },
    macro: { name: 'REACTION', target: 'threshold', amount: 0.18 },
    pad: { label: 'SEED', target: 'rotation' },
    bpm: 104,
  },
  {
    id: 'motion-rgb',
    name: 'Motion RGB',
    category: 'Motion',
    description: 'Wave interference splits into red and blue trails driven by motion.',
    generator: 'waves',
    source: { frequency: 12, count: 4, speed: 0.5, spread: 0.62 },
    technique: 'motion-rgb',
    params: { amount: 1.1, threshold: 0.025 },
    material: 'rectangle',
    materialParams: { aspect: 1.35 },
    behavior: { source: 'motion.amount', target: 'amount', min: 0.25, max: 1.8 },
    macro: { name: 'MOTION', target: 'amount', amount: 0.3 },
    pad: { label: 'FLASH', target: 'threshold' },
    bpm: 118,
  },
  {
    id: 'liquid-letter',
    name: 'Liquid Letter',
    category: 'Typography',
    description: 'Large repeated type bends along the generator field’s motion.',
    generator: 'noise',
    source: { scale: 4, speed: 0.48, warp: 0.7, detail: 4 },
    technique: 'flow-displace',
    params: { amount: 1.1, threshold: 0.035 },
    material: 'typography',
    materialParams: {
      text: 'DRIFT',
      mode: 'character',
      fontId: 'noto-sans-mono',
      weight: 700,
      size: 192,
      tracking: 8,
    },
    behavior: { source: 'motion.amount', target: 'amount', min: 0.2, max: 1.6 },
    macro: { name: 'DRIFT', target: 'amount', amount: 0.25 },
    pad: { label: 'PULL', target: 'amount' },
    bpm: 88,
  },
  {
    id: 'soft-smear',
    name: 'Soft Smear',
    category: 'Motion',
    description: 'A cellular field stretches into directional, painterly marks.',
    generator: 'voronoi',
    source: { scale: 6, jitter: 0.7, speed: 0.32, edge: 0 },
    technique: 'directional-smear',
    params: { amount: 1.3, samples: 8, threshold: 0.04 },
    material: 'line',
    materialParams: { aspect: 1 },
    behavior: { source: 'motion.activity', target: 'amount', min: 0.3, max: 2.2 },
    macro: { name: 'LENGTH', target: 'amount', amount: 0.22 },
    pad: { label: 'STRETCH', target: 'amount' },
    bpm: 100,
  },
  {
    id: 'chladni-flow',
    name: 'Chladni Flow',
    category: 'Motion',
    description: 'Resonance figures stretch and split as the standing wave moves.',
    generator: 'chladni',
    source: { modeX: 4, modeY: 7, phase: 0.2, softness: 0.3 },
    technique: 'motion-rgb',
    params: { amount: 0.7, threshold: 0.02 },
    material: 'triangle',
    materialParams: { aspect: 0.8 },
    behavior: { source: 'motion.amount', target: 'amount', min: 0.2, max: 1.2 },
    macro: { name: 'RESONANCE', target: 'amount', amount: 0.25 },
    pad: { label: 'RING', target: 'threshold' },
    bpm: 112,
  },
  {
    id: 'voronoi-smear',
    name: 'Voronoi Smear',
    category: 'Glitch',
    description: 'Moving crystal boundaries smear into high-contrast directional marks.',
    generator: 'voronoi',
    source: { scale: 14, jitter: 0.95, speed: 0.4, edge: 0.08 },
    technique: 'directional-smear',
    params: { amount: 1.8, samples: 10, threshold: 0.055 },
    material: 'rectangle',
    materialParams: { aspect: 1.8 },
    behavior: { source: 'motion.activity', target: 'amount', min: 0.4, max: 2.6 },
    macro: { name: 'BREAK', target: 'amount', amount: 0.3 },
    pad: { label: 'CUT', target: 'threshold' },
    bpm: 126,
  },
];

export interface RecipeSummary {
  id: string;
  name: string;
  category: string;
  description: string;
  generator: string;
  techniqueId: string;
  materialId: string;
}

export function listRecipes(): RecipeSummary[] {
  return RECIPE_SPECS.map(
    ({ id, name, category, description, generator, technique, material }) => ({
      id,
      name,
      category,
      description,
      generator,
      techniqueId: technique,
      materialId: material,
    }),
  );
}

function isBlankLayer(layer: Layer): boolean {
  return (
    layer.sourceId === null &&
    layer.technique === null &&
    layer.techniqueChain.length === 0 &&
    layer.name === '' &&
    layer.enabled &&
    !layer.solo &&
    layer.opacity === 1 &&
    layer.blendMode === 'normal' &&
    layer.input === 'source' &&
    layer.activity === null &&
    layer.material.materialId === 'square' &&
    layer.material.colorMode === 'source' &&
    layer.material.assetPath === null &&
    Object.keys(layer.material.params).length === 0
  );
}

export function buildRecipeProject(id: string): Project | null {
  const spec = RECIPE_SPECS.find((recipe) => recipe.id === id);
  const generator = spec && getGenerator(spec.generator);
  const technique = spec && getTechnique(spec.technique);
  if (!spec || !generator || !technique) return null;

  const project = createEmptyProject(spec.name);
  const sourceId = 'recipe-source';
  const layerId = 'recipe-layer';
  const techniqueId = 'recipe-technique';
  const material = {
    materialId: spec.material,
    colorMode: 'source' as const,
    params: spec.materialParams,
    assetPath: null,
  };
  const layer: Layer = {
    ...emptyLayer(layerId, spec.name),
    sourceId,
    technique: {
      id: techniqueId,
      techniqueId: spec.technique,
      enabled: true,
      params: { ...defaultParams(technique), ...spec.params },
    },
    material,
  };

  return parseProject({
    ...project,
    name: spec.name,
    sources: [
      {
        id: sourceId,
        kind: 'generator',
        generator: spec.generator,
        params: { ...generatorDefaults(spec.generator), ...spec.source },
        seed: 1,
      },
    ],
    composition: { ...project.composition, sourceId, width: 1920, height: 1080 },
    layers: [layer],
    selectedLayerId: layerId,
    techniques: [layer.technique],
    material,
    modulations: [
      {
        id: 'recipe-behavior',
        enabled: true,
        source: spec.behavior.source,
        target: spec.behavior.target,
        amount: 1,
        min: spec.behavior.min,
        max: spec.behavior.max,
        invert: false,
        smoothing: 0.2,
        curve: 'linear',
        frozenValue: null,
        targetLayerId: layerId,
      },
    ],
    triggers: [],
    macros: [
      {
        id: 'recipe-macro',
        name: spec.macro.name,
        value: 0,
        mappings: [
          {
            targetParam: spec.macro.target,
            amount: spec.macro.amount,
            min: 0,
            max: 1,
            invert: false,
            curve: 'linear',
            enabled: true,
          },
        ],
      },
    ],
    performancePads: [
      {
        id: 'recipe-pad',
        label: spec.pad.label,
        velocityScale: false,
        trigger: {
          id: 'recipe-pad-trigger',
          enabled: true,
          source: 'manual',
          action: 'pulse',
          targetParam: spec.pad.target,
          targetMappingId: null,
          lookSlot: null,
          quantize: 'off',
          cooldownSec: 0,
          attackSec: 0.02,
          holdSec: 0.04,
          decaySec: 0.24,
          targetLayerId: layerId,
          amount: 0.25,
          curve: 'easeOut',
        },
      },
    ],
    timeline: { ...project.timeline, bpm: spec.bpm },
  });
}

export function applyRecipe(id: string): boolean {
  const recipe = RECIPE_SPECS.find((entry) => entry.id === id);
  if (!recipe) return false;
  let applied = false;
  try {
    useProjectStore.getState().apply((project) => {
      const candidate = buildRecipeProject(id);
      if (!candidate) return project;
      const availableLayer = project.layers.find(isBlankLayer);
      const layer =
        availableLayer ??
        (project.layers.length < MAX_NEW_LAYERS ? emptyLayer(uid('layer')) : null);
      if (!layer) return project;
      const sourceId = uid('gen');
      const technique = candidate.layers[0]!.technique!;
      const configured: Layer = {
        ...candidate.layers[0]!,
        id: layer.id,
        sourceId,
        technique: { ...technique, id: uid('tech') },
      };
      const modulations = candidate.modulations.map((mapping) => ({
        ...mapping,
        id: uid('mod'),
        targetLayerId: layer.id,
      }));
      const macros = candidate.macros.map((macro) => ({ ...macro, id: uid('macro') }));
      const performancePads = candidate.performancePads.map((pad) => ({
        ...pad,
        id: uid('pad'),
        trigger: pad.trigger
          ? { ...pad.trigger, id: uid('trigger'), targetLayerId: layer.id }
          : null,
      }));
      const layers = availableLayer
        ? project.layers.map((entry) => (entry.id === layer.id ? configured : entry))
        : [...project.layers, configured];
      const next: Project = {
        ...project,
        name: project.name === 'Untitled' ? recipe.name : project.name,
        sources: [
          ...project.sources,
          {
            id: sourceId,
            kind: 'generator',
            generator: recipe.generator,
            params: candidate.sources[0]!.kind === 'generator' ? candidate.sources[0]!.params : {},
            seed: 1,
          },
        ],
        composition: { ...project.composition, sourceId },
        layers,
        selectedLayerId: layer.id,
        techniques: configured.technique ? [configured.technique] : [],
        material: configured.material,
        modulations: [...project.modulations, ...modulations],
        macros: [...project.macros, ...macros],
        performancePads: [...project.performancePads, ...performancePads],
        timeline: { ...project.timeline, bpm: project.timeline.bpm ?? recipe.bpm },
      };
      applied = next !== project;
      return next;
    });
  } catch (error) {
    reportError('Start recipe', error);
    return false;
  }
  if (applied) useUiStore.getState().pushToast('info', `Recipe ready: ${recipe.name}`);
  else
    useUiStore
      .getState()
      .pushToast('error', 'No free layer for recipe · keep up to four new layers');
  return applied;
}

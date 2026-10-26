import { selectedLayerOf, withSelectedTechnique } from '@shared/schemas/project';
import { mulberry32, deriveSeed } from '@/utils/prng';
import { allParams, type NumberParamDef, type TechniqueDefinition } from '@/techniques/types';
import {
  emptyMutationLocks,
  isStructuralParam,
  MUTATION_PROFILE,
  mutationParamFamily,
  type MutationIntensity,
  type MutationLocks,
} from '@/performance/mutation';
import type { ModulationMapping, ParamRecord, ParamValue, Project } from '@shared/schemas/project';

/**
 * Seeded, reproducible parameter exploration.
 * A variation is fully described by {seed, patch}; regenerating from the same
 * base state and seed always yields the same patch.
 */

export interface ModulationPatch {
  amount?: number;
  smoothing?: number;
  curve?: ModulationMapping['curve'];
}

export interface VariationPatch {
  params: Record<string, ParamValue>;
  modulations: Record<string, ModulationPatch>;
}

export interface Variation {
  seed: number;
  patch: VariationPatch;
  /** Lineage for MUTATE. */
  generation: number;
  parentSeed: number | null;
}

const CURVES: ModulationMapping['curve'][] = ['linear', 'exponential', 'logarithmic'];
/** Safe range for modulation-amount exploration. */
const MOD_AMOUNT_RANGE: [number, number] = [-1, 1];

export type ExploreMutationMode = 'subtle' | 'variation' | 'wild' | 'structure';

function modeIntensity(mode: ExploreMutationMode): MutationIntensity {
  if (mode === 'subtle') return 'low';
  if (mode === 'wild') return 'high';
  return 'med';
}

export interface ExploreLocks {
  /** Locked technique param ids. */
  params: Set<string>;
  /** Locked modulation mapping ids. */
  modulations: Set<string>;
  material: boolean;
}

export function emptyLocks(): ExploreLocks {
  return { params: new Set(), modulations: new Set(), material: false };
}

function exploreRange(def: NumberParamDef): [number, number] {
  return [def.explore?.min ?? def.min, def.explore?.max ?? def.max];
}

function randomizableParams(definition: TechniqueDefinition, locks: ExploreLocks) {
  return allParams(definition).filter((p) => p.explore?.randomizable && !locks.params.has(p.id));
}

/** Generate one variation patch from a seed (root generation). */
export function generateVariation(
  definition: TechniqueDefinition,
  mappings: ModulationMapping[],
  seed: number,
  locks: ExploreLocks,
): VariationPatch {
  const rng = mulberry32(seed);
  const patch: VariationPatch = { params: {}, modulations: {} };

  for (const def of randomizableParams(definition, locks)) {
    const weight = def.explore?.weight ?? 1;
    if (rng() > weight) continue;
    if (def.type === 'number') {
      const [lo, hi] = exploreRange(def);
      const raw = lo + rng() * (hi - lo);
      patch.params[def.id] = def.step >= 1 ? Math.round(raw) : Number(raw.toFixed(4));
    } else if (def.type === 'boolean') {
      patch.params[def.id] = rng() > 0.5;
    } else {
      const option = def.options[Math.floor(rng() * def.options.length)];
      if (option) patch.params[def.id] = option.value;
    }
  }

  // Modulation: mutate amount/smoothing/curve only — never source/target.
  for (const mapping of mappings) {
    if (locks.modulations.has(mapping.id)) continue;
    const mod: ModulationPatch = {};
    if (rng() < 0.8) {
      const [lo, hi] = MOD_AMOUNT_RANGE;
      mod.amount = Number((lo + rng() * (hi - lo)).toFixed(3));
    }
    if (rng() < 0.5) mod.smoothing = Number(rng().toFixed(3));
    if (rng() < 0.35) mod.curve = CURVES[Math.floor(rng() * CURVES.length)] ?? 'linear';
    if (Object.keys(mod).length > 0) patch.modulations[mapping.id] = mod;
  }

  return patch;
}

/** Root population: N deterministic variations from one population seed. */
export function generatePopulation(
  definition: TechniqueDefinition,
  mappings: ModulationMapping[],
  populationSeed: number,
  count: number,
  locks: ExploreLocks,
): Variation[] {
  return Array.from({ length: count }, (_, i) => {
    const seed = deriveSeed(populationSeed, i);
    return {
      seed,
      patch: generateVariation(definition, mappings, seed, locks),
      generation: 0,
      parentSeed: null,
    };
  });
}

/**
 * MUTATE: population centered on a parent variation with reduced deviations.
 * Numeric params wander ±MUTATE_SIGMA of the exploration span around the
 * parent value; curve/boolean/select values flip with low probability.
 */
export function mutatePopulation(
  definition: TechniqueDefinition,
  mappings: ModulationMapping[],
  parent: Variation,
  mutateSeed: number,
  count: number,
  locks: ExploreLocks,
  mode: ExploreMutationMode = 'variation',
  mutationLocks: MutationLocks = emptyMutationLocks(),
): Variation[] {
  const paramDefs = new Map(definition.sections.flatMap((section) =>
    section.params.map((def) => [def.id, { def, section: section.label }] as const)));
  const { sigma: sigmaFraction, flipChance, rate } = MUTATION_PROFILE[modeIntensity(mode)];
  return Array.from({ length: count }, (_, i) => {
    // Slot 0 = the parent itself so the anchor stays visible in the grid.
    if (i === 0) {
      return { ...parent, generation: parent.generation, parentSeed: parent.parentSeed };
    }
    const seed = deriveSeed(mutateSeed, i);
    const rng = mulberry32(seed);
    const patch: VariationPatch = { params: {}, modulations: {} };

    for (const [paramId, parentValue] of Object.entries(parent.patch.params)) {
      const entry = paramDefs.get(paramId);
      if (!entry) continue;
      const { def, section } = entry;
      const family = mutationParamFamily(section);
      const locked = locks.params.has(paramId) || mutationLocks.technique ||
        (family === 'timing' && mutationLocks.timing) || (family === 'color' && mutationLocks.color);
      const canMutate = def.explore?.randomizable && !locked &&
        (mode !== 'structure' || isStructuralParam(section, def));
      if (!canMutate || rng() > rate * (def.explore?.weight ?? 1)) {
        patch.params[paramId] = parentValue;
        continue;
      }
      if (def.type === 'number' && typeof parentValue === 'number') {
        const [lo, hi] = exploreRange(def);
        const sigma = (hi - lo) * sigmaFraction;
        const raw = Math.min(Math.max(parentValue + (rng() * 2 - 1) * sigma, lo), hi);
        patch.params[paramId] = def.step >= 1 ? Math.round(raw) : Number(raw.toFixed(4));
      } else if (def.type === 'boolean' && typeof parentValue === 'boolean') {
        patch.params[paramId] = rng() < flipChance ? !parentValue : parentValue;
      } else {
        const options = def.type === 'select' ? def.options.filter((option) => option.value !== parentValue) : [];
        const option = options[Math.floor(rng() * options.length)];
        patch.params[paramId] = rng() < flipChance && option ? option.value : parentValue;
      }
    }

    for (const [mappingId, parentMod] of Object.entries(parent.patch.modulations)) {
      if (mode === 'structure' || mutationLocks.signals || locks.modulations.has(mappingId) || rng() > rate) {
        patch.modulations[mappingId] = { ...parentMod };
        continue;
      }
      if (!mappings.some((m) => m.id === mappingId)) continue;
      const mod: ModulationPatch = { ...parentMod };
      if (typeof parentMod.amount === 'number') {
        const sigma = (MOD_AMOUNT_RANGE[1] - MOD_AMOUNT_RANGE[0]) * sigmaFraction;
        mod.amount = Number(
          Math.min(Math.max(parentMod.amount + (rng() * 2 - 1) * sigma, -1), 1).toFixed(3),
        );
      }
      if (typeof parentMod.smoothing === 'number') {
        mod.smoothing = Number(Math.min(Math.max(parentMod.smoothing + (rng() * 2 - 1) * sigmaFraction, 0), 1).toFixed(3));
      }
      if (parentMod.curve && rng() < flipChance) {
        mod.curve = CURVES[Math.floor(rng() * CURVES.length)] ?? parentMod.curve;
      }
      patch.modulations[mappingId] = mod;
    }

    return { seed, patch, generation: parent.generation + 1, parentSeed: parent.seed };
  });
}

/** Merge a variation into the project (single undoable change). */
export function applyVariationToProject(project: Project, variation: Variation): Project {
  // v0.6: Explore mutates the SELECTED layer. Mutating every layer at once
  // would make one roll rewrite the whole composition, which is not an
  // audition — it is a different project.
  const active = selectedLayerOf(project).technique;
  if (!active) return project;
  return {
    ...withSelectedTechnique(project, (t) =>
      t ? { ...t, params: { ...t.params, ...variation.patch.params } } : null,
    ),
    modulations: project.modulations.map((m) => {
      const mod = variation.patch.modulations[m.id];
      return mod ? { ...m, ...mod } : m;
    }),
    explore: { ...project.explore, lastSeed: variation.seed },
  };
}

/** Effective technique params for previewing a variation (no project mutation). */
export function variationParams(base: ParamRecord, variation: Variation): ParamRecord {
  return { ...base, ...variation.patch.params };
}

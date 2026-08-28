import { mulberry32, deriveSeed } from '@/utils/prng';
import { allParams, type NumberParamDef, type TechniqueDefinition } from '@/techniques/types';
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
/** Mutation range = this fraction of the exploration span, per generation. */
const MUTATE_SIGMA = 0.25;
/** Safe range for modulation-amount exploration. */
const MOD_AMOUNT_RANGE: [number, number] = [-1, 1];

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
): Variation[] {
  const paramDefs = new Map(allParams(definition).map((p) => [p.id, p]));
  return Array.from({ length: count }, (_, i) => {
    // Slot 0 = the parent itself so the anchor stays visible in the grid.
    if (i === 0) {
      return { ...parent, generation: parent.generation, parentSeed: parent.parentSeed };
    }
    const seed = deriveSeed(mutateSeed, i);
    const rng = mulberry32(seed);
    const patch: VariationPatch = { params: {}, modulations: {} };

    for (const [paramId, parentValue] of Object.entries(parent.patch.params)) {
      if (locks.params.has(paramId)) continue;
      const def = paramDefs.get(paramId);
      if (!def) continue;
      if (def.type === 'number' && typeof parentValue === 'number') {
        const [lo, hi] = exploreRange(def);
        const sigma = (hi - lo) * MUTATE_SIGMA;
        const raw = Math.min(Math.max(parentValue + (rng() * 2 - 1) * sigma, lo), hi);
        patch.params[paramId] = def.step >= 1 ? Math.round(raw) : Number(raw.toFixed(4));
      } else if (def.type === 'boolean' && typeof parentValue === 'boolean') {
        patch.params[paramId] = rng() < 0.15 ? !parentValue : parentValue;
      } else {
        patch.params[paramId] = parentValue;
      }
    }

    for (const [mappingId, parentMod] of Object.entries(parent.patch.modulations)) {
      if (locks.modulations.has(mappingId)) continue;
      if (!mappings.some((m) => m.id === mappingId)) continue;
      const mod: ModulationPatch = { ...parentMod };
      if (typeof parentMod.amount === 'number') {
        const sigma = (MOD_AMOUNT_RANGE[1] - MOD_AMOUNT_RANGE[0]) * MUTATE_SIGMA;
        mod.amount = Number(
          Math.min(Math.max(parentMod.amount + (rng() * 2 - 1) * sigma, -1), 1).toFixed(3),
        );
      }
      if (typeof parentMod.smoothing === 'number') {
        mod.smoothing = Number(
          Math.min(Math.max(parentMod.smoothing + (rng() * 2 - 1) * 0.2, 0), 1).toFixed(3),
        );
      }
      if (parentMod.curve && rng() < 0.15) {
        mod.curve = CURVES[Math.floor(rng() * CURVES.length)] ?? parentMod.curve;
      }
      patch.modulations[mappingId] = mod;
    }

    return { seed, patch, generation: parent.generation + 1, parentSeed: parent.seed };
  });
}

/** Merge a variation into the project (single undoable change). */
export function applyVariationToProject(project: Project, variation: Variation): Project {
  const active = project.techniques.find((t) => t.enabled);
  if (!active) return project;
  return {
    ...project,
    techniques: project.techniques.map((t) =>
      t.id === active.id ? { ...t, params: { ...t.params, ...variation.patch.params } } : t,
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

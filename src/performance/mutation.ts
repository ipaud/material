import { mulberry32 } from '@/utils/prng';
import type { ParamDef, TechniqueDefinition } from '@/techniques/types';
import type { LookCore, ModulationMapping, ParamValue } from '@shared/schemas/project';

/**
 * Candidate mutation (Phase 16): deterministic variation of a complete
 * LookCore, for the CURRENT → CANDIDATE performance loop.
 *
 * Same discipline as the Explore engine it extends: values wander ±sigma of
 * each parameter's EXPLORE range (never its raw min/max), so a candidate is
 * always inside the safe, musically usable band. Modulation source/target
 * topology is never randomized — only the shaping (amount / smoothing /
 * curve) moves. Macro values and definitions are never touched: macros are
 * the performer's hands, not material (§16).
 *
 * Purity: (core, seed, intensity, locks) → identical candidate, always.
 */

export type MutationIntensity = 'low' | 'med' | 'high';

/** Fraction of a parameter's explore span a value may wander, per intensity. */
/** Shared profile keeps Candidate and seeded Explore mutation calibrated alike. */
export const MUTATION_PROFILE = {
  low: { sigma: 0.1, flipChance: 0.05, rate: 0.22 },
  med: { sigma: 0.25, flipChance: 0.15, rate: 0.4 },
  high: { sigma: 0.45, flipChance: 0.3, rate: 0.6 },
} as const satisfies Record<MutationIntensity, { sigma: number; flipChance: number; rate: number }>;

/**
 * Performance-level lock groups (§15). TECHNIQUE is the superset of the
 * per-family locks; TIMING and COLOR carve out the two families performers
 * most often want to protect. Detailed per-parameter locks stay in Explore.
 *
 * Two groups from the spec are structurally guaranteed instead of toggled,
 * because mutation never touches them: modulation TOPOLOGY (source/target)
 * and MATERIAL. `material` is kept in the type for the day material joins
 * the per-frame transform.
 */
export interface MutationLocks {
  technique: boolean;
  material: boolean;
  timing: boolean;
  signals: boolean;
  color: boolean;
}

export function emptyMutationLocks(): MutationLocks {
  return { technique: false, material: false, timing: false, signals: false, color: false };
}

const TIMING_SECTION = /temporal|time|offset|step|scan/i;
const COLOR_SECTION = /sampling|colou?r|blend/i;

export type MutationFamily = 'timing' | 'color' | 'structure';

/** Section label → shared lock family. */
export function mutationParamFamily(label: string): MutationFamily {
  if (TIMING_SECTION.test(label)) return 'timing';
  if (COLOR_SECTION.test(label)) return 'color';
  return 'structure';
}

const STRUCTURE_SECTION = /grid|element|scatter|depth|geometry|layout|transform|spatial|shape|position|displacement/i;
export function isStructuralParam(sectionLabel: string, def: ParamDef): boolean {
  return STRUCTURE_SECTION.test(sectionLabel) || /column|row|scale|spacing|rotation|size|width|height|geometry|displacement|offset|center/i.test(`${def.id} ${def.label}`);
}

interface MutableParam {
  def: ParamDef;
  family: MutationFamily;
}

function mutableParams(definition: TechniqueDefinition, locks: MutationLocks): MutableParam[] {
  if (locks.technique) return [];
  const out: MutableParam[] = [];
  for (const section of definition.sections) {
    const family = mutationParamFamily(section.label);
    if (family === 'timing' && locks.timing) continue;
    if (family === 'color' && locks.color) continue;
    for (const def of section.params) {
      if (!def.explore?.randomizable) continue;
      out.push({ def, family });
    }
  }
  return out;
}

function exploreRange(def: Extract<ParamDef, { type: 'number' }>): [number, number] {
  return [def.explore?.min ?? def.min, def.explore?.max ?? def.max];
}

export interface MutationMetadata {
  seed: number;
  parentSeed: number;
  intensity: MutationIntensity;
  locks: MutationLocks;
  generation: number;
  /** How many values actually moved — cheap "is this different enough" signal. */
  changedParams: number;
  changedModulations: number;
}

export interface MutationResult {
  core: LookCore;
  metadata: MutationMetadata;
}

/**
 * Mutate a LookCore around itself. The parent's values are the centre; each
 * unlocked, randomizable parameter wanders within ±sigma of its explore span
 * and is clamped back into that span.
 */
export function mutateLookCore(
  parent: LookCore,
  definition: TechniqueDefinition,
  seed: number,
  intensity: MutationIntensity,
  locks: MutationLocks,
  generation = 1,
): MutationResult {
  const rng = mulberry32(seed);
  const { sigma: sigmaFraction, flipChance, rate } = MUTATION_PROFILE[intensity];

  const params: Record<string, ParamValue> = { ...parent.params };
  let changedParams = 0;
  /**
   * Correlation constraint (§33). Several parameters can each shrink how much
   * of the frame carries image — smaller elements, wider gaps, a higher cut
   * threshold. Individually those are good variations; together they compound
   * into a near-black candidate, which was the single biggest source of
   * broken results in the measured study. At most ONE coverage-reducing move
   * is allowed per candidate; further reductions keep the parent's value.
   * Coverage-INCREASING moves are never restricted.
   */
  let coverageReductionsLeft = 1;

  for (const { def } of mutableParams(definition, locks)) {
    // Sparsity first, then the parameter's own weight.
    if (rng() > rate) continue;
    const weight = def.explore?.weight ?? 1;
    if (rng() > weight) continue;
    const current = params[def.id];

    if (def.type === 'number') {
      const [lo, hi] = exploreRange(def);
      const base = typeof current === 'number' ? current : def.default;
      // Start inside the explore band even if the look sits outside it.
      const anchor = Math.min(Math.max(base, lo), hi);
      const sigma = (hi - lo) * sigmaFraction;
      const raw = Math.min(Math.max(anchor + (rng() * 2 - 1) * sigma, lo), hi);
      const next = def.step >= 1 ? Math.round(raw) : Number(raw.toFixed(4));

      const coverage = def.explore?.coverage;
      const reducesCoverage =
        coverage !== undefined &&
        typeof current === 'number' &&
        (coverage === 'up' ? next < current : next > current);
      if (reducesCoverage) {
        if (coverageReductionsLeft <= 0) continue;
        coverageReductionsLeft--;
      }

      if (next !== current) changedParams++;
      params[def.id] = next;
    } else if (def.type === 'boolean') {
      if (rng() < flipChance) {
        params[def.id] = !(current === true);
        changedParams++;
      }
    } else {
      if (rng() < flipChance) {
        const option = def.options[Math.floor(rng() * def.options.length)];
        if (option && option.value !== current) {
          params[def.id] = option.value;
          changedParams++;
        }
      }
    }
  }

  // Modulation SHAPING only — source/target never move.
  let changedModulations = 0;
  const modulations: ModulationMapping[] = parent.modulations.map((m) => {
    if (locks.signals) return { ...m };
    const next = { ...m };
    if (rng() > rate) return next;
    if (rng() < 0.8) {
      const sigma = 2 * sigmaFraction; // amount lives in [-1, 1]
      next.amount = Number(
        Math.min(Math.max(m.amount + (rng() * 2 - 1) * sigma, -1), 1).toFixed(3),
      );
      if (next.amount !== m.amount) changedModulations++;
    }
    if (rng() < 0.5) {
      next.smoothing = Number(
        Math.min(Math.max(m.smoothing + (rng() * 2 - 1) * sigmaFraction, 0), 1).toFixed(3),
      );
    }
    if (rng() < flipChance) {
      const curves: ModulationMapping['curve'][] = ['linear', 'exponential', 'logarithmic'];
      next.curve = curves[Math.floor(rng() * curves.length)] ?? m.curve;
    }
    return next;
  });

  // Material is NOT mutated in v0.2: material state reaches the renderer
  // from the document, not through the per-frame parameter transform, so a
  // mutated material would be invisible in candidate preview — a lie the
  // performer would only discover after applying. The `material` lock stays
  // in the type for when the material pipeline joins the transform.

  return {
    core: { ...parent, params, modulations, seed },
    metadata: {
      seed,
      parentSeed: parent.seed,
      intensity,
      locks: { ...locks },
      generation,
      changedParams,
      changedModulations,
    },
  };
}

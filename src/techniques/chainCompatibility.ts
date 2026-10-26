import type { ParamRecord } from '@shared/schemas/project';
import { getTechnique, techniqueNeedsTemporal } from './registry';

export interface TechniqueChainStage {
  techniqueId: string;
  params: ParamRecord | Record<string, unknown>;
}

export interface TechniqueChainAssessment {
  compatible: boolean;
  reason?: string;
}

const REASONS = {
  empty: 'A technique chain needs at least one stage.',
  tooLong: 'Technique chains support at most 3 stages.',
  unavailable: 'This technique is unavailable or has no chain compatibility contract.',
  temporal: 'Temporal stages need per-stage history and cannot be chained yet.',
  feedback: 'Feedback stages need per-stage state and export replay; chaining is not supported yet.',
  simulation: 'Simulation stages need per-stage state and deterministic export stepping.',
  unsupported: 'This technique cannot safely run inside a chain yet.',
} as const;

/** Keep current single-stage projects valid; gate new chains by explicit renderer lifecycle metadata. */
export function assessTechniqueChain(
  stages: readonly TechniqueChainStage[] | undefined,
): TechniqueChainAssessment {
  if (!stages) return { compatible: false, reason: REASONS.empty };
  if (stages.length === 0) return { compatible: false, reason: REASONS.empty };
  if (stages.length > 3) return { compatible: false, reason: REASONS.tooLong };
  if (stages.length === 1) return { compatible: true };

  for (const stage of stages) {
    const definition = getTechnique(stage.techniqueId);
    if (!definition) return { compatible: false, reason: REASONS.unavailable };
    if (techniqueNeedsTemporal(stage.techniqueId, stage.params)) {
      return { compatible: false, reason: REASONS.temporal };
    }
    if (definition.chainBehavior === 'stateless' || definition.chainBehavior === 'flow') continue;
    if (definition.chainBehavior === 'temporal') return { compatible: false, reason: REASONS.temporal };
    if (definition.chainBehavior === 'feedback') return { compatible: false, reason: REASONS.feedback };
    if (definition.chainBehavior === 'simulation') return { compatible: false, reason: REASONS.simulation };
    return { compatible: false, reason: REASONS.unsupported };
  }

  return { compatible: true };
}

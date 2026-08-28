/**
 * Pattern Engine P2 — serialized definitions and evaluation results.
 *
 * Definitions are the persistable form (P6). CompiledPattern (see
 * compilePattern.ts) is the runtime form and is never persisted.
 */

export type PatternValue = number | boolean;

export interface ConstantPattern {
  type: 'constant';
  value: PatternValue;
}

export interface SequencePattern {
  type: 'sequence';
  values: PatternValue[];
}

export interface EuclideanPattern {
  type: 'euclidean';
  pulses: number;
  steps: number;
  rotation: number;
  activeValue: PatternValue;
  inactiveValue: PatternValue;
}

export type PatternDefinition = ConstantPattern | SequencePattern | EuclideanPattern;

// ---- Transforms ---------------------------------------------------------

export interface FastTransform {
  type: 'fast';
  factor: number;
}
export interface SlowTransform {
  type: 'slow';
  factor: number;
}
export interface ReverseTransform {
  type: 'reverse';
}
export interface RotateTransform {
  type: 'rotate';
  steps: number;
}
/** Every wraps exactly ONE non-Every transform — bounded by construction. */
export interface EveryTransform {
  type: 'every';
  cycles: number;
  transform: FastTransform | SlowTransform | ReverseTransform | RotateTransform;
}
/**
 * P3: probabilistic event gate. NOT a coordinate transform — it gates the
 * final evaluated event (post-value), keyed on the transformed cycle and
 * presented step. `sample < probability` keeps the event: 0 → never active,
 * 1 → always active.
 */
export interface DegradeTransform {
  type: 'degrade';
  probability: number;
}

export type PatternTransform =
  | FastTransform
  | SlowTransform
  | ReverseTransform
  | RotateTransform
  | EveryTransform
  | DegradeTransform;

// ---- Evaluation ---------------------------------------------------------

/**
 * A pattern either contributes a value or explicitly does not. P4 maps
 * `active: false` onto the modulation system's no-contribution semantics;
 * P3 Degrade will gate events through the same shape.
 */
export type PatternEvaluation =
  | {
      active: true;
      value: PatternValue;
      stepIndex: number;
      cycleIndex: number;
      /**
       * P3: whether this step is a discrete EVENT (a Euclidean pulse; every
       * step of a sequence/constant). Degrade gates events only — Euclidean
       * rest steps stay active with their inactiveValue, ungated. Also the
       * seam future trigger integration will read.
       */
      event: boolean;
    }
  | { active: false };

export const PATTERN_INACTIVE: PatternEvaluation = Object.freeze({ active: false });

/**
 * P3: deterministic identity the CALLER supplies for probabilistic patterns.
 * The pure engine never reads stores — `projectSeed` is
 * `project.explore.lastSeed ?? 1`, `patternId` a stable per-instance id.
 */
export interface PatternEvaluationContext {
  projectSeed: number;
  patternId: string;
}

/** Minimal musical position — PatternClockState is assignable to this. */
export interface PatternPosition {
  cycleIndex: number;
  cyclePhase: number;
}

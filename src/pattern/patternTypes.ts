/**
 * Pattern Engine P2 — serialized definitions and evaluation results.
 *
 * Definitions are the persistable form (P6). CompiledPattern (see
 * compilePattern.ts) is the runtime form and is never persisted.
 */

/** `null` is a REST: the step exists but contributes nothing (v1.5). */
export type PatternValue = number | boolean | null;

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

/**
 * v1.5 — one value per CYCLE, rotating (Tidal's `<a b c>` idea, ours by
 * semantics only). The whole cycle holds values[mod(cycle, n)].
 */
export interface AlternatePattern {
  type: 'alternate';
  values: PatternValue[];
}

export type PatternDefinition =
  | ConstantPattern
  | SequencePattern
  | EuclideanPattern
  | AlternatePattern;

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
/** v1.5 — rotation that advances `steps` per cycle (Tidal's iter). */
export interface IterTransform {
  type: 'iter';
  steps: number;
}
/** Every wraps exactly ONE non-Every transform — bounded by construction. */
export interface EveryTransform {
  type: 'every';
  cycles: number;
  transform: FastTransform | SlowTransform | ReverseTransform | RotateTransform | IterTransform;
}
/**
 * v1.5 — apply the nested transform on a cycle with deterministic
 * probability (Tidal's sometimesBy, per cycle). Samples LANE_CHOICE, so it
 * can never shift Degrade decisions.
 */
export interface MaybeTransform {
  type: 'maybe';
  probability: number;
  transform: FastTransform | SlowTransform | ReverseTransform | RotateTransform | IterTransform;
}
/** v1.5 — deterministic per-cycle permutation of the steps. */
export interface ShuffleTransform {
  type: 'shuffle';
}
/**
 * v1.5 — post-value shaping: linear interpolation from the current step's
 * value to the NEXT step's, by intra-step phase. Turns staircases into
 * waves, statelessly (unlike mapping smoothing, which is an EMA with
 * history). Position in the chain does not matter — it always shapes the
 * final looked-up value; rests and booleans fall back to steps.
 */
export interface SmoothTransform {
  type: 'smooth';
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
  | IterTransform
  | EveryTransform
  | MaybeTransform
  | ShuffleTransform
  | SmoothTransform
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

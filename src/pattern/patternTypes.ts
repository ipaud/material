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

export type PatternTransform =
  FastTransform | SlowTransform | ReverseTransform | RotateTransform | EveryTransform;

// ---- Evaluation ---------------------------------------------------------

/**
 * A pattern either contributes a value or explicitly does not. P4 maps
 * `active: false` onto the modulation system's no-contribution semantics;
 * P3 Degrade will gate events through the same shape.
 */
export type PatternEvaluation =
  { active: true; value: PatternValue; stepIndex: number; cycleIndex: number } | { active: false };

export const PATTERN_INACTIVE: PatternEvaluation = Object.freeze({ active: false });

/** Minimal musical position — PatternClockState is assignable to this. */
export interface PatternPosition {
  cycleIndex: number;
  cyclePhase: number;
}

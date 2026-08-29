import { euclideanMask } from './euclidean';
import type {
  EveryTransform,
  PatternDefinition,
  PatternTransform,
  PatternValue,
} from './patternTypes';

/**
 * Compile a serialized pattern + transform chain into the runtime form.
 * Runs when a definition CHANGES — never per frame. All validation happens
 * here; the evaluator only ever sees compiled-valid patterns and cannot
 * throw on user input.
 */

export interface CompiledEvery {
  type: 'every';
  cycles: number;
  transform: CompiledSimpleTransform;
}
export type CompiledSimpleTransform =
  | { type: 'fast'; factor: number }
  | { type: 'slow'; factor: number }
  | { type: 'reverse' }
  | { type: 'rotate'; steps: number }
  | { type: 'iter'; steps: number };
export interface CompiledMaybe {
  type: 'maybe';
  probability: number;
  transform: CompiledSimpleTransform;
  /** Chain position — the CHOICE-lane salt, so several maybes stay independent. */
  salt: number;
}
export type CompiledTransform = CompiledSimpleTransform | CompiledEvery | CompiledMaybe;

export interface CompiledPattern {
  /** Unified step values — constant compiles to length 1, Euclidean to `steps`. */
  values: PatternValue[];
  transforms: CompiledTransform[];
  /** v1.5 ALTERNATE: one value per CYCLE — index is mod(cycle, n), not phase. */
  perCycle: boolean;
  /** v1.5: deterministic per-cycle permutation of the step lookup. */
  shuffle: boolean;
  /** v1.5: lerp step→next-step by intra-step phase (post-value shaping). */
  smooth: boolean;
  /**
   * P3: which steps are discrete EVENTS. `null` = every step (sequence,
   * constant). Euclidean marks pulse steps only — derived from the mask, not
   * from values (activeValue may equal inactiveValue).
   */
  events: boolean[] | null;
  /** P3: degrade gate probabilities in serialized order (post-value gates). */
  degrades: number[];
}

export type CompileResult = { ok: true; pattern: CompiledPattern } | { ok: false; error: string };

const err = (error: string): CompileResult => ({ ok: false, error });

function isValidValue(v: unknown): v is PatternValue {
  // null is a REST — a step that exists but contributes nothing.
  return v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
}

function compileSimpleTransform(t: PatternTransform): CompiledSimpleTransform | string {
  switch (t.type) {
    case 'fast':
      if (!Number.isFinite(t.factor) || t.factor <= 0) return 'FAST factor must be > 0';
      return { type: 'fast', factor: t.factor };
    case 'slow':
      if (!Number.isFinite(t.factor) || t.factor <= 0) return 'SLOW factor must be > 0';
      return { type: 'slow', factor: t.factor };
    case 'reverse':
      return { type: 'reverse' };
    case 'rotate':
      if (!Number.isInteger(t.steps)) return 'ROTATE steps must be an integer';
      return { type: 'rotate', steps: t.steps };
    case 'iter':
      if (!Number.isInteger(t.steps)) return 'ITER steps must be an integer';
      return { type: 'iter', steps: t.steps };
    case 'every':
      return 'EVERY cannot nest another EVERY';
    case 'maybe':
      return 'MAYBE cannot nest MAYBE or EVERY';
    case 'shuffle':
      return 'SHUFFLE cannot be nested';
    case 'smooth':
      return 'SMOOTH cannot be nested';
    case 'degrade':
      // Degrade is a post-value event gate, not a coordinate transform —
      // "every 4 degrade" has no cycle-coordinate meaning in this model.
      return 'EVERY cannot wrap DEGRADE';
  }
}

function compileTransform(t: PatternTransform, index: number): CompiledTransform | string {
  if (t.type === 'every') {
    const every = t as EveryTransform;
    if (!Number.isInteger(every.cycles) || every.cycles < 1) {
      return 'EVERY cycles must be an integer ≥ 1';
    }
    const nested = compileSimpleTransform(every.transform);
    if (typeof nested === 'string') return nested;
    return { type: 'every', cycles: every.cycles, transform: nested };
  }
  if (t.type === 'maybe') {
    if (!Number.isFinite(t.probability) || t.probability < 0 || t.probability > 1) {
      return 'MAYBE probability must be within 0..1';
    }
    const nested = compileSimpleTransform(t.transform);
    if (typeof nested === 'string') return nested;
    return { type: 'maybe', probability: t.probability, transform: nested, salt: index };
  }
  return compileSimpleTransform(t);
}

export function compilePattern(
  definition: PatternDefinition,
  transforms: PatternTransform[] = [],
): CompileResult {
  let values: PatternValue[];
  let events: boolean[] | null = null;
  let perCycle = false;

  switch (definition.type) {
    case 'constant': {
      if (!isValidValue(definition.value) || definition.value === null)
        return err('CONSTANT value must be a finite number or boolean');
      values = [definition.value];
      break;
    }
    case 'alternate': {
      if (!Array.isArray(definition.values) || definition.values.length === 0) {
        return err('ALTERNATE needs at least one value');
      }
      for (const v of definition.values) {
        if (!isValidValue(v)) return err('ALTERNATE values must be finite numbers, booleans or rests');
      }
      values = definition.values.slice();
      perCycle = true;
      break;
    }
    case 'sequence': {
      if (!Array.isArray(definition.values) || definition.values.length === 0) {
        return err('SEQUENCE needs at least one value');
      }
      for (const v of definition.values) {
        if (!isValidValue(v)) return err('SEQUENCE values must be finite numbers or booleans');
      }
      values = definition.values.slice();
      break;
    }
    case 'euclidean': {
      const { pulses, steps, rotation, activeValue, inactiveValue } = definition;
      if (!Number.isInteger(steps) || steps < 1)
        return err('EUCLIDEAN steps must be an integer ≥ 1');
      if (!Number.isInteger(pulses) || pulses < 0)
        return err('EUCLIDEAN pulses must be an integer ≥ 0');
      if (pulses > steps) return err('EUCLIDEAN pulses cannot exceed steps');
      if (!Number.isInteger(rotation)) return err('EUCLIDEAN rotation must be an integer');
      if (!isValidValue(activeValue) || !isValidValue(inactiveValue)) {
        return err('EUCLIDEAN values must be finite numbers or booleans');
      }
      const mask = euclideanMask(pulses, steps);
      // Rotation folds into the compiled values: rotation r shifts the
      // pattern forward — what was at step 0 appears at step r. Normalized
      // with true mathematical modulo (negative / oversized rotations).
      values = new Array<PatternValue>(steps);
      // Event metadata follows the mask through the same rotation — a pulse
      // is an event wherever it lands, regardless of value equality.
      events = new Array<boolean>(steps);
      for (let i = 0; i < steps; i++) {
        const src = (((i - rotation) % steps) + steps) % steps;
        const isPulse = mask[src] === true;
        values[i] = isPulse ? activeValue : inactiveValue;
        events[i] = isPulse;
      }
      break;
    }
  }

  const compiled: CompiledTransform[] = [];
  const degrades: number[] = [];
  let shuffle = false;
  let smooth = false;
  for (const [index, t] of transforms.entries()) {
    if (t.type === 'shuffle') {
      // Post-mapping deck permutation: a flag, not a chain entry — its
      // position among coordinate transforms carries no meaning (documented).
      shuffle = true;
      continue;
    }
    if (t.type === 'smooth') {
      smooth = true;
      continue;
    }
    if (t.type === 'degrade') {
      // Post-value gate: validated here, sampled at evaluation. Not part of
      // the coordinate transform chain (documented in evaluatePattern).
      if (!Number.isFinite(t.probability) || t.probability < 0 || t.probability > 1) {
        return err('DEGRADE probability must be within 0..1');
      }
      degrades.push(t.probability);
      continue;
    }
    const c = compileTransform(t, index);
    if (typeof c === 'string') return err(c);
    compiled.push(c);
  }

  return {
    ok: true,
    pattern: { values, transforms: compiled, events, degrades, perCycle, shuffle, smooth },
  };
}

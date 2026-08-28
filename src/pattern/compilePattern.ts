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
  | { type: 'rotate'; steps: number };
export type CompiledTransform = CompiledSimpleTransform | CompiledEvery;

export interface CompiledPattern {
  /** Unified step values — constant compiles to length 1, Euclidean to `steps`. */
  values: PatternValue[];
  transforms: CompiledTransform[];
}

export type CompileResult = { ok: true; pattern: CompiledPattern } | { ok: false; error: string };

const err = (error: string): CompileResult => ({ ok: false, error });

function isValidValue(v: unknown): v is PatternValue {
  return typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
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
    case 'every':
      return 'EVERY cannot nest another EVERY';
  }
}

function compileTransform(t: PatternTransform): CompiledTransform | string {
  if (t.type === 'every') {
    const every = t as EveryTransform;
    if (!Number.isInteger(every.cycles) || every.cycles < 1) {
      return 'EVERY cycles must be an integer ≥ 1';
    }
    const nested = compileSimpleTransform(every.transform);
    if (typeof nested === 'string') return nested;
    return { type: 'every', cycles: every.cycles, transform: nested };
  }
  return compileSimpleTransform(t);
}

export function compilePattern(
  definition: PatternDefinition,
  transforms: PatternTransform[] = [],
): CompileResult {
  let values: PatternValue[];

  switch (definition.type) {
    case 'constant': {
      if (!isValidValue(definition.value))
        return err('CONSTANT value must be a finite number or boolean');
      values = [definition.value];
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
      for (let i = 0; i < steps; i++) {
        const src = (((i - rotation) % steps) + steps) % steps;
        values[i] = mask[src] ? activeValue : inactiveValue;
      }
      break;
    }
  }

  const compiled: CompiledTransform[] = [];
  for (const t of transforms) {
    const c = compileTransform(t);
    if (typeof c === 'string') return err(c);
    compiled.push(c);
  }

  return { ok: true, pattern: { values, transforms: compiled } };
}

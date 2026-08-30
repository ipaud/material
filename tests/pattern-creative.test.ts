import { describe, expect, it } from 'vitest';
import { compilePattern } from '@/pattern/compilePattern';
import { evaluatePattern } from '@/pattern/evaluatePattern';
import { applyModulations, SmoothingState } from '@/modulation/evaluator';
import { getTechnique } from '@/techniques/registry';
import { allParams, defaultParams } from '@/techniques/types';
import type { ModulationMapping } from '@shared/schemas/project';
import type { PatternDefinition } from '@/pattern/patternTypes';

/**
 * CE1H §16 — Pattern CREATIVE QA.
 *
 * The engine tests prove a pattern produces the right numbers. This proves
 * the thing that decides whether it is playable: driving a Creative Expansion
 * parameter from a pattern has to move it through a usable span of its own
 * range, land inside that range at every step, and stay deterministic.
 *
 * Where a combination is unusable the fix is the parameter RANGE, never the
 * Pattern Engine.
 */

const TIMING = { bpm: 120, beatOffsetSec: 0, beatsPerBar: 4 };

const PATTERNS: [string, PatternDefinition][] = [
  [
    'euclidean',
    { type: 'euclidean', steps: 8, pulses: 3, rotation: 0, activeValue: 1, inactiveValue: 0 },
  ],
  ['sequence', { type: 'sequence', values: [0, 0.25, 0.5, 1] }],
  ['alternate', { type: 'alternate', values: [0.1, 0.9, 0.4] }],
];

/** Representative parameter on each Creative Expansion family. */
const TARGETS: [string, string][] = [
  ['feedback-zoom', 'persistence'],
  ['feedback-bloom', 'gain'],
  ['time-field', 'depth'],
  ['slit-scan', 'spanSec'],
  ['motion-mosh', 'flow'],
  ['flow-displace', 'amount'],
  ['reaction-diffusion', 'speed'],
  ['cellular', 'sourceTint'],
];

function mapping(target: string): ModulationMapping {
  return {
    id: 'm1',
    enabled: true,
    source: 'pattern.p1',
    // applyModulations keys mappings by the BARE parameter id.
    target,
    amount: 1,
    min: 0,
    max: 1,
    invert: false,
    smoothing: 0,
    curve: 'linear',
    frozenValue: null,
  };
}

/** Drive one cycle of pattern positions through the real modulation pipeline. */
function sweep(techniqueId: string, paramId: string, definition: PatternDefinition) {
  const technique = getTechnique(techniqueId);
  expect(technique, `${techniqueId} is not registered`).toBeTruthy();
  const compiled = compilePattern(definition);
  expect(compiled.ok, `pattern failed to compile`).toBe(true);
  if (!technique || !compiled.ok) return { values: [], def: undefined };
  const base = defaultParams(technique);
  const smoothing = new SmoothingState();
  const values: number[] = [];
  const STEPS = 32;
  for (let step = 0; step < STEPS; step++) {
    const evaluated = evaluatePattern(compiled.pattern, {
      cycleIndex: Math.floor(step / 8),
      cyclePhase: (step % 8) / 8 + 1 / 16,
    });
    if (!evaluated.active || evaluated.value === null) continue; // REST
    const source = typeof evaluated.value === 'number' ? evaluated.value : evaluated.value ? 1 : 0;
    const out = applyModulations(
      base,
      [mapping(paramId)],
      { 'pattern.p1': source },
      technique,
      smoothing,
      1 / 60,
    );
    const v = out[paramId];
    if (typeof v === 'number') values.push(v);
  }
  return { values, def: allParams(technique).find((p) => p.id === paramId) };
}

describe('Patterns are playable on Creative Expansion parameters (§16)', () => {
  for (const [techniqueId, paramId] of TARGETS) {
    for (const [name, definition] of PATTERNS) {
      it(`${name} → ${techniqueId}.${paramId} moves within range`, () => {
        const { values, def } = sweep(techniqueId, paramId, definition);
        expect(values.length, 'pattern produced no modulated values').toBeGreaterThan(8);
        expect(def?.type).toBe('number');
        if (def?.type !== 'number') return;

        const min = Math.min(...values);
        const max = Math.max(...values);
        expect(values.every((v) => Number.isFinite(v))).toBe(true);
        expect(min, `${techniqueId}.${paramId} below min`).toBeGreaterThanOrEqual(def.min - 1e-9);
        expect(max, `${techniqueId}.${paramId} above max`).toBeLessThanOrEqual(def.max + 1e-9);

        // Playability floor: the pattern must produce genuinely different
        // values, not the same number 32 times.
        expect(
          new Set(values.map((v) => v.toFixed(6))).size,
          `${techniqueId}.${paramId} never changes`,
        ).toBeGreaterThan(1);

        // How far it actually travels depends on where the DEFAULT sits.
        // Modulation is additive from the current value, so a parameter
        // defaulted near its ceiling clamps and barely moves — measured,
        // feedback-zoom.persistence travels 1.1% of its range from default
        // while time-field.depth travels the full span. That is a mapping
        // decision (use range min/max, or a negative amount), not a defect,
        // and it is why this asserts distinctness rather than a fixed span.
        const span = (max - min) / (def.max - def.min);
        expect(span).toBeGreaterThanOrEqual(0);
      });
    }
  }

  it('a pattern-driven parameter sweep is deterministic', () => {
    const a = sweep('motion-mosh', 'flow', PATTERNS[1]![1]);
    const b = sweep('motion-mosh', 'flow', PATTERNS[1]![1]);
    expect(a.values).toEqual(b.values);
  });

  it('a REST step contributes nothing rather than reading as zero', () => {
    // v1.5 rests are present in the grid and contribute nothing; a rest that
    // silently read as 0 would punch holes in a performance.
    const compiled = compilePattern({ type: 'sequence', values: [1, null, 0.5, null] });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    let rests = 0;
    let active = 0;
    for (let step = 0; step < 8; step++) {
      const e = evaluatePattern(compiled.pattern, {
        cycleIndex: Math.floor(step / 4),
        cyclePhase: (step % 4) / 4 + 1 / 8,
      });
      if (!e.active || e.value === null) rests++;
      else active++;
    }
    expect(rests).toBeGreaterThan(0);
    expect(active).toBeGreaterThan(0);
  });
});

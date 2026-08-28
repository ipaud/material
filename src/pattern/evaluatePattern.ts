import type { CompiledPattern, CompiledSimpleTransform } from './compilePattern';
import { LANE_DEGRADE, hashPatternId, patternRandom01 } from './patternRandom';
import {
  PATTERN_INACTIVE,
  type PatternEvaluation,
  type PatternEvaluationContext,
  type PatternPosition,
} from './patternTypes';

/**
 * Pure pattern evaluation at an absolute musical position (P2).
 *
 * Coordinate model — no incremental state anywhere:
 *
 * - CYCLE-SPACE transforms (fast / slow / every) act on the continuous
 *   absolute cycle position `pos = cycleIndex + cyclePhase`:
 *   fast f → pos·f, slow f → pos/f. EVERY reads the CURRENT transformed
 *   cycle `floor(pos)` at its chain position and, on matching cycles,
 *   applies its nested transform right there.
 * - STEP-SPACE transforms (reverse / rotate) compose into one affine index
 *   map `base = (A·i + B) mod N`, composed in serialized order (the final
 *   sampled index passes through the LAST transform first — standard
 *   function composition). Order between rotate and reverse is therefore
 *   semantically meaningful and test-locked.
 *
 * EVERY semantics (locked): a cycle is transformed when
 * `mod(cycle, n) === n - 1` — "1 normal, 2 normal, 3 normal, 4 transformed".
 * Pre-roll uses true mathematical modulo, so the every-Nth lattice extends
 * backwards consistently: with n=4 the transformed cycles are …,-5,-1,3,7,…
 *
 * Boundary handling mirrors PatternClock: phases live in [0,1); float error
 * approaching 1 rolls into phase 0 of the next cycle; step sampling clamps
 * `floor(phase·N)` to N-1 so a phase of exactly 0.999…9 cannot index out.
 *
 * Evaluation is O(transform count) per call — independent of elapsed time.
 *
 * P3 — Degrade is a POST-VALUE probabilistic gate, deliberately outside the
 * coordinate chain: its identity is the final discrete event (TRANSFORMED
 * cycle + PRESENTED step), not a coordinate mapping. So `fast 2` yields two
 * independently degradable event cycles per source cycle, `slow 4` holds one
 * sample across the whole stretched event, and reverse/rotate key on the
 * step the listener actually perceives. Only EVENT steps are gated —
 * Euclidean rests stay active with inactiveValue. Sampling is a stateless
 * hash (see patternRandom.ts); `sample < probability` keeps the event.
 *
 * Context is optional for degrade-free patterns. A degraded pattern
 * evaluated without context still behaves deterministically (zero context),
 * but every such pattern shares one lane — callers must pass the real
 * project seed + stable pattern id.
 */

const PHASE_EPSILON = 1e-9;

const ZERO_CONTEXT: PatternEvaluationContext = Object.freeze({ projectSeed: 0, patternId: '' });

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

export function evaluatePattern(
  compiled: CompiledPattern,
  position: PatternPosition,
  context?: PatternEvaluationContext,
): PatternEvaluation {
  const n = compiled.values.length;
  if (n === 0) return PATTERN_INACTIVE;
  if (!Number.isFinite(position.cycleIndex) || !Number.isFinite(position.cyclePhase)) {
    return PATTERN_INACTIVE;
  }

  // Continuous absolute cycle position.
  let pos = position.cycleIndex + position.cyclePhase;
  // Affine step map: base = mod(A*i + B, n). A ∈ {1,-1}.
  let mapA = 1;
  let mapB = 0;

  // Pre-composition: the final sampled index passes through the NEWEST
  // transform first, so adding g_new updates (A,B) as A' = A·a, B' = A·b + B
  // for g_new(i) = a·i + b. reverse: a=-1, b=n-1. rotate s: a=1, b=-s.
  const applyTransform = (t: CompiledSimpleTransform): void => {
    switch (t.type) {
      case 'fast':
        pos *= t.factor;
        break;
      case 'slow':
        pos /= t.factor;
        break;
      case 'reverse':
        mapB = mod(mapA * (n - 1) + mapB, n);
        mapA = -mapA;
        break;
      case 'rotate':
        mapB = mod(mapB - mapA * t.steps, n);
        break;
    }
  };

  for (const t of compiled.transforms) {
    if (t.type === 'every') {
      const cycle = Math.floor(pos + PHASE_EPSILON * Math.sign(pos));
      if (mod(cycle, t.cycles) === t.cycles - 1) applyTransform(t.transform);
    } else {
      applyTransform(t);
    }
  }

  // Split the final continuous position, mirroring PatternClock's guard.
  let cycle = Math.floor(pos);
  let phase = pos - cycle;
  if (phase > 1 - PHASE_EPSILON) {
    cycle += 1;
    phase = 0;
  }

  const rawIndex = Math.min(Math.floor(phase * n), n - 1);
  const stepIndex = mod(mapA * rawIndex + mapB, n);
  const value = compiled.values[stepIndex];
  if (value === undefined) return PATTERN_INACTIVE;

  const event = compiled.events === null ? true : compiled.events[stepIndex] === true;

  if (event && compiled.degrades.length > 0) {
    const ctx = context ?? ZERO_CONTEXT;
    const idHash = hashPatternId(ctx.patternId);
    for (let gi = 0; gi < compiled.degrades.length; gi++) {
      const probability = compiled.degrades[gi]!;
      // Locked rule: sample < probability keeps the event (0 → never, 1 → always).
      const sample = patternRandom01(ctx.projectSeed, idHash, LANE_DEGRADE, cycle, stepIndex, gi);
      if (!(sample < probability)) return PATTERN_INACTIVE;
    }
  }

  return { active: true, value, stepIndex, cycleIndex: cycle, event };
}

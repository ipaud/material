import { deriveSeed, mulberry32Once } from '@/utils/prng';

/**
 * Pattern Engine P3 — deterministic probability sampling.
 *
 * Every probabilistic decision in a pattern derives from a stateless hash of
 * the event's identity — never from a mutable PRNG stream. There is no
 * cursor to advance, so evaluation order, seeks, reloads and export renders
 * all see the exact same sample for the same event.
 *
 * Sample key (in derivation order):
 *
 *   projectSeed → patternIdHash → lane → zigzagLo(cycle) → zigzagHi(cycle) → stepIndex → salt
 *
 * - `projectSeed`  — `project.explore.lastSeed ?? 1` (caller supplies it; the
 *   pure engine never reads stores).
 * - `patternIdHash` — FNV-1a of the stable pattern id. Isolates lanes across
 *   pattern instances under the same project seed.
 * - `lane` — semantic feature separation (see LANE_*). Adding a future
 *   random feature must not change Degrade outcomes.
 * - `cycleIndex/stepIndex` — the TRANSFORMED event coordinate (the cycle and
 *   presented step actually being evaluated). Zigzag maps signed cycles into
 *   unsigned space without pre-roll collisions; deriving BOTH 32-bit words
 *   keeps identities distinct across the float-exact range (|cycle| < 2^52).
 * - `salt` — sub-index within a lane (e.g. the position of a degrade gate in
 *   a chain with several).
 *
 * Deterministic space is uint32 per derivation step (deriveSeed semantics).
 *
 * Each derivation step is bit-exact with `deriveSeed` from utils/prng — the
 * local re-expression exists only because deriveSeed allocates a closure per
 * call (mulberry32) and this path runs per frame. Locked by test.
 */

/** Lane ids — reserved so future random features never shift Degrade. */
export const LANE_DEGRADE = 0;
/** v1.5 — MAYBE (probabilistic transform application). */
export const LANE_CHOICE = 1;
export const LANE_HUMANIZE = 2; // reserved (future)
/** v1.5 — per-cycle step permutation. */
export const LANE_SHUFFLE = 3;

/** FNV-1a — stable across platforms/reloads, no runtime salt. */
export function hashStringToUint32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ponytail: unbounded memo — pattern ids are few and stable; revisit if ids ever churn.
const patternIdHashCache = new Map<string, number>();

/** Memoized FNV-1a for pattern ids (hot path calls this per evaluation). */
export function hashPatternId(id: string): number {
  let h = patternIdHashCache.get(id);
  if (h === undefined) {
    h = hashStringToUint32(id);
    patternIdHashCache.set(id, h);
  }
  return h;
}

/**
 * Signed zigzag split into two uint32 words. Deriving BOTH words keeps cycle
 * identities collision-free across the whole float-exact integer range
 * (|cycle| < 2^52) — a single truncated word would collide every 2^31 cycles.
 */
function zigzagLo(n: number): number {
  return (n >= 0 ? n * 2 : -n * 2 - 1) >>> 0;
}
function zigzagHi(n: number): number {
  return Math.floor((n >= 0 ? n * 2 : -n * 2 - 1) / 4294967296) >>> 0;
}

/** Allocation-free equivalent of deriveSeed (bit-exact, test-locked). */
function derive(parent: number, lane: number): number {
  return Math.floor(mulberry32Once((parent ^ (lane * 0x9e3779b9)) >>> 0) * 0xffffffff) >>> 0;
}

/**
 * Deterministic [0,1) sample for one pattern event. Pure function of its
 * arguments — same key always yields the same sample.
 */
export function patternRandom01(
  projectSeed: number,
  patternIdHash: number,
  lane: number,
  cycleIndex: number,
  stepIndex: number,
  salt = 0,
): number {
  let s = projectSeed >>> 0;
  s = derive(s, patternIdHash);
  s = derive(s, lane);
  s = derive(s, zigzagLo(cycleIndex));
  s = derive(s, zigzagHi(cycleIndex));
  s = derive(s, stepIndex);
  s = derive(s, salt);
  return mulberry32Once(s);
}

/** Test seam: proves `derive` stays bit-exact with the sanctioned deriveSeed. */
export function deriveMatchesSanctioned(parent: number, lane: number): boolean {
  return derive(parent, lane) === deriveSeed(parent, lane);
}

/**
 * Deterministic Fisher–Yates permutation of [0..n) for one cycle. Pure
 * function of its key — same cycle, same deck order, forever. O(n) samples;
 * n is a step count (≤ a few dozen), so this stays far off any budget.
 */
export function patternPermutation(
  projectSeed: number,
  patternIdHash: number,
  cycleIndex: number,
  n: number,
): number[] {
  const perm = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const r = patternRandom01(projectSeed, patternIdHash, LANE_SHUFFLE, cycleIndex, i);
    const j = Math.floor(r * (i + 1));
    const tmp = perm[i] as number;
    perm[i] = perm[j] as number;
    perm[j] = tmp;
  }
  return perm;
}

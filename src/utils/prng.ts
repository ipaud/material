/**
 * Deterministic seeded PRNG (mulberry32). All randomness in MATERIAL that
 * affects visual output must flow through this so results are reproducible.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive a child seed from a parent seed and a lane index (stable, cheap). */
export function deriveSeed(parent: number, lane: number): number {
  const rng = mulberry32((parent ^ (lane * 0x9e3779b9)) >>> 0);
  return Math.floor(rng() * 0xffffffff) >>> 0;
}

/** Random seed for new explorations — the only place Math.random is allowed. */
export function freshSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

/**
 * One mulberry32 output for a seed, allocation-free (no closure). Bit-exact
 * with `mulberry32(seed)()` — locked by test. Hot paths (pattern probability)
 * use this so per-frame sampling allocates nothing.
 */
export function mulberry32Once(seed: number): number {
  const a = ((seed >>> 0) + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

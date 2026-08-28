/**
 * Euclidean rhythm mask via Bjorklund's algorithm.
 *
 * CANONICAL ORIENTATION (locked by tests): the first pulse sits on step 0
 * and remainders distribute front-loaded — the classic Bjorklund pairing.
 * Examples: E(3,8) = 10010010 · E(5,8) = 10110110. Any other orientation of
 * the same rhythm is expressed through `rotation`, never by the algorithm.
 *
 * Compile-time only — never runs per frame.
 */
export function euclideanMask(pulses: number, steps: number): boolean[] {
  if (steps < 1) return [];
  if (pulses <= 0) return new Array<boolean>(steps).fill(false);
  if (pulses >= steps) return new Array<boolean>(steps).fill(true);

  // Bjorklund: repeatedly pair the tail remainder into the head groups.
  let groups: boolean[][] = [];
  for (let i = 0; i < pulses; i++) groups.push([true]);
  let remainder: boolean[][] = [];
  for (let i = 0; i < steps - pulses; i++) remainder.push([false]);

  while (remainder.length > 1) {
    const pairs = Math.min(groups.length, remainder.length);
    const next: boolean[][] = [];
    for (let i = 0; i < pairs; i++)
      next.push([...(groups[i] as boolean[]), ...(remainder[i] as boolean[])]);
    const leftoverGroups = groups.slice(pairs);
    const leftoverRemainder = remainder.slice(pairs);
    groups = next;
    remainder = leftoverGroups.length > 0 ? leftoverGroups : leftoverRemainder;
    if (leftoverGroups.length > 0 && leftoverRemainder.length > 0) {
      // Both leftovers cannot coexist with pairs = min(...) — defensive only.
      remainder = [...leftoverGroups, ...leftoverRemainder];
    }
  }
  return [...groups, ...remainder].flat();
}

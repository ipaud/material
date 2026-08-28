import { deriveSeed } from '@/utils/prng';

/**
 * The MATERIAL mark is a 3×3 module grid with one module carrying the
 * signal. The signal's POSITION is the project's brand fingerprint:
 *
 *   position = deriveSeed(project.explore.lastSeed ?? 1, ICON_LANE) % 9
 *
 * Same project → same position, always — in the titlebar, in the Dock,
 * anywhere the mark appears. Deterministic like everything else the seed
 * drives (Explore mutations, Pattern probability), and derived through the
 * same sanctioned PRNG.
 *
 * The lane constant only namespaces this derivation away from other seed
 * consumers; changing it would change every project's fingerprint, so it is
 * as locked as the pattern goldens.
 */
export const ICON_LANE = 0x1c0;

export function iconPositionForSeed(seed: number): number {
  return deriveSeed(seed >>> 0, ICON_LANE) % 9;
}

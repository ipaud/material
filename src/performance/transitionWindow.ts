/**
 * CE1G — where a pixel transition lives inside a morph.
 *
 * The one rule that makes "snapshot A + live B" work: a cross-technique
 * morph SWITCHES identity at the instant the reveal opens, not at the
 * midpoint. The snapshot is taken immediately before that switch, so the
 * frame the switch would have popped is exactly the frame being held under
 * the mask — the pop becomes the reveal.
 *
 * Switching at 0.5 (the v0.3 point) with a reveal centred on 0.5 would be
 * worse than no transition at all: the mask is already half open when
 * identity flips, so half the frame pops anyway.
 *
 * Pure functions, shared verbatim by preview (morphRuntime) and export
 * (exportRunner) — one implementation, so the file cannot disagree with
 * what the user watched.
 */

/** Half-width of the reveal window in eased-progress space. */
export const REVEAL_HALF = 0.25;

/** Eased progress at which a cross-technique morph commits to the target. */
export function switchPoint(hasPixelTransition: boolean): number {
  return hasPixelTransition ? 0.5 - REVEAL_HALF : 0.5;
}

/**
 * Reveal progress (0..1) for an eased morph progress, or null when this
 * morph has no pixel reveal at all.
 *
 * Cross-technique: the reveal spans the window that starts at the identity
 * switch. Same-technique: there is no switch to cover, so the style owns
 * the whole morph.
 */
export function revealProgress(
  easedProgress: number,
  crossTechnique: boolean,
  hasPixelTransition: boolean,
): number | null {
  if (!hasPixelTransition) return null;
  if (!crossTechnique) return easedProgress;
  const start = switchPoint(true);
  const raw = (easedProgress - start) / (REVEAL_HALF * 2);
  return Math.min(Math.max(raw, 0), 1);
}

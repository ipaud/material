/**
 * Runtime liveness (v0.3 seam, Phase 18A).
 *
 * v0.2 held the macOS `prevent-app-suspension` blocker on a single boolean:
 * transport playing. v0.3 adds realtime requirements that exist without
 * transport (a live camera, an open output window), so liveness becomes a
 * refcounted set of REASONS:
 *
 *   runtimeIsLive = transportPlaying ∨ liveSourceActive ∨ outputWindowActive
 *
 * Pure reducer here; the main process owns the actual powerSaveBlocker.
 * An idle editor (no reasons) still naps normally.
 */

export const LIVENESS_REASONS = ['transport', 'live-source', 'output-window'] as const;
export type LivenessReason = (typeof LIVENESS_REASONS)[number];

export function isLivenessReason(value: unknown): value is LivenessReason {
  return (LIVENESS_REASONS as readonly string[]).includes(value as string);
}

/** Apply one reason toggle. Returns whether the blocker should be held. */
export function reduceLiveness(
  held: Set<LivenessReason>,
  reason: LivenessReason,
  active: boolean,
): boolean {
  if (active) held.add(reason);
  else held.delete(reason);
  return held.size > 0;
}

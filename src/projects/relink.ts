import type { MediaKind, MediaMetadata } from '@shared/schemas/media';

/**
 * v0.8 — finding a moved media file, without guessing.
 *
 * A project already stores enough to recognise its own media: `fileName`,
 * `fileSize`, `durationSec` and the kind all live in `MediaMetadata` and have
 * since v3. Nothing new has to be persisted; what was missing was a resolver
 * that uses them, so relinking a four-layer show is one folder pick instead of
 * five Finder dialogs.
 *
 * The discipline is the one the rest of the project follows: never silently
 * retarget. A candidate has to be clearly better than every other candidate,
 * or the file stays offline and says so.
 */

export interface MediaCandidate {
  path: string;
  fileName: string;
  fileSize: number;
  kind: MediaKind;
  /** Present only when cheap to know; matching never requires it. */
  durationSec?: number | null;
}

/**
 * How strongly a candidate looks like the file we lost.
 *
 * Name and size are independent evidence and both are cheap. Size alone is
 * strong — two different files sharing a byte count is a coincidence, the same
 * file renamed is not. Name alone is weaker but common, because re-encoding
 * keeps the name and changes the bytes.
 */
export function matchScore(wanted: MediaMetadata, candidate: MediaCandidate): number {
  if (candidate.kind !== wanted.kind) return 0;
  let score = 0;
  if (candidate.fileSize > 0 && candidate.fileSize === wanted.fileSize) score += 100;
  if (candidate.fileName === wanted.fileName) score += 60;
  if (
    candidate.durationSec != null &&
    wanted.durationSec != null &&
    Math.abs(candidate.durationSec - wanted.durationSec) < 0.05
  ) {
    score += 25;
  }
  return score;
}

/** Below this, the evidence is a coincidence rather than a match. */
export const MATCH_FLOOR = 60;

export type MatchResult =
  | { status: 'matched'; candidate: MediaCandidate; score: number }
  | { status: 'ambiguous'; candidates: MediaCandidate[]; score: number }
  | { status: 'none' };

/**
 * The one candidate that is clearly the file, or an honest refusal.
 *
 * A tie at the top is `ambiguous`, never a coin flip: two files in the folder
 * look equally like the one that went missing, and picking one would put the
 * wrong footage in a show without saying so.
 */
export function bestMatch(
  wanted: MediaMetadata,
  candidates: readonly MediaCandidate[],
): MatchResult {
  const scored = candidates
    .map((candidate) => ({ candidate, score: matchScore(wanted, candidate) }))
    .filter((s) => s.score >= MATCH_FLOOR)
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top) return { status: 'none' };
  const tied = scored.filter((s) => s.score === top.score);
  if (tied.length > 1) {
    return { status: 'ambiguous', candidates: tied.map((s) => s.candidate), score: top.score };
  }
  return { status: 'matched', candidate: top.candidate, score: top.score };
}

export interface RelinkPlan {
  /** Source id → the file it should point at. */
  resolved: Map<string, MediaCandidate>;
  /** Source ids whose match was ambiguous, with what tied. */
  ambiguous: Map<string, MediaCandidate[]>;
  /** Source ids nothing in the folder looked like. */
  unresolved: string[];
}

/**
 * Plan a whole relink before touching the project.
 *
 * Two offline sources can want the same file — the same clip imported twice
 * under different ids — and that is fine; a file may satisfy more than one.
 * What is not fine is one source having two equally good answers.
 */
export function planRelink(
  offline: readonly { id: string; metadata: MediaMetadata | null }[],
  candidates: readonly MediaCandidate[],
): RelinkPlan {
  const resolved = new Map<string, MediaCandidate>();
  const ambiguous = new Map<string, MediaCandidate[]>();
  const unresolved: string[] = [];
  for (const source of offline) {
    if (!source.metadata) {
      // Nothing was ever recorded about this file, so there is nothing to
      // recognise it by. A dialog is the only honest answer.
      unresolved.push(source.id);
      continue;
    }
    const match = bestMatch(source.metadata, candidates);
    if (match.status === 'matched') resolved.set(source.id, match.candidate);
    else if (match.status === 'ambiguous') ambiguous.set(source.id, match.candidates);
    else unresolved.push(source.id);
  }
  return { resolved, ambiguous, unresolved };
}

import type { TimelineMarker } from '@shared/schemas/project';
import { uid } from '@/utils/id';
import type { ImportedMarker } from './markerImport';

/** The onset closest to `timeSec`, if one lies within `maxDistSec`. */
export function snapToOnset(timeSec: number, onsets: Float32Array, maxDistSec = 0.25): number | null {
  let best: number | null = null;
  let bestDist = maxDistSec;
  for (let i = 0; i < onsets.length; i++) {
    const t = onsets[i] as number;
    const d = Math.abs(t - timeSec);
    if (d <= bestDist) {
      best = t;
      bestDist = d;
    }
    if (t > timeSec + maxDistSec) break;
  }
  return best === null ? null : Math.round(best * 1000) / 1000;
}

const SAME_INSTANT_SEC = 0.02;

/** Add imported markers, skipping one that lands on an existing marker with the same label. */
export function mergeMarkers(
  existing: readonly TimelineMarker[],
  imported: readonly ImportedMarker[],
): { markers: TimelineMarker[]; added: number } {
  const out = [...existing];
  let added = 0;
  for (const m of imported) {
    const duplicate = out.some(
      (e) => e.label === m.label && Math.abs(e.timeSec - m.timeSec) <= SAME_INSTANT_SEC,
    );
    if (duplicate) continue;
    out.push({
      id: uid('mk'),
      timeSec: m.timeSec,
      label: m.label.slice(0, 40),
      ...(m.group ? { group: m.group.slice(0, 40) } : {}),
    });
    added++;
  }
  return { markers: out.sort((a, b) => a.timeSec - b.timeSec), added };
}

import { onsetEventTimes } from '@/signals/triggerSources';
import { useAudioStore } from '@/state/audioStore';
import { useProjectStore } from '@/state/projectStore';
import { parseMarkers, type ParseOptions } from './markerImport';
import { mergeMarkers, snapToOnset } from './markerMath';

function setMarkers(update: (m: ReturnType<typeof current>) => ReturnType<typeof current>): void {
  useProjectStore.getState().apply((p) => ({
    ...p,
    timeline: { ...p.timeline, markers: update(p.timeline.markers) },
  }));
}
const current = () => useProjectStore.getState().project.timeline.markers;

/** Parse a CSV / EDL / FCPXML file's text and merge it in, as one undo step. */
export function importMarkers(
  text: string,
  options: ParseOptions,
): { added: number; skipped: number } {
  const imported = parseMarkers(text, options);
  const merged = mergeMarkers(current(), imported);
  setMarkers(() => merged.markers);
  return { added: merged.added, skipped: imported.length - merged.added };
}

/** One marker per detected onset at `threshold` (0–1). Returns how many were added. */
export function addOnsetMarkers(threshold: number): number {
  const { analysis } = useAudioStore.getState();
  if (!analysis) throw new Error('Load an audio source first');
  const onsets = Array.from(onsetEventTimes(analysis, threshold), (t) => ({
    timeSec: Math.round(t * 1000) / 1000,
    label: 'onset',
    group: 'onset',
  }));
  const merged = mergeMarkers(current(), onsets);
  setMarkers(() => merged.markers);
  return merged.added;
}

export function snapMarkerToOnset(markerId: string, maxDistSec = 0.25): boolean {
  const { analysis } = useAudioStore.getState();
  const marker = current().find((m) => m.id === markerId);
  if (!analysis || !marker) return false;
  const snapped = snapToOnset(marker.timeSec, onsetEventTimes(analysis), maxDistSec);
  if (snapped === null || snapped === marker.timeSec) return false;
  setMarkers((all) =>
    all.map((m) => (m.id === markerId ? { ...m, timeSec: snapped } : m)).sort((a, b) => a.timeSec - b.timeSec),
  );
  return true;
}

/** Snap every marker that has an onset within reach. Returns how many moved. */
export function snapAllMarkersToOnsets(maxDistSec = 0.25): number {
  const { analysis } = useAudioStore.getState();
  if (!analysis) return 0;
  const onsets = onsetEventTimes(analysis);
  let moved = 0;
  setMarkers((all) =>
    all
      .map((m) => {
        const snapped = snapToOnset(m.timeSec, onsets, maxDistSec);
        if (snapped === null || snapped === m.timeSec) return m;
        moved++;
        return { ...m, timeSec: snapped };
      })
      .sort((a, b) => a.timeSec - b.timeSec),
  );
  return moved;
}

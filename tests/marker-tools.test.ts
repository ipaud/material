import { beforeEach, describe, expect, it } from 'vitest';
import { TRACK_IDS, type AudioAnalysis } from '@/audio/analysis';
import { eventTimesBetween, onsetEventTimes, type TriggerContext } from '@/signals/triggerSources';
import {
  addOnsetMarkers,
  importMarkers,
  snapAllMarkersToOnsets,
  snapMarkerToOnset,
} from '@/timeline/markerActions';
import { mergeMarkers, snapToOnset } from '@/timeline/markerMath';
import { useAudioStore } from '@/state/audioStore';
import { useProjectStore } from '@/state/projectStore';

const HOP = 0.01;

/** Onset track with peaks of the given heights at the given seconds. */
function analysis(peaks: Array<[number, number]>): AudioAnalysis {
  const frames = 1000;
  const tracks = Object.fromEntries(TRACK_IDS.map((id) => [id, new Float32Array(frames)])) as AudioAnalysis['tracks'];
  for (const [t, v] of peaks) tracks.onset[Math.round(t / HOP)] = v;
  return { sampleRate: 44100, hopSec: HOP, frameCount: frames, durationSec: frames * HOP, tracks };
}

const A = analysis([[1, 0.9], [2, 0.5], [3, 0.35], [4, 0.8]]);

describe('onsets with an adjustable threshold', () => {
  it('a higher threshold keeps only the stronger hits; the default is unchanged', () => {
    expect(Array.from(onsetEventTimes(A)).map((t) => Math.round(t))).toEqual([1, 2, 3, 4]);
    expect(Array.from(onsetEventTimes(A, 0.6)).map((t) => Math.round(t))).toEqual([1, 4]);
    expect(Array.from(onsetEventTimes(A, 0.95))).toEqual([]);
  });
});

describe('marker groups as a trigger source', () => {
  const ctx = (markers: TriggerContext['markers']): TriggerContext => ({
    bpm: null, beatOffsetSec: 0, beatsPerBar: 4, analysis: null, markers,
  });
  it('group:<name> fires for every marker in the group (by group, else by label)', () => {
    const markers = [
      { id: 'a', timeSec: 1, label: 'Kick', group: 'drums' },
      { id: 'b', timeSec: 2, label: 'Snare', group: 'drums' },
      { id: 'c', timeSec: 3, label: 'Vox' },
      { id: 'd', timeSec: 4, label: 'Vox' },
    ];
    expect(eventTimesBetween('group:drums', 0, 10, ctx(markers))).toEqual([1, 2]);
    expect(eventTimesBetween('group:Vox', 0, 10, ctx(markers))).toEqual([3, 4]);
    expect(eventTimesBetween('group:none', 0, 10, ctx(markers))).toEqual([]);
  });
});

describe('snapToOnset / mergeMarkers', () => {
  it('snaps to the nearest onset within reach, else null', () => {
    const onsets = Float32Array.from([1, 2.1, 4]);
    expect(snapToOnset(1.9, onsets, 0.25)).toBeCloseTo(2.1, 6);
    expect(snapToOnset(3, onsets, 0.25)).toBeNull();
  });
  it('merge skips an import that lands on an existing marker of the same label', () => {
    const existing = [{ id: 'x', timeSec: 1, label: 'Kick' }];
    const r = mergeMarkers(existing, [
      { timeSec: 1.005, label: 'Kick' },
      { timeSec: 2, label: 'Kick' },
    ]);
    expect(r.added).toBe(1);
    expect(r.markers.map((m) => m.timeSec)).toEqual([1, 2]);
  });
});

describe('marker actions on the project', () => {
  beforeEach(() => {
    useProjectStore.getState().newProject();
    useAudioStore.setState({ analysis: A });
  });
  const markers = () => useProjectStore.getState().project.timeline.markers;

  it('importMarkers reads a CSV into the timeline in one undo step', () => {
    const r = importMarkers('1,Kick,drums\n2,Snare,drums', { fps: 25 });
    expect(r).toEqual({ added: 2, skipped: 0 });
    expect(markers().map((m) => m.group)).toEqual(['drums', 'drums']);
    useProjectStore.getState().undo();
    expect(markers()).toHaveLength(0);
  });

  it('addOnsetMarkers uses the chosen threshold', () => {
    expect(addOnsetMarkers(0.6)).toBe(2);
    expect(markers().map((m) => Math.round(m.timeSec))).toEqual([1, 4]);
  });

  it('snaps one marker or all of them to the nearest onset', () => {
    importMarkers('1.1,a\n3.9,b\n7,c', { fps: 25 });
    const [a] = markers();
    snapMarkerToOnset(a!.id);
    expect(markers()[0]!.timeSec).toBeCloseTo(1, 2);
    expect(snapAllMarkersToOnsets()).toBe(1); // b moves; c has no onset within reach; a already there
    expect(markers().map((m) => Math.round(m.timeSec * 10) / 10)).toEqual([1, 4, 7]);
  });
});

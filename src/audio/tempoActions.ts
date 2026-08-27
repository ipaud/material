import { useProjectStore } from '@/state/projectStore';
import { useAudioStore } from '@/state/audioStore';
import { useUiStore } from '@/state/uiStore';
import { detectTempo } from './tempo';
import { TapTempo, offsetFromTap } from './tapTempo';
import { playback } from '@/playback/PlaybackController';

/**
 * Detection is advisory: it fills the same fields the user can type over.
 * Nothing here runs automatically — only from the DETECT button.
 */
export function runTempoDetection(): void {
  const { analysis } = useAudioStore.getState();
  if (!analysis) {
    useUiStore.getState().pushToast('info', 'Load an audio source first');
    return;
  }
  const estimate = detectTempo(analysis);
  if (!estimate) {
    useUiStore.getState().pushToast('error', 'Tempo detection failed — set BPM manually');
    return;
  }
  useProjectStore.getState().apply((p) => ({
    ...p,
    timeline: {
      ...p.timeline,
      bpm: estimate.bpm,
      beatOffsetSec: estimate.beatOffsetSec,
    },
  }));
  const pct = Math.round(estimate.confidence * 100);
  const alt = estimate.alternativeBpm ? ` (or ${estimate.alternativeBpm} — half/double time)` : '';
  useUiStore
    .getState()
    .pushToast('info', `Detected ${estimate.bpm} BPM · confidence ${pct}%${alt}`);
}

const tapper = new TapTempo();

/** Tap tempo: BPM from the median tap interval, grid aligned to the tap. */
export function tapTempoTap(): void {
  const result = tapper.tap(performance.now());
  if (!result) return;
  const playbackTime = playback.getTime();
  useProjectStore.getState().apply((p) => ({
    ...p,
    timeline: {
      ...p.timeline,
      bpm: result.bpm,
      beatOffsetSec: offsetFromTap(playbackTime, result.bpm),
    },
  }));
}

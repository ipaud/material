import { engine } from '@/rendering/RenderEngine';
import { playback } from '@/playback/PlaybackController';
import { useProjectStore } from '@/state/projectStore';
import { useAudioStore } from '@/state/audioStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useExportStore } from '@/state/exportStore';
import { reportError, useUiStore } from '@/state/uiStore';
import { getTechnique } from '@/techniques/registry';
import { evalSources, type SourceContext } from '@/modulation/sources';
import { applyModulations, SmoothingState } from '@/modulation/evaluator';
import type { ParamRecord } from '@shared/schemas/project';
import type { ExportFormat } from '@shared/ipc';

export interface AnimationExportRequest {
  format: ExportFormat;
  width: number;
  height: number;
  fps: number;
  startSec: number;
  durationSec: number;
  outPath: string;
  includeAudio: boolean;
  alpha?: boolean;
}

/**
 * Deterministic per-frame parameter evaluation for export (§33/§63):
 * frameTime = start + i/fps; a FRESH smoothing state stepped with fixed
 * dt = 1/fps. The same function drives the determinism verification.
 */
export function createFrameEvaluator(startSec: number, fps: number) {
  const { project } = useProjectStore.getState();
  const instance = project.techniques.find((t) => t.enabled) ?? null;
  const definition = instance ? getTechnique(instance.techniqueId) : null;
  const base: ParamRecord = instance?.params ?? {};
  const mappings = project.modulations;
  const sourceCtx: SourceContext = {
    analysis: useAudioStore.getState().analysis,
    durationSec: usePlaybackStore.getState().durationSec,
    bpm: project.timeline.bpm,
    beatOffsetSec: project.timeline.beatOffsetSec,
  };
  const smoothing = new SmoothingState();
  const dt = 1 / fps;

  return (frameIndex: number): { timeSec: number; params: ParamRecord } => {
    const timeSec = startSec + frameIndex / fps;
    if (!definition) return { timeSec, params: base };
    const sources = evalSources(timeSec, sourceCtx);
    return {
      timeSec,
      params: applyModulations(base, mappings, sources, definition, smoothing, dt),
    };
  };
}

function seekVideoExact(video: HTMLVideoElement, timeSec: number): Promise<void> {
  const target = Math.min(Math.max(timeSec, 0), Math.max(video.duration - 0.001, 0));
  if (Math.abs(video.currentTime - target) < 0.0005) return Promise.resolve();
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = target;
  });
}

export async function runAnimationExport(request: AnimationExportRequest): Promise<void> {
  const store = useExportStore.getState();
  const totalFrames = Math.max(Math.ceil(request.durationSec * request.fps), 1);
  const { project } = useProjectStore.getState();
  const alpha = request.alpha === true;
  const audioPath =
    request.includeAudio && request.format !== 'png-sequence'
      ? (project.sources.find((s) => s.id === project.composition.audioSourceId)?.path ?? null)
      : null;

  playback.pause();
  const video = playback.currentVideo;

  store.begin(totalFrames);
  let sessionId: string | null = null;
  try {
    const started = await window.material.exportStart({
      format: request.format,
      width: request.width,
      height: request.height,
      fps: request.fps,
      outPath: request.outPath,
      alpha,
      audioPath,
      audioStartSec: request.startSec,
      durationSec: request.durationSec,
    });
    sessionId = started.sessionId;
    const evaluate = createFrameEvaluator(request.startSec, request.fps);

    for (let i = 0; i < totalFrames; i++) {
      if (useExportStore.getState().cancelRequested) {
        await window.material.exportCancel(sessionId);
        engine.endExportMode();
        store.finish('cancelled', 'Export cancelled');
        return;
      }
      const { timeSec, params } = evaluate(i);
      // Temporal history is rebuilt from exact composition timestamps —
      // the first frame primes the whole buffer, later frames advance it (§3).
      if (engine.isTemporalActive) {
        await engine.prepareTemporalForExport(timeSec, i === 0);
      }
      if (video) await seekVideoExact(video, timeSec);
      const rgba = engine.renderStill(request.width, request.height, params, alpha);
      await window.material.exportFrame(sessionId, rgba);
      store.setProgress(i + 1);
    }
    engine.endExportMode();

    const { outPath } = await window.material.exportFinish(sessionId);
    store.finish('done', outPath);
    useUiStore.getState().pushToast('info', `Exported ${outPath.split('/').pop()}`);
  } catch (err) {
    engine.endExportMode();
    if (sessionId) {
      try {
        await window.material.exportCancel(sessionId);
      } catch {
        /* already gone */
      }
    }
    store.finish('error', err instanceof Error ? err.message : String(err));
    reportError('Export', err);
  }
}

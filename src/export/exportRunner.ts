import { engine } from '@/rendering/RenderEngine';
import { playback } from '@/playback/PlaybackController';
import { useProjectStore } from '@/state/projectStore';
import { useAudioStore } from '@/state/audioStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useExportStore } from '@/state/exportStore';
import { reportError, useUiStore } from '@/state/uiStore';
import { getTechnique } from '@/techniques/registry';
import { allParams } from '@/techniques/types';
import { evalSources, type SourceContext } from '@/modulation/sources';
import { applyModulations, SmoothingState, shapeMappingValue } from '@/modulation/evaluator';
import { applyPulses } from '@/signals/pulseEngine';
import { TriggerScheduler, type ActionTarget } from '@/signals/scheduler';
import type { TriggerContext } from '@/signals/triggerSources';
import type { ModulationMapping, ParamRecord, PinnedLook } from '@shared/schemas/project';
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
 *
 * Discrete trigger actions from DETERMINISTIC sources (beat/bar/onset/
 * marker) are replayed against a WORKING COPY of the project — freezes and
 * look switches mutate the copy, never the live store. Live-class sources
 * (manual/keyboard/MIDI) are absent from export by design; see
 * docs/PARAMETER_EVALUATION.md.
 */
export function createFrameEvaluator(startSec: number, fps: number) {
  const { project } = useProjectStore.getState();
  const analysis = useAudioStore.getState().analysis;

  // Mutable working copy — trigger actions operate on this, not the store.
  const working: {
    techniqueId: string | null;
    params: ParamRecord;
    modulations: ModulationMapping[];
    looks: PinnedLook[];
    lookIndex: number;
  } = {
    techniqueId: project.techniques.find((t) => t.enabled)?.techniqueId ?? null,
    params: { ...(project.techniques.find((t) => t.enabled)?.params ?? {}) },
    modulations: project.modulations.map((m) => ({ ...m })),
    looks: project.pinnedLooks,
    lookIndex: -1,
  };

  const sourceCtx: SourceContext = {
    analysis,
    durationSec: usePlaybackStore.getState().durationSec,
    bpm: project.timeline.bpm,
    beatOffsetSec: project.timeline.beatOffsetSec,
    beatsPerBar: project.timeline.beatsPerBar,
  };
  const triggerCtx: TriggerContext = {
    bpm: project.timeline.bpm,
    beatOffsetSec: project.timeline.beatOffsetSec,
    beatsPerBar: project.timeline.beatsPerBar,
    analysis,
    markers: project.timeline.markers,
  };
  const smoothing = new SmoothingState();
  const dt = 1 / fps;
  let lastSources: Record<string, number> = {};

  const applyLookToWorking = (look: PinnedLook | undefined) => {
    if (!look) return;
    const active = look.techniques.find((t) => t.enabled);
    if (active) {
      working.techniqueId = active.techniqueId;
      working.params = { ...active.params };
    }
    working.modulations = look.modulations.map((m) => ({ ...m }));
  };

  const virtualTarget: ActionTarget = {
    freeze: (mappingId) => {
      for (const m of working.modulations) {
        if (mappingId && mappingId !== '*' && m.id !== mappingId) continue;
        m.frozenValue = shapeMappingValue(m, lastSources, smoothing, 0);
      }
    },
    unfreeze: (mappingId) => {
      for (const m of working.modulations) {
        if (mappingId && mappingId !== '*' && m.id !== mappingId) continue;
        m.frozenValue = null;
      }
    },
    toggleFreeze: (mappingId) => {
      for (const m of working.modulations) {
        if (mappingId && mappingId !== '*' && m.id !== mappingId) continue;
        m.frozenValue = m.frozenValue === null ? shapeMappingValue(m, lastSources, smoothing, 0) : null;
      }
    },
    pinLook: () => undefined, // pinning mutates the project; no-op in export replay
    applyLook: (slot) => {
      working.lookIndex = slot - 1;
      applyLookToWorking(working.looks[slot - 1]);
    },
    nextLook: () => {
      if (working.looks.length === 0) return;
      working.lookIndex = (working.lookIndex + 1) % working.looks.length;
      applyLookToWorking(working.looks[working.lookIndex]);
    },
    prevLook: () => {
      if (working.looks.length === 0) return;
      working.lookIndex = (working.lookIndex - 1 + working.looks.length) % working.looks.length;
      applyLookToWorking(working.looks[working.lookIndex]);
    },
    resetParam: (paramId) => {
      const definition = working.techniqueId ? getTechnique(working.techniqueId) : null;
      const def = definition ? allParams(definition).find((d) => d.id === paramId) : null;
      if (def) working.params = { ...working.params, [paramId]: def.default };
    },
    toggleMapping: (mappingId) => {
      for (const m of working.modulations) {
        if (m.id === mappingId) m.enabled = !m.enabled;
      }
    },
  };
  const scheduler = new TriggerScheduler(virtualTarget);
  scheduler.reset(startSec);

  return (frameIndex: number): { timeSec: number; params: ParamRecord } => {
    const timeSec = startSec + frameIndex / fps;
    scheduler.advanceTo(timeSec, project.triggers, triggerCtx);
    const definition = working.techniqueId ? getTechnique(working.techniqueId) : null;
    if (!definition) return { timeSec, params: working.params };
    const sources = evalSources(timeSec, sourceCtx);
    lastSources = sources;
    const modulated = applyModulations(
      working.params,
      working.modulations,
      sources,
      definition,
      smoothing,
      dt,
    );
    return {
      timeSec,
      params: applyPulses(modulated, project.triggers, timeSec, triggerCtx, definition),
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

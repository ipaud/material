import { engine } from '@/rendering/RenderEngine';
import { playback } from '@/playback/PlaybackController';
import { useProjectStore } from '@/state/projectStore';
import { useAudioStore } from '@/state/audioStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { useExportStore } from '@/state/exportStore';
import { reportError, useUiStore } from '@/state/uiStore';
import { getTechnique, techniqueNeedsTemporal } from '@/techniques/registry';
import { allParams, type TechniqueRenderer } from '@/techniques/types';
import { evalSources, type SourceContext } from '@/modulation/sources';
import { resolvePatternHandles } from '@/pattern/patternSourceRuntime';
import { applyModulations, SmoothingState, shapeMappingValue } from '@/modulation/evaluator';
import { applyPulses } from '@/signals/pulseEngine';
import { TriggerScheduler, type ActionTarget } from '@/signals/scheduler';
import type { TriggerContext } from '@/signals/triggerSources';
import { interpolateLookCore, morphCurve } from '@/performance/interpolate';
import { lookToCore } from '@/performance/lookCore';
import { applyMacros } from '@/performance/macros';
import { isFileSource } from '@shared/schemas/project';
import type {
  LookCore,
  ModulationMapping,
  MorphCurve,
  ParamRecord,
  PinnedLook,
  Project,
  TriggerMapping,
} from '@shared/schemas/project';
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
    material: Project['material'];
    modulations: ModulationMapping[];
    triggers: TriggerMapping[];
    seed: number;
    looks: PinnedLook[];
    lookIndex: number;
  } = {
    techniqueId: project.techniques.find((t) => t.enabled)?.techniqueId ?? null,
    params: { ...(project.techniques.find((t) => t.enabled)?.params ?? {}) },
    material: project.material,
    modulations: project.modulations.map((m) => ({ ...m })),
    triggers: project.triggers.map((t) => ({ ...t })),
    seed: project.explore.lastSeed ?? 1,
    looks: project.pinnedLooks,
    lookIndex: -1,
  };

  const sourceCtx: SourceContext = {
    analysis,
    durationSec: usePlaybackStore.getState().durationSec,
    bpm: project.timeline.bpm,
    beatOffsetSec: project.timeline.beatOffsetSec,
    beatsPerBar: project.timeline.beatsPerBar,
    // P4: same handles/seed path as preview — no export-only pattern code.
    patterns: resolvePatternHandles(project.patternSources),
    projectSeed: working.seed,
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

  // Morph replay: recorded events + trigger-launched virtual morphs share one
  // list. Each is applied to the working copy exactly once when its end
  // passes; while inside its interval the interpolated core overrides the
  // working state (same interpolation function as preview).
  interface VirtualMorph {
    startTime: number;
    endTime: number;
    curve: MorphCurve;
    source: LookCore;
    target: LookCore;
    applied: boolean;
  }
  const lookById = new Map(project.pinnedLooks.map((l) => [l.id, l]));
  const virtualMorphs: VirtualMorph[] = project.morphEvents
    .filter((e) => lookById.has(e.targetLookId))
    .map((e) => ({
      startTime: e.startTime,
      endTime: e.endTime,
      curve: e.curve,
      source: e.sourceSnapshot,
      target: lookToCore(lookById.get(e.targetLookId) as PinnedLook),
      applied: false,
    }));

  const workingCore = (): LookCore => ({
    techniqueId: working.techniqueId ?? 'mosaic',
    params: { ...working.params },
    material: working.material,
    modulations: working.modulations.map((m) => ({ ...m })),
    triggers: working.triggers.map((t) => ({ ...t })),
    seed: working.seed,
  });

  const applyCoreToWorking = (core: LookCore) => {
    working.techniqueId = core.techniqueId;
    working.params = { ...core.params };
    working.material = core.material;
    working.modulations = core.modulations.map((m) => ({ ...m }));
    working.triggers = core.triggers.map((t) => ({ ...t }));
    working.seed = core.seed;
  };

  const applyLookToWorking = (look: PinnedLook | undefined) => {
    if (!look) return;
    applyCoreToWorking(lookToCore(look));
  };

  // Recorded morph events tell the timeline's story: before the earliest
  // recorded morph the composition was in that morph's sourceSnapshot, not in
  // the document's final state. (Between two recorded morphs the previous
  // target holds; manual edits made live between them have no recorded
  // timing, so the next morph interpolates from its own snapshot.)
  if (virtualMorphs.length > 0) {
    const earliest = [...virtualMorphs].sort((a, b) => a.startTime - b.startTime)[0];
    if (earliest) applyCoreToWorking(earliest.source);
  }

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
        m.frozenValue =
          m.frozenValue === null ? shapeMappingValue(m, lastSources, smoothing, 0) : null;
      }
    },
    pinLook: () => undefined, // pinning mutates the project; no-op in export replay
    applyLook: (slot) => {
      const look = working.looks.find((l) => l.slot === slot);
      if (!look) return;
      working.lookIndex = working.looks.indexOf(look);
      applyLookToWorking(look);
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
    // An un-applied CANDIDATE is live-only and can never reach a render.
    applyCandidate: () => undefined,
    morphToLook: (slot, atTime) => {
      const look = project.pinnedLooks.find((l) => l.slot === slot);
      if (!look) return;
      const { bpm, beatsPerBar } = project.timeline;
      const barSec = bpm && bpm > 0 ? (60 / bpm) * beatsPerBar : 2;
      virtualMorphs.push({
        startTime: atTime,
        endTime: atTime + barSec,
        curve: 'easeInOut',
        source: workingCore(),
        target: lookToCore(look),
        applied: false,
      });
    },
  };
  const scheduler = new TriggerScheduler(virtualTarget);
  scheduler.reset(startSec);

  return (
    frameIndex: number,
  ): { timeSec: number; params: ParamRecord; techniqueId: string | null } => {
    const timeSec = startSec + frameIndex / fps;
    scheduler.advanceTo(timeSec, working.triggers, triggerCtx);

    // Morph replay: commit completed morphs (in time order), then resolve any
    // interval that covers this frame into an interpolated overlay core.
    virtualMorphs.sort((a, b) => a.startTime - b.startTime);
    let overlay: LookCore | null = null;
    for (const vm of virtualMorphs) {
      if (!vm.applied && timeSec >= vm.endTime) {
        applyCoreToWorking(vm.target);
        vm.applied = true;
      } else if (timeSec >= vm.startTime && timeSec < vm.endTime) {
        const raw = (timeSec - vm.startTime) / Math.max(vm.endTime - vm.startTime, 1e-6);
        overlay = interpolateLookCore(vm.source, vm.target, morphCurve(raw, vm.curve)).core;
      }
    }

    const techniqueId = overlay?.techniqueId ?? working.techniqueId;
    const definition = techniqueId ? getTechnique(techniqueId) : null;
    if (!definition) return { timeSec, params: working.params, techniqueId };
    // A replayed look apply can change the working seed mid-export; live
    // preview reconfigures its context on the same store change, so mirror
    // it here for exact parity.
    sourceCtx.projectSeed = working.seed;
    const sources = evalSources(timeSec, sourceCtx);
    lastSources = sources;
    // Macro values are project state (deterministic snapshot); live macro
    // MOVEMENT is not recorded and cannot appear here (§41).
    const baseParams = applyMacros(
      overlay ? overlay.params : working.params,
      project.macros,
      definition,
    );
    const mappings = overlay ? overlay.modulations : working.modulations;
    const activeTriggers = overlay ? overlay.triggers : working.triggers;
    const modulated = applyModulations(baseParams, mappings, sources, definition, smoothing, dt);
    return {
      timeSec,
      params: applyPulses(modulated, activeTriggers, timeSec, triggerCtx, definition),
      techniqueId,
    };
  };
}

/**
 * Export-side technique renderer selection (pre-v0.3 hotfix).
 *
 * The evaluator's working copy switches techniqueId when a morph crosses a
 * technique boundary, but the engine kept whatever renderer the live bridge
 * installed before the export began — frames after the boundary rendered the
 * OLD technique with the NEW technique's params. This seam keeps the engine's
 * renderer in lockstep with the evaluated frame state, entirely inside the
 * export context: the live editor's authority (stores, bridge) is untouched,
 * and restore() puts the engine back exactly as the bridge expects.
 *
 * The host is the minimal engine surface, so the switching rules are unit
 * testable without WebGL.
 */
export interface ExportRendererHost {
  setTechniqueRenderer(renderer: TechniqueRenderer | null): void;
  setTemporalEnabled(enabled: boolean): void;
  readonly isTemporalActive: boolean;
}

export function createExportRendererSync(
  host: ExportRendererHost,
  initialTechniqueId: string | null,
) {
  let activeId = initialTechniqueId;
  let switched = false;

  return {
    /**
     * Align the renderer with the evaluated frame. Returns true when the
     * temporal buffer became active and must be re-primed from exact seeks
     * (switching INTO a temporal technique mid-export).
     */
    sync(techniqueId: string | null, params: ParamRecord): boolean {
      if (!techniqueId || techniqueId === activeId) return false;
      const definition = getTechnique(techniqueId);
      if (!definition) return false;
      const wasTemporal = host.isTemporalActive;
      // setTechniqueRenderer disposes the previous renderer (including the
      // bridge's pre-export one — restore() rebuilds it afterwards).
      host.setTechniqueRenderer(definition.createRenderer());
      host.setTemporalEnabled(techniqueNeedsTemporal(techniqueId, params));
      activeId = techniqueId;
      switched = true;
      return host.isTemporalActive && !wasTemporal;
    },

    /** Rebuild the live technique's renderer so the editor resumes untouched. */
    restore(liveTechniqueId: string | null, liveParams: ParamRecord): void {
      if (!switched) return;
      const definition = liveTechniqueId ? getTechnique(liveTechniqueId) : null;
      host.setTechniqueRenderer(definition ? definition.createRenderer() : null);
      host.setTemporalEnabled(
        liveTechniqueId ? techniqueNeedsTemporal(liveTechniqueId, liveParams) : false,
      );
      switched = false;
      activeId = liveTechniqueId;
    },
  };
}

/**
 * Seek and WAIT until the frame at `timeSec` is actually available to the
 * GPU texture.
 *
 * Two waits are needed, and missing either one produces silently wrong
 * export frames:
 *
 * 1. `seeked` — the element has moved to the requested time. Alone this is
 *    not enough: it says the seek finished, not that a decoded frame has
 *    been presented. Rendering here uploads whichever frame the texture
 *    still held, which made ~20% of frames in a non-temporal export differ
 *    between two runs of the same project (measured 11–16 dB PSNR — a whole
 *    different image, not codec noise).
 * 2. `requestVideoFrameCallback` — a new frame has been composited and is
 *    safe to sample. This is the signal that makes non-temporal exports
 *    reproducible.
 *
 * `force` performs a real seek even at the same position, guaranteeing a
 * fresh decode for the first export frame (a project that just opened has no
 * decoded data at all).
 */
async function seekVideoExact(
  video: HTMLVideoElement,
  timeSec: number,
  force = false,
): Promise<void> {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await new Promise<void>((resolve) => {
      const onReady = () => {
        video.removeEventListener('loadeddata', onReady);
        resolve();
      };
      video.addEventListener('loadeddata', onReady);
    });
  }
  const target = Math.min(Math.max(timeSec, 0), Math.max(video.duration - 0.001, 0));
  const alreadyThere = !force && Math.abs(video.currentTime - target) < 0.0005;
  if (!alreadyThere) {
    await new Promise<void>((resolve) => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        resolve();
      };
      video.addEventListener('seeked', onSeeked);
      // A same-position forced seek needs a nudge or 'seeked' may never fire.
      video.currentTime = Math.abs(video.currentTime - target) < 1e-6 ? target + 1e-4 : target;
    });
  }
  await waitForPresentedFrame(video);
}

/**
 * Resolve once the element has presented a decoded frame. Falls back to a
 * short timeout so an element without `requestVideoFrameCallback` (or one
 * that never presents, e.g. a still-frame end of stream) cannot stall an
 * export.
 */
function waitForPresentedFrame(video: HTMLVideoElement): Promise<void> {
  const withCallback = video as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number;
  };
  if (typeof withCallback.requestVideoFrameCallback !== 'function') {
    return new Promise((resolve) => setTimeout(resolve, 8));
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    withCallback.requestVideoFrameCallback!(done);
    setTimeout(done, 60);
  });
}

export async function runAnimationExport(request: AnimationExportRequest): Promise<void> {
  const store = useExportStore.getState();
  const totalFrames = Math.max(Math.ceil(request.durationSec * request.fps), 1);
  const { project } = useProjectStore.getState();
  const alpha = request.alpha === true;
  const audioPath =
    request.includeAudio && request.format !== 'png-sequence'
      ? (project.sources
          .filter(isFileSource)
          .find((s) => s.id === project.composition.audioSourceId)?.path ?? null)
      : null;

  playback.pause();
  engine.beginExportMode();
  const video = playback.currentVideo;
  const liveInstance = project.techniques.find((t) => t.enabled) ?? null;
  const rendererSync = createExportRendererSync(engine, liveInstance?.techniqueId ?? null);

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
    let primeTemporal = true;

    for (let i = 0; i < totalFrames; i++) {
      if (useExportStore.getState().cancelRequested) {
        await window.material.exportCancel(sessionId);
        engine.endExportMode();
        store.finish('cancelled', 'Export cancelled');
        return;
      }
      const { timeSec, params, techniqueId } = evaluate(i);
      // Cross-technique morph: the renderer must match the evaluated frame's
      // technique before drawing it (see createExportRendererSync).
      if (rendererSync.sync(techniqueId, params)) primeTemporal = true;
      // Temporal history is rebuilt from exact composition timestamps —
      // the first temporal frame primes the whole buffer, later frames
      // advance it (§3). A switch INTO a temporal technique re-primes.
      if (engine.isTemporalActive) {
        await engine.prepareTemporalForExport(timeSec, primeTemporal);
        primeTemporal = false;
      }
      if (video) await seekVideoExact(video, timeSec, i === 0);
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
  } finally {
    // Rebuild the live technique's renderer if the export switched away from
    // it; the store/bridge were never touched, so this is the only state to
    // hand back.
    rendererSync.restore(liveInstance?.techniqueId ?? null, liveInstance?.params ?? {});
    engine.invalidate();
  }
}

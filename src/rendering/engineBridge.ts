import type { NumberParamDef } from '@/techniques/types';
import { engine } from './RenderEngine';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore, reportError } from '@/state/uiStore';
import { getTechnique, techniqueNeedsTemporal } from '@/techniques/registry';
import { playback } from '@/playback/PlaybackController';
import { audioEngine } from '@/audio/AudioEngine';
import { useAudioStore } from '@/state/audioStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { modulationRuntime } from '@/modulation/runtime';
import { resolvePatternHandles } from '@/pattern/patternSourceRuntime';
import { cameraManager, useCameraStore } from '@/sources/cameraManager';
import { captureManager, useCaptureStore } from '@/sources/captureManager';
import { isLiveSource } from '@shared/schemas/project';
import { GeneratorSource } from '@/sources/generators/GeneratorSource';
import { getGenerator as getGeneratorDef, type GeneratorKind } from '@/sources/generators/definitions';
import { configureTriggers } from '@/signals/triggerRuntime';
import { runtimeBus } from '@/runtime/RuntimeBus';
import { FileImageSource } from '@/sources/FileImageSource';
import { FileVideoSource } from '@/sources/FileVideoSource';
import type { SourceRuntime } from '@/sources/SourceRuntime';
import type { TemporalSource } from './temporal/TemporalFrameProvider';
import type { TechniqueRenderer } from '@/techniques/types';

let loadedSourcePath: string | null = null;
let activeSourceRuntime: SourceRuntime | null = null;
let loadedAudioPath: string | null = null;
let loadGeneration = 0;
let loadedMaterialAsset: string | null = null;
let materialGeneration = 0;
let activeTechniqueId: string | null = null;
let activeRenderer: TechniqueRenderer | null = null;
let activeTemporalSource: TemporalSource | null = null;

/** Re-attach the temporal source after it (or the technique) changed. */
function syncTemporalSource(): void {
  engine.setTemporalSource(activeTemporalSource);
}

let lastProjectGeneration = -1;

function syncFromProject(): void {
  const { project, projectGeneration } = useProjectStore.getState();
  const { composition } = project;

  // A replaced document (new/open/recover) invalidates published frame state.
  if (projectGeneration !== lastProjectGeneration) {
    lastProjectGeneration = projectGeneration;
    runtimeBus.reset();
  }

  engine.setComposition(composition.width, composition.height, composition.background);

  // Source texture: still image, video, or the live camera (18D).
  const source = project.sources.find(
    (s) =>
      s.id === composition.sourceId &&
      (s.kind === 'image' || s.kind === 'video' || isLiveSource(s) || s.kind === 'generator'),
  );
  const sourceKey = source
    ? source.kind === 'generator'
      ? `generator:${source.id}:${source.generator}:${source.seed}`
      : source.kind === 'camera'
      ? `camera:${source.id}`
      : source.kind === 'screen'
        ? `screen:${source.id}:${source.displayId ?? 'any'}`
        : source.kind === 'window'
          ? `window:${source.id}`
          : `${source.kind}:${source.path}`
    : null;
  if (sourceKey !== loadedSourcePath) {
    loadedSourcePath = sourceKey;
    const generation = ++loadGeneration;
    playback.detachVideo();
    activeSourceRuntime?.dispose();
    activeSourceRuntime = null;
    if (source?.kind !== 'camera') cameraManager.detach();
    if (source?.kind !== 'screen' && source?.kind !== 'window') captureManager.detach();
    activeTemporalSource = null;
    engine.setTemporalSource(null);
    if (source?.kind !== 'generator') engine.setGeneratorSource(null);
    if (!source) {
      engine.setSource(null);
      cameraManager.detach();
      captureManager.detach();
    } else if (source.kind === 'generator') {
      // CE1F: a generator is a SourceRuntime like any other — the engine
      // owns it and hands its texture to the technique. No special path.
      const runtime = new GeneratorSource(source.generator as GeneratorKind, source.seed);
      activeSourceRuntime = runtime;
      engine.setGeneratorSource(runtime);
      engine.setSource(runtime.texture());
      activeTemporalSource = runtime.temporalSource();
      engine.setTemporalSource(activeTemporalSource);
    } else if (source.kind === 'screen' || source.kind === 'window') {
      // Like the camera: selecting only ATTACHES (idle until START). The
      // manager owns intent; nothing here may acquire.
      captureManager.attach(
        source.id,
        source.kind,
        source.kind === 'screen' ? source.displayId : null,
      );
    } else if (source.kind === 'camera') {
      // The camera runtime is user-intent driven: selecting the source only
      // ATTACHES it (idle until START CAMERA). Never auto-acquires.
      cameraManager.attach(source.id, source.deviceId ?? null);
    } else if (source.kind === 'image') {
      const runtime = new FileImageSource(source.path);
      activeSourceRuntime = runtime;
      void runtime.load().then(
        () => {
          if (generation !== loadGeneration) {
            runtime.dispose();
            return;
          }
          engine.setSource(runtime.texture());
          activeTemporalSource = runtime.temporalSource();
          engine.setTemporalSource(activeTemporalSource);
        },
        (err: unknown) => {
          if (generation === loadGeneration) {
            reportError('Load source', err);
            engine.setSource(null);
          }
        },
      );
    } else {
      const runtime = new FileVideoSource(source.path);
      activeSourceRuntime = runtime;
      void runtime.load().then(
        () => {
          if (generation !== loadGeneration) {
            runtime.dispose();
            return;
          }
          playback.attachVideo(runtime.video);
          engine.setSource(runtime.texture());
          activeTemporalSource = runtime.temporalSource();
          engine.setTemporalSource(activeTemporalSource);
          playback.seek(0);
        },
        (err: unknown) => {
          if (generation === loadGeneration) {
            const message = err instanceof Error ? err.message : String(err);
            reportError(message.includes('missing') ? 'Media offline' : 'Load video', err);
            engine.setSource(null);
          }
        },
      );
    }
  }

  // Audio source (analysis + audio-master clock).
  const audioSource = project.sources.find(
    (s) => s.id === composition.audioSourceId && s.kind === 'audio',
  );
  const audioPath = audioSource && audioSource.kind === 'audio' ? audioSource.path : null;
  if (audioPath !== loadedAudioPath) {
    loadedAudioPath = audioPath;
    if (audioPath) {
      void audioEngine.load(audioPath).then(() => playback.audioChanged());
    } else {
      audioEngine.unload();
      playback.audioChanged();
    }
  }

  // Technique renderer lifecycle.
  const instance = project.techniques.find((t) => t.enabled) ?? null;
  const techniqueId = instance?.techniqueId ?? null;
  if (techniqueId !== activeTechniqueId) {
    activeTechniqueId = techniqueId;
    if (techniqueId) {
      const definition = getTechnique(techniqueId);
      activeRenderer = definition ? definition.createRenderer() : null;
      engine.setTechniqueRenderer(activeRenderer);
      if (!definition) reportError('Technique', new Error(`Unknown technique: ${techniqueId}`));
    } else {
      activeRenderer = null;
      engine.setTechniqueRenderer(null);
    }
  }
  if (instance) engine.setTechniqueParams(instance.params);
  // CE1F: generator params + their modulation transform (editor authority).
  if (source?.kind === 'generator') {
    engine.setSourceParams(source.params);
    const genDef = getGeneratorDef(source.generator);
    const numeric = (genDef?.params ?? []).filter(
      (p): p is NumberParamDef => p.type === 'number',
    );
    engine.setSourceParamTransform((base, t) => modulationRuntime.transformSource(base, t, numeric));
  } else {
    engine.setSourceParamTransform(null);
  }
  engine.setMaterialState(project.material);
  // Temporal history is needed whenever a technique samples past frames.
  const needsTemporal = techniqueNeedsTemporal(techniqueId, instance?.params ?? {});
  engine.setTemporalEnabled(needsTemporal);
  if (needsTemporal) syncTemporalSource();

  configureModulation();

  // RuntimeBus (18A): project-shaped render inputs, low rate. techniqueId is
  // explicit render state — a replica synchronizes its renderer from this,
  // never from whatever renderer happened to be mounted before.
  runtimeBus.setRenderInputs({
    techniqueId,
    materialState: project.material,
    compWidth: composition.width,
    compHeight: composition.height,
    background: composition.background,
    source: source
      ? source.kind === 'generator'
        ? {
            kind: 'generator' as const,
            generator: source.generator,
            seed: source.seed,
            params: source.params,
          }
        : source.kind === 'camera'
        ? // The replica mirrors the editor's ACQUISITION, not the project
          // selection: STOP on the editor must release the replica's join
          // too, so the descriptor only says live-camera while live (18D).
          cameraManager.isLive()
          ? { kind: 'live-camera', deviceId: source.deviceId ?? null }
          : null
        : source.kind === 'screen' || source.kind === 'window'
          ? // Same acquisition-mirror rule for 18E capture sources.
            captureManager.isLive()
            ? source.kind === 'screen'
              ? { kind: 'live-screen', displayId: source.displayId ?? null }
              : { kind: 'live-window' }
            : null
          : { kind: source.kind === 'image' ? 'file-image' : 'file-video', path: source.path }
      : null,
    generation: projectGeneration,
  });

  // Custom material texture (SVG or raster image).
  const materialAsset =
    project.material.materialId === 'custom' ? project.material.assetPath : null;
  if (materialAsset !== loadedMaterialAsset) {
    loadedMaterialAsset = materialAsset;
    const generation = ++materialGeneration;
    if (!materialAsset) {
      engine.setMaterialTexture(null);
    } else {
      import('@/materials/textureLoader')
        .then(({ loadMaterialTexture }) => loadMaterialTexture(materialAsset))
        .then((texture) => {
          if (generation === materialGeneration) engine.setMaterialTexture(texture);
          else texture.dispose();
        })
        .catch((err) => {
          if (generation === materialGeneration) {
            reportError('Load material', err);
            engine.setMaterialTexture(null);
          }
        });
    }
  }
}

function syncFromUi(): void {
  const ui = useUiStore.getState();
  engine.setShowOriginal(ui.showOriginal);
}

function configureModulation(): void {
  const { project } = useProjectStore.getState();
  const instance = project.techniques.find((t) => t.enabled) ?? null;
  modulationRuntime.configure(project.modulations, instance?.techniqueId ?? null, {
    analysis: useAudioStore.getState().analysis,
    durationSec: usePlaybackStore.getState().durationSec,
    bpm: project.timeline.bpm,
    beatOffsetSec: project.timeline.beatOffsetSec,
    beatsPerBar: project.timeline.beatsPerBar,
    // P4: compile-on-change (cached); the pure engine never reads stores —
    // seed and handles are supplied here, at the store boundary.
    patterns: resolvePatternHandles(project.patternSources),
    projectSeed: project.explore.lastSeed ?? 1,
  });
  modulationRuntime.configureMacros(project.macros);
  configureTriggers(project.triggers, {
    bpm: project.timeline.bpm,
    beatOffsetSec: project.timeline.beatOffsetSec,
    beatsPerBar: project.timeline.beatsPerBar,
    analysis: useAudioStore.getState().analysis,
    markers: project.timeline.markers,
  });
  engine.invalidate();
}

/** Connect stores to the render engine. Returns a cleanup function. */
export function startEngineBridge(): () => void {
  const unsubProject = useProjectStore.subscribe(syncFromProject);
  let lastCameraLive = false;
  const unsubCamera = useCameraStore.subscribe((s) => {
    const live = s.status === 'live';
    if (live !== lastCameraLive) {
      lastCameraLive = live;
      syncFromProject();
    }
  });
  let lastCaptureLive = false;
  const unsubCapture = useCaptureStore.subscribe((s) => {
    const live = s.status === 'live';
    if (live !== lastCaptureLive) {
      lastCaptureLive = live;
      syncFromProject();
    }
  });
  const unsubUi = useUiStore.subscribe(syncFromUi);
  const unsubAudio = useAudioStore.subscribe(configureModulation);
  let lastDuration = -1;
  const unsubPlayback = usePlaybackStore.subscribe((s) => {
    if (s.durationSec !== lastDuration) {
      lastDuration = s.durationSec;
      configureModulation();
    }
  });
  engine.setParamTransform((base, t) => modulationRuntime.transform(base, t));
  syncFromProject();
  syncFromUi();
  return () => {
    unsubProject();
    unsubCamera();
    unsubCapture();
    unsubUi();
    unsubAudio();
    unsubPlayback();
    engine.setParamTransform(null);
    activeSourceRuntime?.dispose();
    activeSourceRuntime = null;
    loadedSourcePath = null;
    loadedAudioPath = null;
    loadedMaterialAsset = null;
    activeTechniqueId = null;
    activeRenderer = null;
  };
}

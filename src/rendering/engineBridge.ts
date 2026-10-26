import type { NumberParamDef } from '@/techniques/types';
import { mappingsByTarget, sourceLayerOf } from '@/modulation/layerRouting';
import { activityAt } from '@shared/activity';
import { renderedLayers } from '@shared/schemas/project';
import { engine } from './RenderEngine';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore, reportError } from '@/state/uiStore';
import { createTechniqueRenderer, getTechnique, techniqueNeedsTemporal } from '@/techniques/registry';
import { assessTechniqueChain } from '@/techniques/chainCompatibility';
import { playback } from '@/playback/PlaybackController';
import { audioEngine } from '@/audio/AudioEngine';
import { useAudioStore } from '@/state/audioStore';
import { usePlaybackStore } from '@/state/playbackStore';
import { modulationRuntime } from '@/modulation/runtime';
import { visualDemand } from '@/signals/visual/demand';
import { shadersReferencedBy } from '@/shaders/projectShaders';
import { useScopeStore } from '@/signals/visual/scopeStore';
import { pixelOriginKey } from '@/signals/visual/originKey';
import { calibrationStore } from '@/signals/visual/calibrationStore';
import { resolvePatternHandles } from '@/pattern/patternSourceRuntime';
import { cameraManager, useCameraStore } from '@/sources/cameraManager';
import { captureManager, useCaptureStore } from '@/sources/captureManager';
import { isLiveSource, selectedLayerOf, type Project } from '@shared/schemas/project';
import { GeneratorSource } from '@/sources/generators/GeneratorSource';
import { getGenerator as getGeneratorDef, type GeneratorKind } from '@/sources/generators/definitions';
import { configureTriggers } from '@/signals/triggerRuntime';
import { runtimeBus } from '@/runtime/RuntimeBus';
import { FileImageSource } from '@/sources/FileImageSource';
import { FileVideoSource } from '@/sources/FileVideoSource';
import { setProxy, UnsupportedMediaError } from '@/sources/mediaProxy';
import type { SourceRuntime } from '@/sources/SourceRuntime';
import type { TemporalSource } from './temporal/TemporalFrameProvider';
import type { TechniqueRenderer } from '@/techniques/types';

/**
 * v0.6 — everything the bridge tracks is now PER LAYER.
 *
 * These used to be module singletons because there was one branch. Keying them
 * by layer id is what makes a source or technique change in one layer leave
 * every other layer untouched: the reconciler only ever compares a layer's new
 * key against its own previous one.
 */
interface LayerBridgeState {
  /**
   * The engine object this memo describes.
   *
   * v0.6.1 — the memo below is keyed on SOURCE identity, so an unchanged
   * source short-circuits the whole reconciliation. That is right until the
   * runtime itself is replaced: a remount rebuilds every layer runtime, the
   * new one has no source and no technique, and a memo saying "unchanged"
   * meant nothing was ever attached to it. The composition went black and
   * stayed black, with no error — the same ownership question, one layer
   * further out. Measured on v0.6.0 as well, so this is a fix and not a
   * refactor artefact.
   */
  configuredRuntime: unknown;
  sourceKey: string | null;
  runtime: SourceRuntime | null;
  temporalSource: TemporalSource | null;
  techniqueId: string | null;
  chainWarningKey: string | null;
  renderer: TechniqueRenderer | null;
  chainRenderers: { id: string; techniqueId: string; renderer: TechniqueRenderer }[];
  loadGeneration: number;
}

const layerBridge = new Map<string, LayerBridgeState>();

function bridgeState(layerId: string): LayerBridgeState {
  let state = layerBridge.get(layerId);
  if (!state) {
    state = {
      configuredRuntime: null,
      sourceKey: null,
      runtime: null,
      temporalSource: null,
      techniqueId: null,
      chainWarningKey: null,
      renderer: null,
      chainRenderers: [],
      loadGeneration: 0,
    };
    layerBridge.set(layerId, state);
  }
  return state;
}

function disposeLayerBridge(layerId: string): void {
  const state = layerBridge.get(layerId);
  if (!state) return;
  state.runtime?.dispose();
  state.chainRenderers.forEach(({ renderer }) => renderer.dispose());
  layerBridge.delete(layerId);
}

let loadedAudioPath: string | null = null;
let loadedMaterialAsset: string | null = null;
let materialGeneration = 0;

/** Re-attach the temporal source after it (or the technique) changed. */
function syncTemporalSource(): void {
  for (const [layerId, state] of layerBridge) {
    engine.branchFor(layerId)?.setTemporalSource(state.temporalSource);
  }
}

let lastProjectGeneration = -1;


/** Stable identity for what a layer's source actually IS. Two layers naming
 * the same source produce the same key, which is what v0.6B needs in order to
 * share acquisition and analysis. */
function sourceKeyOf(source: ReturnType<typeof findSource>): string | null {
  if (!source) return null;
  switch (source.kind) {
    case 'generator':
      return `generator:${source.id}:${source.generator}:${source.seed}`;
    case 'camera':
      return `camera:${source.id}`;
    case 'screen':
      return `screen:${source.id}:${source.displayId ?? 'any'}`;
    case 'window':
      return `window:${source.id}`;
    default:
      return `${source.kind}:${source.path}`;
  }
}

function findSource(project: Project, sourceId: string | null) {
  return (
    project.sources.find(
      (s) =>
        s.id === sourceId &&
        (s.kind === 'image' || s.kind === 'video' || isLiveSource(s) || s.kind === 'generator'),
    ) ?? null
  );
}

/**
 * Load (or release) one layer's source.
 *
 * The whole function is scoped to `layer.id`: it compares this layer's source
 * key against this layer's previous one and touches this layer's branch. A
 * source change in one layer therefore cannot reset another — the guarantee
 * that makes layers usable as independent instruments.
 */
function syncLayerSource(
  project: Project,
  layer: Project['layers'][number],
  cameraLayerId: string | null,
  captureLayerId: string | null,
): void {
  const branch = engine.branchFor(layer.id);
  if (!branch) return;
  const state = bridgeState(layer.id);
  // A rebuilt runtime carries none of what this memo remembers configuring.
  if (state.configuredRuntime !== branch) {
    state.configuredRuntime = branch;
    state.sourceKey = null;
    state.techniqueId = null;
  }
  const source = findSource(project, layer.sourceId);
  const key = sourceKeyOf(source);
  if (key === state.sourceKey) {
    // Unchanged. Generator params still flow every frame (below).
    if (source?.kind === 'generator') applyGeneratorParams(branch, source);
    return;
  }

  state.sourceKey = key;
  const generation = ++state.loadGeneration;
  state.runtime?.dispose();
  state.runtime = null;
  state.temporalSource = null;
  branch.setTemporalSource(null);
  if (source?.kind !== 'generator') branch.setGeneratorSource(null);

  if (!source) {
    branch.setSource(null);
    return;
  }
  if (source.kind === 'generator') {
    const runtime = new GeneratorSource(source.generator as GeneratorKind, source.seed);
    state.runtime = runtime;
    branch.setGeneratorSource(runtime);
    branch.setSource(runtime.texture());
    state.temporalSource = runtime.temporalSource();
    branch.setTemporalSource(state.temporalSource);
    applyGeneratorParams(branch, source);
    return;
  }
  if (source.kind === 'screen' || source.kind === 'window') {
    if (layer.id === captureLayerId) {
      captureManager.attach(
        source.id,
        source.kind,
        source.kind === 'screen' ? source.displayId : null,
      );
    }
    return;
  }
  if (source.kind === 'camera') {
    if (layer.id === cameraLayerId) cameraManager.attach(source.id, source.deviceId ?? null);
    return;
  }
  if (source.kind === 'image') {
    const runtime = new FileImageSource(source.path);
    state.runtime = runtime;
    void runtime.load().then(
      () => {
        if (generation !== state.loadGeneration) {
          runtime.dispose();
          return;
        }
        branch.setSource(runtime.texture());
        state.temporalSource = runtime.temporalSource();
        branch.setTemporalSource(state.temporalSource);
      },
      (err: unknown) => {
        if (generation === state.loadGeneration) {
          reportError('Load source', err);
          abandonFailedRuntime(state, branch);
        }
      },
    );
    return;
  }
  const runtime = new FileVideoSource(source.path);
  state.runtime = runtime;
  void runtime.load().then(
    () => {
      if (generation !== state.loadGeneration) {
        runtime.dispose();
        return;
      }
      branch.setSource(runtime.texture());
      state.temporalSource = runtime.temporalSource();
      branch.setTemporalSource(state.temporalSource);
      // A video finishing its load can change which element should drive the
      // clock, and loads resolve out of order.
      syncTransportVideo();
    },
    (err: unknown) => {
      if (generation !== state.loadGeneration) return;
      abandonFailedRuntime(state, branch);
      syncTransportVideo();
      if (err instanceof UnsupportedMediaError) {
        void offerProxy(err);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      reportError(message.includes('missing') ? 'Media offline' : 'Load video', err);
    },
  );
}

/**
 * A source that failed to load must not linger: its dead <video> element would
 * otherwise stay in the layer state, be picked as the transport clock and keep
 * a stale error listener alive. Back to "no source" is a clean state; the
 * source key stays so the same failing file is not retried every frame.
 */
function abandonFailedRuntime(
  state: LayerBridgeState,
  branch: NonNullable<ReturnType<typeof engine.branchFor>>,
): void {
  state.runtime?.dispose();
  state.runtime = null;
  state.temporalSource = null;
  branch.setSource(null);
  branch.setTemporalSource(null);
}

/** Reuse a proxy made earlier, otherwise ask the user before transcoding. */
async function offerProxy(err: UnsupportedMediaError): Promise<void> {
  try {
    const existing = await window.material.findProxy(err.path);
    if (existing) {
      setProxy(err.path, existing);
      retryMediaPath(err.path);
      return;
    }
  } catch {
    // no proxy cache available: fall through to the dialog
  }
  useUiStore.getState().setPendingProxy({ path: err.path, codec: err.codec });
}

/** Forget what the bridge remembers about loading `path` so the next sync reloads it. */
export function retryMediaPath(path: string): void {
  const { project } = useProjectStore.getState();
  for (const owner of project.layers) {
    const source = findSource(project, owner.sourceId);
    if (source && 'path' in source && source.path === path) bridgeState(owner.id).sourceKey = null;
  }
  syncFromProject();
}

function applyGeneratorParams(
  branch: NonNullable<ReturnType<typeof engine.branchFor>>,
  source: { params: Record<string, string | number | boolean>; generator: string },
): void {
  branch.setSourceParams(source.params);
  const genDef = getGeneratorDef(source.generator);
  const numeric = (genDef?.params ?? []).filter((p): p is NumberParamDef => p.type === 'number');
  branch.setSourceParamTransform((base, t) => modulationRuntime.transformSource(base, t, numeric));
}

/** Mount (or replace) one layer's technique renderer. */
function syncLayerTechnique(project: Project, layer: Project['layers'][number]): void {
  const branch = engine.branchFor(layer.id);
  if (!branch) return;
  const state = bridgeState(layer.id);
  const chain = [layer.technique, ...layer.techniqueChain].filter(
    (stage): stage is NonNullable<typeof stage> => stage !== null && stage.enabled !== false,
  );
  if (layer.techniqueChain.length > 0 && chain.length > 1 && layer.technique?.enabled !== false) {
    const assessment = assessTechniqueChain(chain);
    const message = assessment.compatible
      ? 'Chain active in preview, Output and export. Takes, MIDI, modulation and Morph address stages by stable ID.'
      : assessment.reason ?? 'Technique chain is not supported.';
    const warningKey = `${chain.map((stage) => stage.id).join('>')}:${message}`;
    if (state.chainWarningKey !== warningKey) {
      if (assessment.compatible) useUiStore.getState().pushToast('info', message);
      else reportError('Technique chain', new Error(message));
    }
    state.chainWarningKey = warningKey;
  } else {
    state.chainWarningKey = null;
  }
  const instance = layer.technique?.enabled === false ? null : layer.technique;
  const techniqueId = instance?.techniqueId ?? null;
  if (techniqueId !== state.techniqueId) {
    state.techniqueId = techniqueId;
    if (techniqueId) {
      const definition = getTechnique(techniqueId);
      state.renderer = definition ? createTechniqueRenderer(techniqueId) : null;
      branch.setTechniqueRenderer(state.renderer);
      if (!definition) reportError('Technique', new Error(`Unknown technique: ${techniqueId}`));
    } else {
      state.renderer = null;
      branch.setTechniqueRenderer(null);
    }
  }
  if (instance) branch.setTechniqueParams(instance.params);
  const activeStages = instance
    ? [instance, ...layer.techniqueChain.filter((stage) => stage.enabled)]
    : [];
  const compatibleChain = activeStages.length > 1 && assessTechniqueChain(activeStages).compatible;
  if (compatibleChain) {
    const previous = state.chainRenderers;
    state.chainRenderers = layer.techniqueChain
      .filter((stage) => stage.enabled)
      .map((stage) => {
        const existing = previous.find((entry) => entry.id === stage.id && entry.techniqueId === stage.techniqueId);
        if (existing) return existing;
        const definition = getTechnique(stage.techniqueId);
        if (!definition) throw new Error(`Unknown technique: ${stage.techniqueId}`);
        return { id: stage.id, techniqueId: stage.techniqueId, renderer: createTechniqueRenderer(stage.techniqueId)! };
      });
    const retained = new Set(state.chainRenderers.map(({ renderer }) => renderer));
    previous.filter(({ renderer }) => !retained.has(renderer)).forEach(({ renderer }) => renderer.dispose());
    engine.setTechniqueChain(layer.id, state.chainRenderers.map((stage, index) => ({
      stageId: stage.id,
      renderer: stage.renderer,
      params: layer.techniqueChain.filter((entry) => entry.enabled)[index]!.params,
    })));
  } else {
    state.chainRenderers.forEach(({ renderer }) => renderer.dispose());
    state.chainRenderers = [];
    engine.setTechniqueChain(layer.id, []);
  }
  branch.setMaterialState(layer.material);
  const needsTemporal = techniqueNeedsTemporal(techniqueId, instance?.params ?? {});
  branch.setTemporalEnabled(needsTemporal);
  if (needsTemporal) branch.setTemporalSource(state.temporalSource);
}

function syncFromProject(): void {
  const { project: savedProject, previewProject, projectGeneration } = useProjectStore.getState();
  const project = previewProject ?? savedProject;
  const { composition } = project;

  // A replaced document (new/open/recover) invalidates published frame state.
  if (projectGeneration !== lastProjectGeneration) {
    lastProjectGeneration = projectGeneration;
    runtimeBus.reset();
    // v0.4A: calibration is per-session, per-origin state — a replaced
    // document must not inherit the previous project's ranges.
    calibrationStore.reset();
  }

  engine.setComposition(composition.width, composition.height, composition.background);

  // v0.6: reconcile the branch list FIRST, so every layer has a runtime to be
  // configured into. Identity is the layer id, so reordering moves nothing.
  const selectedId = project.selectedLayerId ?? project.layers[0]?.id ?? null;
  // Solo is resolved HERE, once, so the engine never has to know the rule and
  // the store is never rewritten to express it.
  const rendered = new Set(renderedLayers(project.layers).map((l) => l.id));
  engine.syncLayers(
    project.layers.map((l) => ({
      id: l.id,
      enabled: rendered.has(l.id),
      opacity: l.opacity,
      blendMode: l.blendMode,
      input: l.input,
      selected: l.id === selectedId,
    })),
  );
  for (const layerId of [...layerBridge.keys()]) {
    if (!project.layers.some((l) => l.id === layerId)) disposeLayerBridge(layerId);
  }

  // v0.6B — a live device is acquired ONCE and shown by every layer pointed at
  // it. The manager owns the device; the engine owns the distribution; this
  // decides only which layers are showing which kind.
  const liveKinds = new Map<string, 'camera' | 'capture'>();
  for (const l of project.layers) {
    const src = project.sources.find((x) => x.id === l.sourceId);
    if (src?.kind === 'camera') liveKinds.set(l.id, 'camera');
    else if (src?.kind === 'screen' || src?.kind === 'window') liveKinds.set(l.id, 'capture');
  }
  const cameraLayer = project.layers.find((l) => liveKinds.get(l.id) === 'camera');
  const captureLayer = project.layers.find((l) => liveKinds.get(l.id) === 'capture');
  if (!cameraLayer) cameraManager.detach();
  if (!captureLayer) captureManager.detach();
  engine.setLiveLayerKinds(liveKinds);

  for (const layer of project.layers) {
    syncLayerSource(project, layer, cameraLayer?.id ?? null, captureLayer?.id ?? null);
    syncLayerTechnique(project, layer);
  }
  syncTransportVideo();

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

  // v0.6: the selected layer is what the rest of the app reports on — the
  // Output's technique id, the inspector, presets. Per-layer configuration
  // already happened above.
  const selectedLayer = project.layers.find((l) => l.id === selectedId) ?? project.layers[0]!;
  const techniqueId = selectedLayer.technique?.techniqueId ?? null;
  const source = findSource(project, selectedLayer.sourceId);
  syncTemporalSource();

  configureModulation();

  /**
   * One source, as the Output describes it. Factored out so the layer stack
   * below reuses EXACTLY the same rules — including the acquisition mirror,
   * where a live descriptor is emitted only while the editor is actually
   * capturing, so STOP here releases the replica's join too.
   */
  const describeSource = (src: ReturnType<typeof findSource>) =>
    src
      ? src.kind === 'generator'
        ? {
            kind: 'generator' as const,
            generator: src.generator,
            seed: src.seed,
            params: src.params,
          }
        : src.kind === 'camera'
          ? cameraManager.isLive()
            ? { kind: 'live-camera' as const, deviceId: src.deviceId ?? null }
            : null
          : src.kind === 'screen' || src.kind === 'window'
            ? captureManager.isLive()
              ? src.kind === 'screen'
                ? { kind: 'live-screen' as const, displayId: src.displayId ?? null }
                : { kind: 'live-window' as const }
              : null
            : {
                kind: (src.kind === 'image' ? 'file-image' : 'file-video') as
                  | 'file-image'
                  | 'file-video',
                path: src.path,
              }
      : null;

  // RuntimeBus (18A): project-shaped render inputs, low rate. techniqueId is
  // explicit render state — a replica synchronizes its renderer from this,
  // never from whatever renderer happened to be mounted before.
  runtimeBus.setRenderInputs({
    techniqueId,
    // v0.5: every pack shader this project can reach — the active technique
    // and any pinned Look that names one, because a morph switches the
    // Output's technique id without going through a project change.
    customShaders: shadersReferencedBy(project),
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
    // v0.6E: the stack, as CONFIGURATION. Resolved per-frame values ride
    // FrameState; the replica still evaluates nothing.
    layers: renderedLayers(project.layers).map((l) => ({
      id: l.id,
      techniqueId: l.technique?.enabled === false ? null : (l.technique?.techniqueId ?? null),
      ...(l.technique?.enabled !== false && l.technique ? { techniqueParams: l.technique.params } : {}),
      techniqueChain: l.techniqueChain,
      materialState: l.material,
      blendMode: l.blendMode,
      input: l.input,
      enabled: true,
      opacity: l.opacity,
      source: describeSource(findSource(project, l.sourceId)),
    })),
    generation: projectGeneration,
  });

  // Custom material texture (SVG or raster image).
  const materialKey = project.material.materialId === 'custom'
    ? `custom:${project.material.assetPath ?? ''}`
    : project.material.materialId === 'typography'
      ? `typography:${JSON.stringify(project.material.params)}`
      : null;
  if (materialKey !== loadedMaterialAsset) {
    loadedMaterialAsset = materialKey;
    const generation = ++materialGeneration;
    if (!materialKey) {
      engine.setMaterialTexture(null);
    } else {
      import('@/materials/textureLoader')
        .then(({ loadMaterialTexture, loadTypographyTexture }) => project.material.materialId === 'typography'
          ? loadTypographyTexture(project.material)
          : project.material.assetPath ? loadMaterialTexture(project.material.assetPath) : null)
        .then((texture) => {
          if (!texture) return;
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

/**
 * The transport follows the FIRST video layer, re-evaluated on every change.
 *
 * There is one composition clock and two videos driving it would fight, so
 * exactly one element is attached. It has to be the one a layer is actually
 * showing NOW: the original guard only asked "is anything attached", so once
 * a video was bound the transport kept it even after the layer that owned it
 * was replaced. Measured on a four-layer scene — the clock advanced while
 * every layer's video sat paused at 0.02 s, driving an orphaned decoder from
 * an earlier import, and optical flow saw no new frames at all.
 */
function syncTransportVideo(): void {
  const { project } = useProjectStore.getState();
  let first: HTMLVideoElement | null = null;
  for (const layer of project.layers) {
    const runtime = layerBridge.get(layer.id)?.runtime;
    // A source that failed or is still connecting has no usable duration or frames.
    const video =
      runtime instanceof FileVideoSource && runtime.status === 'live' ? runtime.video : null;
    if (video) {
      first = video;
      break;
    }
  }
  if (first === playback.currentVideo) return;
  if (!first) {
    playback.detachVideo();
    return;
  }
  // Keep where the performer is; only a first attach starts from zero.
  const at = playback.hasVideo ? usePlaybackStore.getState().timeSec : 0;
  playback.attachVideo(first);
  playback.seek(at);
}

function configureModulation(): void {
  const { project } = useProjectStore.getState();
  const instance = selectedLayerOf(project).technique;
  // v0.6B: every layer gets its own slice — the mappings pointed at it, and
  // for each of those, the layer whose signals it reads.
  const byTarget = mappingsByTarget(project);
  modulationRuntime.configureLayers(
    project.layers.map((l) => {
      const mappings = byTarget.get(l.id) ?? [];
      return {
        layerId: l.id,
        techniqueId: l.technique?.enabled === false ? null : (l.technique?.techniqueId ?? null),
        mappings,
        signalSource: new Map(mappings.map((m) => [m.id, sourceLayerOf(project, m)])),
        stageTechniqueIds: new Map(l.techniqueChain.map((stage) => [stage.id, stage.techniqueId])),
      };
    }),
    selectedLayerOf(project).id,
  );
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
  // v0.4A: visual signals are demand-driven — nothing mapped means the
  // reducer sleeps and releases its targets, exactly like the flow service.
  // v0.4E: the runtime pushes the EFFECTIVE demand every frame, because a
  // morph or a candidate overlay replaces the project's mappings while it
  // runs. The bridge supplies the demand that has no mapping behind it — an
  // open scope — and forwards whatever comes back to the engine, which owns
  // the GPU. This is still the only wire between the two.
  modulationRuntime.setScopeDemand(useScopeStore.getState().watching);
  // Seed the engine immediately so a project change does not wait for the next
  // rendered frame to release or acquire analysis targets.
  engine.setVisualDemand(visualDemand(project.modulations, useScopeStore.getState().watching));
  engine.setVisualDemandByLayer(modulationRuntime.demandByLayer());
  // Calibration is scoped to the PIXEL ORIGIN, so two layers showing the same
  // camera share one envelope and a Look stays playable across both.
  const originCtx = {
    activeCameraDeviceId: useCameraStore.getState().devices[0]?.deviceId ?? null,
    chosenWindowId: useCaptureStore.getState().chosenWindowId,
  };
  for (const l of project.layers) {
    const src = project.sources.find((x) => x.id === l.sourceId) ?? null;
    modulationRuntime.setLayerVisualOrigin(l.id, pixelOriginKey(src, originCtx));
  }
  const active = project.sources.find((s) => s.id === project.composition.sourceId) ?? null;
  modulationRuntime.setVisualOrigin(pixelOriginKey(active, originCtx));
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
/**
 * v0.8.3 — let an EXPORT follow a Look that changes what a layer is made of.
 *
 * The export evaluator keeps its own working copy of the project and never
 * touches the store, which is exactly right for parameters — and exactly wrong
 * for layer sources, because the bridge only ever reconciles sources from the
 * store. A Look recalled mid-export that pointed a layer at a different
 * generator changed the mosaic parameters and left the picture on the old
 * generator. Measured on a piece whose three Looks were three Chladni plates:
 * preview showed three figures, export showed one figure dressed three ways.
 *
 * So the export hands its working stack here and the SAME `syncLayerSource`
 * the store path uses reconciles it, memo and all — which is what keeps the
 * bridge's memory of what it configured truthful through the export.
 *
 * Generator sources only. A file or live source cannot be swapped inside a
 * synchronous frame loop; a Look that asks for one is left where it was and
 * the limitation is written down in docs/EXPORT_PIPELINE.md.
 */
export function syncLayersForExport(project: Project): void {
  const selectedId = project.selectedLayerId ?? project.layers[0]?.id ?? null;
  const rendered = new Set(renderedLayers(project.layers).map((l) => l.id));
  engine.syncLayers(
    project.layers.map((l) => ({
      id: l.id,
      enabled: rendered.has(l.id),
      opacity: l.opacity,
      blendMode: l.blendMode,
      input: l.input,
      selected: l.id === selectedId,
    })),
  );
  for (const layer of project.layers) {
    syncLayerTechnique(project, layer);
    const source = findSource(project, layer.sourceId);
    if (source && source.kind !== 'generator') continue;
    syncLayerSource(project, layer, null, null);
  }
}

/** After an export: put every layer back to what the DOCUMENT says. */
export function resyncFromStore(): void {
  syncFromProject();
}

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
  // An open scope registers demand of its own, and closing it gives it back.
  const unsubScope = useScopeStore.subscribe(configureModulation);
  const unsubAudio = useAudioStore.subscribe(configureModulation);
  let lastDuration = -1;
  const unsubPlayback = usePlaybackStore.subscribe((s) => {
    if (s.durationSec !== lastDuration) {
      lastDuration = s.durationSec;
      configureModulation();
    }
  });
  engine.setFrameSink(() => modulationRuntime.markFrame());
  engine.setLayerStateSink((layerId, opacity) => {
    const resolved = modulationRuntime.resolveLayerState(layerId, { opacity }, engine.currentTimeSec);
    // Activity window (shared/activity.ts): the same gate the export applies.
    const layer = useProjectStore.getState().project.layers.find((l) => l.id === layerId);
    return { ...resolved, opacity: resolved.opacity * activityAt(layer?.activity, engine.currentTimeSec) };
  });
  engine.setParamTransform((base, t) => modulationRuntime.transform(base, t));
  // v0.6B: each branch resolves its OWN parameters, from the mappings pointed
  // at it and the layer each of those reads its signals from.
  engine.setLayerParamTransform(
    (layerId) => (base, t, stageId) => stageId
      ? modulationRuntime.transformStageFor(layerId, stageId, base, t)
      : modulationRuntime.transformFor(layerId, base, t),
  );
  engine.setLayerVisualSink((layerId, stats) =>
    modulationRuntime.setLayerVisualStats(layerId, stats, performance.now() / 1000),
  );
  // The engine owns the GPU reduction; the runtime owns calibration. This is
  // the only wire between them, so neither imports the other.
  // Calibration advances on WALL time, not transport time: the preview
  // analyser runs whenever pixels are produced, including while the transport
  // is stopped (live camera, simulation generator). Feeding it `getTime()`
  // pinned dt at 0 whenever playback was paused, so the warmup window never
  // elapsed and every visual signal stayed `warming` forever. Export does not
  // use this path — it owns a separate store stepped by frame time.
  modulationRuntime.setDemandSink((ids) => {
    engine.setVisualDemand(ids);
    // The per-layer split has to follow: an overlay changes what the primary
    // layer needs analysed, and the flat set alone no longer reaches the GPU.
    engine.setVisualDemandByLayer(modulationRuntime.demandByLayer());
  });
  syncFromProject();
  syncFromUi();
  return () => {
    unsubProject();
    unsubCamera();
    unsubCapture();
    unsubUi();
    unsubAudio();
    unsubScope();
    unsubPlayback();
    engine.setParamTransform(null);
    for (const layerId of [...layerBridge.keys()]) disposeLayerBridge(layerId);
    loadedAudioPath = null;
    loadedMaterialAsset = null;
  };
}

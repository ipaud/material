import type * as THREE from 'three';
import { OutputLayer } from './outputLayer';
import { RenderEngine } from '@/rendering/RenderEngine';
import { createTechniqueRenderer, getTechnique } from '@/techniques/registry';
import type { LoadedShader } from '@shared/schemas/shaderPack';
import { registerPack } from '@/shaders/packRegistry';
import { OutputCameraSource } from './outputCameraSource';
import { OutputCaptureSource } from './outputCaptureSource';
import type { GeneratorSource } from '@/sources/generators/GeneratorSource';
import { FileVideoSource } from '@/sources/FileVideoSource';
import type { SourceRuntime } from '@/sources/SourceRuntime';
import type { FrameStateMsg, OutputChannelMsg, RenderInputsMsg } from '@shared/outputChannel';

/**
 * Output replica (Phase 18B).
 *
 * Passive by construction: no stores, no MIDI, no scheduler, no morph or
 * candidate runtimes, no modulation evaluation. It owns its media elements
 * and its own RenderEngine, and renders exactly the evaluated FrameState it
 * receives.
 *
 * INVARIANT (18A contract): the active renderer's technique always equals
 * the latest FrameState.techniqueId, and temporal capability follows
 * FrameState.temporalActive — never derived locally, never inferred from
 * RenderInputs after the first frame.
 */

const DRIFT_CORRECT_SEC = 0.06; // same discipline as the editor's video slave
const SLAVE_TICK_MS = 100;

interface ClockBase {
  authorityTimeSec: number;
  atWall: number;
  playing: boolean;
}

export class OutputReplica {
  readonly engine = new RenderEngine();

  private activeTechniqueId: string | null = null;
  /** Pack id → sorted shader hashes currently mounted, so an unchanged
   * RenderInputs message costs nothing. */
  private readonly shaderSignatures = new Map<string, string>();
  private temporalActive = false;
  private source: SourceRuntime | null = null;
  private camera: OutputCameraSource | null = null;
  private capture: OutputCaptureSource | null = null;
  private generator: GeneratorSource | null = null;
  private generatorParams: Record<string, string | number | boolean> = {};
  private transitionGeneration = 0;
  private sourceKey: string | null = null;
  /**
   * v0.6E — one entry per layer. The single-source fields above still serve
   * the SELECTED layer's video slave and the diagnostics, so nothing that
   * read them had to change.
   */
  private readonly layers = new Map<string, OutputLayer>();
  private layerOrder: string[] = [];
  private selectedLayerId: string | null = null;
  private generation = -999;
  private clock: ClockBase = { authorityTimeSec: 0, atWall: Date.now(), playing: false };
  private slaveTimer: ReturnType<typeof setInterval> | null = null;
  private resizeObserver: ResizeObserver | null = null;

  // Diagnostics for the spike overlay / QA.
  latest: FrameStateMsg | null = null;
  framesReceived = 0;
  lastWallLatencyMs = 0;
  lastReceiveToApplyMs = 0;

  init(canvas: HTMLCanvasElement): void {
    this.engine.init(canvas);
    const fit = () => {
      this.engine.fit();
      this.engine.invalidate();
    };
    this.resizeObserver = new ResizeObserver(fit);
    this.resizeObserver.observe(canvas);
    this.slaveTimer = setInterval(() => this.slaveVideo(), SLAVE_TICK_MS);
  }

  dispose(): void {
    if (this.slaveTimer) clearInterval(this.slaveTimer);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.source?.dispose();
    this.camera?.dispose();
    this.capture?.dispose();
    this.engine.dispose();
  }

  /** Authority composition time, estimated between messages. */
  estimateTime(): number {
    if (!this.clock.playing) return this.clock.authorityTimeSec;
    return this.clock.authorityTimeSec + (Date.now() - this.clock.atWall) / 1000;
  }

  handle(msg: OutputChannelMsg): void {
    switch (msg.type) {
      case 'render-inputs':
        this.applyInputs(msg);
        break;
      case 'frame':
        this.applyFrame(msg);
        break;
      case 'transport':
        this.clock = {
          authorityTimeSec: msg.timeSec,
          atWall: Date.now(),
          playing: msg.action === 'play',
        };
        if (msg.action === 'seek') {
          // Frames before a seek are not history for what comes after it —
          // mirror the editor's seek semantics on the replica's own atlas.
          this.engine.resetTemporal();
          this.seekVideo(msg.timeSec);
        }
        this.slaveVideo();
        break;
      case 'clock':
        this.clock = {
          authorityTimeSec: msg.authorityTimeSec,
          atWall: Date.now(),
          playing: msg.playing,
        };
        break;
    }
  }

  private applyInputs(msg: RenderInputsMsg): void {
    const generationChanged = msg.generation !== this.generation;
    this.generation = msg.generation;
    if (generationChanged) {
      // Project switch: drop every remnant of the previous document before
      // anything from the new one renders (§22 — no stale-A frames).
      this.latest = null;
      this.engine.resetTemporal();
    }

    // v0.5: register any pack shaders this project can reach BEFORE the
    // technique is synced, or the replica would resolve the id to the
    // missing-pack placeholder and keep it. Definitions are data; the replica
    // compiles locally, and the hash keeps a repeat message from recompiling.
    this.syncCustomShaders(msg.customShaders);

    this.engine.setComposition(msg.compWidth, msg.compHeight, msg.background);

    // v0.6.1 — the single-source path is gone. Every source, generator and
    // technique now belongs to a LAYER, and the editor has sent a layer stack
    // on every message since v0.6. Keeping a second, host-level copy of that
    // machinery is what let the replica render one technique while the editor
    // rendered four, so it is deleted rather than guarded.
    this.applyLayerInputs(msg);

    // First contact only: seed the renderer so a static scene shows before
    // the first FrameState. After that, FrameState owns technique identity.
    if (this.activeTechniqueId === null && msg.techniqueId) {
      this.syncTechnique(msg.techniqueId, false);
    }
  }

  /**
   * v0.6E — mirror the stack.
   *
   * The replica's engine is the same RenderEngine the editor uses, so it
   * composites layers the same way, from the same code. What arrives here is
   * only configuration: which layers exist, what each is made of, how it
   * blends. Resolved values ride FrameState, and the replica still evaluates
   * nothing.
   */
  private applyLayerInputs(msg: RenderInputsMsg): void {
    const inputs = msg.layers;
    if (!inputs || inputs.length === 0) {
      // No stack in the message: an authority that predates layers, or a
      // composition with nothing in it. Leave the single-source path alone.
      if (this.layerOrder.length > 0) this.releaseLayers();
      return;
    }
    this.engine.syncLayers(
      inputs.map((l) => ({
        id: l.id,
        enabled: l.enabled,
        opacity: l.opacity,
        blendMode: l.blendMode as never,
        ...(l.input ? { input: l.input } : {}),
        selected: l.techniqueId === msg.techniqueId,
      })),
    );
    for (const [id, layer] of [...this.layers]) {
      if (inputs.some((l) => l.id === id)) continue;
      layer.dispose(this.engine.branchFor(id));
      this.layers.delete(id);
    }
    const liveKinds = new Map<string, 'camera' | 'capture'>();
    for (const input of inputs) {
      const branch = this.engine.branchFor(input.id);
      if (!branch) continue;
      let layer = this.layers.get(input.id);
      if (!layer) {
        layer = new OutputLayer(input.id, this.engine);
        this.layers.set(input.id, layer);
      }
      layer.applyInputs(branch, input, msg.generation);
      const kind = layer.wantsLiveTexture;
      if (kind) liveKinds.set(input.id, kind);
    }
    this.layerOrder = inputs.map((l) => l.id);
    this.selectedLayerId =
      inputs.find((l) => l.techniqueId === msg.techniqueId)?.id ?? (inputs[0]?.id ?? null);
    this.engine.setLiveLayerKinds(liveKinds);
    // One join per device, shared by every layer showing it — the replica
    // owns the join for the same reason the editor does.
    const wantsCamera = [...liveKinds.values()].includes('camera');
    const wantsCapture = [...liveKinds.values()].includes('capture');
    const cameraInput = inputs.find((l) => l.source?.kind === 'live-camera');
    if (wantsCamera && cameraInput?.source?.kind === 'live-camera') {
      void this.loadCamera(cameraInput.source.deviceId ?? null, `layers:${msg.generation}`);
    }
    if (wantsCapture) void this.loadCapture(`layers:${msg.generation}`);
  }

  private releaseLayers(): void {
    for (const [id, layer] of this.layers) layer.dispose(this.engine.branchFor(id));
    this.layers.clear();
    this.layerOrder = [];
    this.engine.syncLayers([]);
  }

  /** 18D fan-out — see outputCameraSource.ts for the measured ADR. */
  private async loadCamera(deviceId: string | null, key: string | null): Promise<void> {
    const camera = new OutputCameraSource(deviceId);
    try {
      await camera.load();
    } catch (err) {
      console.warn('[replica] camera join failed:', err);
      camera.dispose();
      if (this.sourceKey === key) this.engine.setLiveSource('camera', null);
      return;
    }
    if (this.sourceKey !== key) {
      camera.dispose(); // superseded while joining (or stale generation)
      return;
    }
    this.camera = camera;
    // ONE acquisition, every layer showing it — the same rule the editor
    // follows. 18F: the replica keeps its OWN realtime temporal history,
    // warmed from its own join.
    this.engine.setLiveSource('camera', camera.texture());
  }

  /** 18E fan-out — see outputCaptureSource.ts: silent rejoin, main decides. */
  private async loadCapture(key: string | null): Promise<void> {
    const capture = new OutputCaptureSource();
    try {
      await capture.load();
    } catch (err) {
      console.warn('[replica] capture rejoin failed:', err);
      capture.dispose();
      if (this.sourceKey === key) this.engine.setLiveSource('capture', null);
      return;
    }
    if (this.sourceKey !== key) {
      capture.dispose(); // superseded while joining (or stale generation)
      return;
    }
    this.capture = capture;
    this.engine.setLiveSource('capture', capture.texture());
  }


  /** Mirror the editor's pack registry for exactly the shaders it sent. */
  private syncCustomShaders(shaders: readonly LoadedShader[] | undefined): void {
    if (!shaders || shaders.length === 0) return;
    const byPack = new Map<string, LoadedShader[]>();
    for (const s of shaders) {
      const list = byPack.get(s.packId);
      if (list) list.push(s);
      else byPack.set(s.packId, [s]);
    }
    for (const [packId, list] of byPack) {
      const signature = list
        .map((s) => s.hash)
        .sort()
        .join(',');
      if (this.shaderSignatures.get(packId) === signature) continue;
      this.shaderSignatures.set(packId, signature);
      const first = list[0] as LoadedShader;
      registerPack({
        id: packId,
        name: first.packName,
        version: first.packVersion,
        author: '',
        description: '',
        dir: '',
        shaders: list,
        warnings: [],
      });
      // A pack version the replica already mounted must re-mount its renderer,
      // or the Output would keep drawing the previous revision.
      if (this.activeTechniqueId?.startsWith(`custom:${packId}:`)) {
        const id = this.activeTechniqueId;
        this.activeTechniqueId = null;
        this.syncTechnique(id, false);
      }
      for (const [layerId, outputLayer] of this.layers) {
        const branch = this.engine.branchFor(layerId);
        if (branch) {
          outputLayer.refreshCustomPrimaryRenderer(branch, packId);
          outputLayer.refreshCustomChainRenderers(branch, packId);
        }
      }
    }
  }

  private syncTechnique(techniqueId: string, temporalActive: boolean): void {
    if (techniqueId !== this.activeTechniqueId) {
      const definition = getTechnique(techniqueId);
      if (!definition) return;
      this.engine.setTechniqueRenderer(createTechniqueRenderer(techniqueId));
      this.activeTechniqueId = techniqueId;
      const selected = this.selectedLayerId ? this.layers.get(this.selectedLayerId) : null;
      const branch = this.selectedLayerId ? this.engine.branchFor(this.selectedLayerId) : null;
      if (selected && branch) selected.setActiveTechnique(branch, techniqueId);
    }
    if (temporalActive !== this.temporalActive) {
      this.engine.setTemporalEnabled(temporalActive);
      this.temporalActive = temporalActive;
    }
  }

  private applyFrame(msg: FrameStateMsg): void {
    // CE1G: the Output composites its OWN local A/B frames using the
    // RESOLVED progress/style the editor sent. It never evaluates morph
    // schedule, easing or Look interpolation — the authority rule holds.
    const tr = msg.transition;
    if (tr) {
      if (tr.generation !== this.transitionGeneration) {
        this.transitionGeneration = tr.generation;
        // Snapshot the replica's CURRENT visual as its own A side. Opening
        // the Output mid-morph therefore starts from what it is showing
        // (documented: it cannot reconstruct the editor's earlier A).
        this.engine.captureTransitionSnapshot();
      }
      this.engine.setTransition({
        progress: tr.progress,
        params: {
          style: tr.style as never,
          softness: tr.params.softness ?? 0.15,
          amount: tr.params.amount ?? 1,
          scale: tr.params.scale ?? 0.5,
          centerX: tr.params.centerX ?? 0,
          centerY: tr.params.centerY ?? 0,
          angle: tr.params.angle ?? 0,
          seed: tr.params.seed ?? 1,
        },
      });
    } else if (this.transitionGeneration !== 0) {
      this.transitionGeneration = 0;
      this.engine.setTransition(null);
    }
    // v0.6E — every layer's generator, driven by the params the EDITOR
    // resolved for that layer, and every layer's resolved opacity.
    if (this.layers.size > 0) {
      const renderer = (this.engine as unknown as { renderer: THREE.WebGLRenderer | null })
        .renderer;
      if (renderer) {
        for (const [id, layer] of this.layers) {
          const branch = this.engine.branchFor(id);
          if (!branch) continue;
          layer.advanceGenerator(
            branch,
            renderer,
            msg.compTime,
            msg.layerSourceParams?.[id] ??
              (id === this.selectedLayerId ? msg.sourceParams : undefined),
            this.engine.compositionWidth,
            this.engine.compositionHeight,
          );
        }
      }
      if (msg.layerOpacity) {
        this.engine.setAuthorityLayerOpacity(new Map(Object.entries(msg.layerOpacity)));
      }
      if (msg.layerParams) {
        this.engine.setAuthorityLayerParams(new Map(Object.entries(msg.layerParams)));
      }
    }
    const received = performance.now();
    this.framesReceived++;
    this.latest = msg;
    this.lastWallLatencyMs = Date.now() - msg.wallEmittedAt;

    // 18A INVARIANT, unchanged by layers: the active technique always equals
    // the latest FrameState.techniqueId. A cross-technique MORPH switches it
    // without a project change, so RenderInputs — which is low-rate — is not
    // enough on its own. It applies to the SELECTED layer, which is the one
    // a morph acts on.
    if (msg.techniqueId) this.syncTechnique(msg.techniqueId, msg.temporalActive);
    if (this.selectedLayerId) {
      this.layers.get(this.selectedLayerId)?.noteParams(msg.finalParams);
    }
    for (const [id, layer] of this.layers) {
      if (id === this.selectedLayerId) continue;
      layer.noteParams(msg.layerParams?.[id] ?? null);
    }
    for (const [id, layer] of this.layers) layer.noteStageParams(msg.layerStageParams?.[id] ?? {});
    this.engine.setTime(msg.compTime);
    // Engine's own dirty-flag rAF draws at this display's cadence —
    // latest-wins by construction, stale frames collapse into one draw.
    this.lastReceiveToApplyMs = performance.now() - received;
  }

  /** Same philosophy as the editor's A/V slave: correct only real drift. */
  private slaveVideo(): void {
    const video = this.source instanceof FileVideoSource ? this.source.video : null;
    if (!video || video.readyState < 1) return;
    const target = Math.min(this.estimateTime(), Math.max((video.duration || 0) - 0.001, 0));
    if (this.clock.playing) {
      if (video.paused) void video.play().catch(() => undefined);
      if (Math.abs(video.currentTime - target) > DRIFT_CORRECT_SEC) {
        video.currentTime = target;
      }
    } else {
      if (!video.paused) video.pause();
      if (Math.abs(video.currentTime - target) > DRIFT_CORRECT_SEC) {
        video.currentTime = target;
      }
    }
  }

  private seekVideo(timeSec: number): void {
    const video = this.source instanceof FileVideoSource ? this.source.video : null;
    if (!video || video.readyState < 1) return;
    video.currentTime = Math.min(timeSec, Math.max((video.duration || 0) - 0.001, 0));
  }

  videoDriftMs(): number | null {
    const video = this.source instanceof FileVideoSource ? this.source.video : null;
    if (!video || video.readyState < 1) return null;
    return (video.currentTime - this.estimateTime()) * 1000;
  }
}

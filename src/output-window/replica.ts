import type * as THREE from 'three';
import { RenderEngine } from '@/rendering/RenderEngine';
import { getTechnique } from '@/techniques/registry';
import { FileImageSource } from '@/sources/FileImageSource';
import { OutputCameraSource } from './outputCameraSource';
import { OutputCaptureSource } from './outputCaptureSource';
import { GeneratorSource } from '@/sources/generators/GeneratorSource';
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
  private temporalActive = false;
  private source: SourceRuntime | null = null;
  private camera: OutputCameraSource | null = null;
  private capture: OutputCaptureSource | null = null;
  private generator: GeneratorSource | null = null;
  private generatorParams: Record<string, string | number | boolean> = {};
  private transitionGeneration = 0;
  private sourceKey: string | null = null;
  private generation = -999;
  private clock: ClockBase = { authorityTimeSec: 0, atWall: Date.now(), playing: false };
  private slaveTimer: ReturnType<typeof setInterval> | null = null;

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
    new ResizeObserver(fit).observe(canvas);
    this.slaveTimer = setInterval(() => this.slaveVideo(), SLAVE_TICK_MS);
  }

  dispose(): void {
    if (this.slaveTimer) clearInterval(this.slaveTimer);
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

    this.engine.setComposition(msg.compWidth, msg.compHeight, msg.background);
    if (msg.materialState) this.engine.setMaterialState(msg.materialState);
    this.syncMaterialAsset(
      msg.materialState?.materialId === 'custom' ? msg.materialState.assetPath : null,
    );

    const key = msg.source
      ? msg.source.kind === 'generator'
        ? `generator:${msg.source.generator}:${msg.source.seed}:${msg.generation}`
        : msg.source.kind === 'live-camera'
        ? `live-camera:${msg.source.deviceId ?? 'default'}:${msg.generation}`
        : msg.source.kind === 'live-screen'
          ? `live-screen:${msg.source.displayId ?? 'any'}:${msg.generation}`
          : msg.source.kind === 'live-window'
            ? `live-window:${msg.generation}`
            : `${msg.source.kind}:${msg.source.path}:${msg.generation}`
      : null;
    if (key !== this.sourceKey) {
      this.sourceKey = key;
      this.source?.dispose();
      this.source = null;
      this.camera?.dispose();
      this.camera = null;
      this.capture?.dispose();
      this.capture = null;
      this.generator?.dispose();
      this.generator = null;
      this.engine.setSource(null);
      this.engine.setLiveSourceActive(false);
      this.engine.setTemporalSource(null);
      if (msg.source?.kind === 'generator') {
        // CE1F: the Output builds the SAME generator locally from the config
        // — no pixels cross the process. Per-frame params arrive resolved in
        // FrameState; the replica never evaluates modulation.
        this.generator = new GeneratorSource(msg.source.generator as never, msg.source.seed);
        this.generatorParams = msg.source.params;
        this.engine.setSource(null);
      } else if (msg.source?.kind === 'live-camera') {
        void this.loadCamera(msg.source.deviceId ?? null, key);
      } else if (msg.source?.kind === 'live-screen' || msg.source?.kind === 'live-window') {
        void this.loadCapture(key);
      } else if (msg.source) {
        void this.loadSource(msg.source.kind, msg.source.path, key);
      }
    }

    // First contact only: seed the renderer so a static scene shows before
    // the first FrameState. After that, FrameState owns technique identity.
    if (this.activeTechniqueId === null && msg.techniqueId) {
      this.syncTechnique(msg.techniqueId, false);
    }
  }

  /** 18D fan-out — see outputCameraSource.ts for the measured ADR. */
  private async loadCamera(deviceId: string | null, key: string | null): Promise<void> {
    const camera = new OutputCameraSource(deviceId);
    try {
      await camera.load();
    } catch (err) {
      console.warn('[replica] camera join failed:', err);
      camera.dispose();
      if (this.sourceKey === key) this.engine.setSource(null);
      return;
    }
    if (this.sourceKey !== key) {
      camera.dispose(); // superseded while joining (or stale generation)
      return;
    }
    this.camera = camera;
    this.engine.setSource(camera.texture());
    // 18F: the replica keeps its OWN realtime temporal history — same
    // wall-clock model as the editor, warmed from its own acquisition.
    this.engine.setLiveSourceActive(true);
  }

  /** 18E fan-out — see outputCaptureSource.ts: silent rejoin, main decides. */
  private async loadCapture(key: string | null): Promise<void> {
    const capture = new OutputCaptureSource();
    try {
      await capture.load();
    } catch (err) {
      console.warn('[replica] capture rejoin failed:', err);
      capture.dispose();
      if (this.sourceKey === key) this.engine.setSource(null);
      return;
    }
    if (this.sourceKey !== key) {
      capture.dispose(); // superseded while joining (or stale generation)
      return;
    }
    this.capture = capture;
    this.engine.setSource(capture.texture());
    this.engine.setLiveSourceActive(true);
  }

  private async loadSource(
    kind: 'file-image' | 'file-video',
    path: string,
    key: string | null,
  ): Promise<void> {
    const runtime = kind === 'file-image' ? new FileImageSource(path) : new FileVideoSource(path);
    try {
      await runtime.load();
    } catch (err) {
      console.warn('[replica] source load failed:', err);
      if (this.sourceKey === key) this.engine.setSource(null);
      runtime.dispose();
      return;
    }
    if (this.sourceKey !== key) {
      runtime.dispose(); // superseded while loading
      return;
    }
    this.source = runtime;
    this.engine.setSource(runtime.texture());
    this.engine.setTemporalSource(runtime.temporalSource());
    if (runtime instanceof FileVideoSource) {
      this.seekVideo(this.estimateTime());
      this.slaveVideo();
    }
    this.engine.invalidate();
  }

  private materialAssetPath: string | null = null;
  private syncMaterialAsset(assetPath: string | null): void {
    if (assetPath === this.materialAssetPath) return;
    this.materialAssetPath = assetPath;
    if (!assetPath) {
      this.engine.setMaterialTexture(null);
      return;
    }
    void import('@/materials/textureLoader')
      .then(({ loadMaterialTexture }) => loadMaterialTexture(assetPath))
      .then((texture) => {
        if (this.materialAssetPath === assetPath) this.engine.setMaterialTexture(texture);
        else texture.dispose();
      })
      .catch((err) => console.warn('[replica] material load failed:', err));
  }

  private syncTechnique(techniqueId: string, temporalActive: boolean): void {
    if (techniqueId !== this.activeTechniqueId) {
      const definition = getTechnique(techniqueId);
      if (!definition) return;
      this.engine.setTechniqueRenderer(definition.createRenderer());
      this.activeTechniqueId = techniqueId;
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
    // CE1F: drive the local generator with the params the EDITOR resolved.
    if (this.generator) {
      const params = msg.sourceParams ?? this.generatorParams;
      const renderer = (this.engine as unknown as { renderer: THREE.WebGLRenderer | null })
        .renderer;
      if (renderer) {
        if (this.generator.isStateless) {
          this.generator.renderFrame(renderer, msg.compTime, params, true, 1920, 1080);
        } else {
          this.generator.advancePreview(renderer, performance.now() / 1000, params);
        }
        this.engine.setSource(this.generator.texture());
      }
    }
    const received = performance.now();
    this.framesReceived++;
    this.latest = msg;
    this.lastWallLatencyMs = Date.now() - msg.wallEmittedAt;

    if (msg.techniqueId) this.syncTechnique(msg.techniqueId, msg.temporalActive);
    if (msg.materialState) this.engine.setMaterialState(msg.materialState);
    this.engine.setTechniqueParams(msg.finalParams);
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

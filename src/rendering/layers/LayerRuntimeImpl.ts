import * as THREE from 'three';
import { bindTarget } from '../bindTarget';
import type { LayerRuntime } from './layerRuntime';
import type { MaterialState, ParamRecord } from '@shared/schemas/project';
import type { TechniqueRenderer } from '@/techniques/types';
import { renderTechniqueChain as renderTechniqueChainPasses } from '@/rendering/techniqueChain';
import { OpticalFlowField } from '../flow/OpticalFlowField';
import { VideoIngest } from './VideoIngest';
import { ImageStatsReducer } from '../analysis/ImageStatsReducer';
import { referenceMotionScale } from '../analysis/reductionLadder';
import { demandNeedsFlow } from '@/signals/visual/demand';
import type { RawVisualStats, VisualSignalId } from '@/signals/visual/types';
import {
  TemporalFrameProvider,
  type BoundaryMode,
  type TemporalConfig,
  type TemporalSource,
  type TemporalStats,
} from '../temporal/TemporalFrameProvider';





/**
 * GPU render engine. Lives outside React — React (and the store bridge) push
 * state in via setters; the engine renders on demand in its own rAF loop.
 */

/**
 * v0.6.1 — ONE creative chain: the implementation behind `LayerRuntime`.
 *
 * A source, a generator, temporal history, optical flow, a technique, image
 * analysis, feedback state. It owns no canvas, no animation loop, no view
 * transform and no compositor, because those belong to the composition that
 * hosts it.
 *
 * Splitting this out of `RenderEngine` is what makes the v0.6 defect family
 * impossible rather than merely unlikely. Before the split one class played
 * both roles with a boolean deciding which, so a HOST instance carried a
 * generator, a flow and a feedback surface it never used — and every
 * predicate over them compiled, ran, and answered `false` while being true of
 * the composition. Nine bugs shared exactly that shape. A host can no longer
 * be asked a creative question because it no longer has the fields to answer
 * one from.
 */
export class LayerRuntimeImpl implements LayerRuntime {
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(20, 1, 10, 100000);

  private sourceTexture: THREE.Texture | null = null;
  /** Serial layers: the composite beneath, for this frame (see LayerRuntime.setInputOverride). */
  private inputOverride: THREE.Texture | null = null;
  /** Bumped each frame the host sets the override: the accumulator's 'frame identity'. */
  private overrideRevision = 0;
  /** Decoded copy of a video source for technique shaders; null for every other source. */
  private videoIngest: VideoIngest | null = null;
  private materialTexture: THREE.Texture | null = null;
  private temporal: TemporalFrameProvider | null = null;
  private temporalEnabled = false;
  private temporalSource: TemporalSource | null = null;
  private boundaryMode: BoundaryMode = 'clamp';
  /** While true the preview capture path is disabled (export owns the buffer). */
  private exportMode = false;
  private originalQuad: THREE.Mesh | null = null;
  private techniqueRenderer: TechniqueRenderer | null = null;
  private techniqueChain: readonly { stageId: string; renderer: TechniqueRenderer; params: ParamRecord }[] = [];
  private techniqueStageOverrides: ReadonlyMap<string, ParamRecord> = new Map();
  private resolvedStageParams: Record<string, ParamRecord> = {};
  private techniqueScratchTargets: readonly [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private techniqueParams: ParamRecord = {};
  private materialState: MaterialState | null = null;

  private compWidth = 1920;
  private compHeight = 1080;
  private compBackground = '#000000';
  private showOriginal = false;
  private seed = 1;
  private perspectiveAmount = 0.35;

  /** Optional per-frame parameter transform (modulation). */
  private paramTransform: ((base: ParamRecord, timeSec: number, stageId?: string) => ParamRecord) | null = null;

  /** Read by the host when it publishes the stack. */
  get lastResolved(): ParamRecord | null {
    return this.lastResolvedParams;
  }

  get lastResolvedStageParams(): Readonly<Record<string, ParamRecord>> {
    return this.resolvedStageParams;
  }

  /** What this engine last resolved for its technique — the host reads it
   * off each branch to publish the stack in one message. */
  private lastResolvedParams: ParamRecord | null = null;

  setParamTransform(fn: ((base: ParamRecord, timeSec: number, stageId?: string) => ParamRecord) | null): void {
    this.paramTransform = fn;
    this.invalidate();
  }

  private dirty = true;
  liveSourceActive = false;
  private timeSec = 0;

  // ---- lifecycle ----

  /**
   * v0.6 — construct this engine as a LAYER BRANCH.
   *
   * A branch owns exactly one creative chain: source, generator, temporal
   * history, optical flow, technique renderer, visual analysis, feedback
   * state. It owns no canvas, no animation loop and no view transform,
   * because those belong to the composition that hosts it.
   *
   * Reusing this class rather than extracting a parallel one is deliberate.
   * Every branch behaviour — the flow gate, the N-1 signal contract, feedback
   * priming, export preroll, context restore — is already implemented and
   * tested here exactly once. A second implementation would be a second set of
   * those bugs, and layers would differ from each other in ways nobody
   * intended.
   */
  initBranch(renderer: THREE.WebGLRenderer): void {
    this.renderer = renderer;
  }

  /** True when this engine is a layer inside a composition, not the host. */

  get branchMode(): boolean {
    return true;
  }

  /**
   * Render this branch into `target` at composition resolution.
   *
   * The same sequence the on-canvas path uses, minus everything that belongs
   * to the host: no well, no viewport rect, no transition compositing. What
   * comes out is one layer's pixels, ready for the compositor.
   */
  renderLayerTo(target: THREE.WebGLRenderTarget, opts: { clear: boolean }): void {
    const renderer = this.renderer;
    if (!renderer) return;
    const prevTarget = renderer.getRenderTarget();
    const prevScissorTest = renderer.getScissorTest();
    try {
      // Neither setPixelRatio nor setViewport belongs here — see bindTarget.
      if (this.temporalEnabled && this.temporal && this.effectiveSource() && !this.exportMode) {
        const temporalClock = this.liveSourceActive ? performance.now() / 1000 : this.timeSec;
        this.temporal.advancePreview(renderer, temporalClock, this.effectiveSource()!);
      }
      this.updateCamera(target.width / Math.max(target.height, 1));
      if (!this.exportMode) this.renderGenerator(renderer, this.timeSec);
      if (!this.exportMode) this.updateFlowService(renderer, undefined, this.sourceClock());
      const chainRendered = !this.showOriginal && this.renderTechniqueChain(target, opts.clear);
      if (!chainRendered) this.syncScene();
      if (!this.exportMode) this.updateVisualStats(renderer);
      if (this.feedbackActive) {
        (
          this.techniqueRenderer as unknown as {
            feedbackPrepass?: (r: THREE.WebGLRenderer, clockSec: number) => void;
          }
        ).feedbackPrepass?.(renderer, performance.now() / 1000);
      }
      if (chainRendered) return;
      bindTarget(renderer, target);
      if (opts.clear) {
        // Transparent BLACK, never the composition background: the background
        // belongs to the composition, and a layer that painted it would erase
        // everything beneath it.
        //
        // Black specifically. The first version passed the string
        // 'transparent', which THREE.Color parses as WHITE — so every layer
        // cleared to white at zero alpha and anything with a soft edge blended
        // against it. Measured as 64 800 differing bytes against the
        // pre-layer render, up to 38 codes at tile edges.
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
      }
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.setScissorTest(prevScissorTest);
    }
  }


  /**
   * Draw this branch onto whatever is currently bound — the canvas, inside the
   * viewport and scissor rect the host has already set. Same creative chain as
   * `renderLayerTo`; it simply does not redirect to a layer target.
   */
  renderLayerToCanvas(renderer: THREE.WebGLRenderer): void {
    // The scissor rect has the composition's aspect, not the canvas's.
    this.updateCamera(this.compWidth / Math.max(this.compHeight, 1));
    if (this.temporalEnabled && this.temporal && this.effectiveSource() && !this.exportMode) {
      const temporalClock = this.liveSourceActive ? performance.now() / 1000 : this.timeSec;
      this.temporal.advancePreview(renderer, temporalClock, this.effectiveSource()!);
    }
    if (!this.exportMode) this.renderGenerator(renderer, this.timeSec);
    if (!this.exportMode) this.updateFlowService(renderer, undefined, this.sourceClock());
    if (!this.showOriginal && this.techniqueChain.length > 0) {
      throw new Error('Technique chains must render through a composition target');
    }
    this.syncScene();
    if (!this.exportMode) this.updateVisualStats(renderer);
    if (this.feedbackActive) {
      (
        this.techniqueRenderer as unknown as {
          feedbackPrepass?: (r: THREE.WebGLRenderer, clockSec: number) => void;
        }
      ).feedbackPrepass?.(renderer, performance.now() / 1000);
    }
    renderer.render(this.scene, this.camera);
  }

  /** Render this branch with EXPLICIT params (export authority). */
  renderLayerToWithParams(
    target: THREE.WebGLRenderTarget,
    params: ParamRecord,
    clear = true,
  ): void {
    const renderer = this.renderer;
    if (!renderer) return;
    const prevTarget = renderer.getRenderTarget();
    const prevScissorTest = renderer.getScissorTest();
    try {
      this.updateCamera(target.width / Math.max(target.height, 1));
      const chainRendered = !this.showOriginal && this.renderTechniqueChain(target, clear, params);
      if (!chainRendered) this.syncScene(params);
      if (chainRendered) return;
      bindTarget(renderer, target);
      if (clear) {
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
      }
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.setScissorTest(prevScissorTest);
    }
  }

  /** Free this branch's own GPU state without touching a shared renderer. */
  disposeBranch(): void {
    this.temporal?.dispose();
    this.temporal = null;
    this.flow?.dispose();
    this.flow = null;
    this.visualStats?.dispose();
    this.visualStats = null;
    this.generator?.dispose();
    this.generator = null;
    this.techniqueRenderer?.dispose();
    this.techniqueRenderer = null;
    this.techniqueChain = [];
    this.techniqueScratchTargets = null;
    this.originalQuad?.geometry.dispose();
    (this.originalQuad?.material as THREE.Material | undefined)?.dispose();
    this.originalQuad = null;
    this.rvfcCancel?.();
    this.rvfcCancel = null;
    this.sourceTexture = null;
    this.videoIngest?.dispose();
    this.videoIngest = null;
    // The renderer is the composition's, never this branch's.
    this.renderer = null;
  }

  /**
   * Rebuild after a context loss. A runtime has no canvas and therefore never
   * sees the event: the host owns the listener and calls this on every layer,
   * because every one of them allocated its targets on the SAME lost context.
   */
  handleContextRestored(): void {
    // CE1H §57: marking state stale is not enough. Every render target
    // allocated on the LOST context is a dead GL handle, and the first pass
    // that touches one raises INVALID_OPERATION (measured: 1282 after restore
    // on Time Field, Motion Mosh and Reaction Diffusion). The targets have to
    // be REALLOCATED, not just emptied.
    if (this.temporal) {
      const config = this.temporal.config;
      this.temporal.dispose();
      this.temporal = new TemporalFrameProvider(config);
    }
    this.flow?.dispose();
    this.flow = null; // updateFlowService rebuilds it on demand
    this.visualStats?.dispose();
    this.visualStats = null;
    this.latestVisual = null;
    this.resetFeedback();
    (
      this.techniqueRenderer as { onContextRestored?: () => void } | null
    )?.onContextRestored?.();
    for (const { renderer } of this.techniqueChain) {
      (renderer as { onContextRestored?: () => void }).onContextRestored?.();
    }
    this.invalidate();
  }

  setSource(texture: THREE.Texture | null): void {
    if (this.sourceTexture && this.sourceTexture !== texture) this.sourceTexture.dispose();
    this.sourceTexture = texture;
    // CE1B: a new source identity must never inherit old feedback state.
    this.resetFeedback();
    // CE1D: nor may flow compare frames from two different sources.
    this.flow?.reset();
    this.watchSourceFrames();
    this.rebuildOriginalQuad();
    this.invalidate();
  }

  setInputOverride(texture: THREE.Texture | null): void {
    this.inputOverride = texture;
    if (texture) this.overrideRevision++;
  }

  advanceTemporalFromInput(): void {
    // Preview pushes inside renderLayerTo; the export path draws without it, and
    // a serial layer has no source to seek, so its history is fed frame by frame.
    if (!this.exportMode || !this.inputOverride) return;
    if (!this.temporalEnabled || !this.temporal || !this.renderer) return;
    this.temporal.advancePreview(this.renderer, this.timeSec, this.inputOverride);
  }

  get needsFlowOrStats(): boolean {
    return this.flowIsNeeded() || this.visualDemand.size > 0;
  }

  /** What this layer analyses and feeds its history from: the composite beneath, else its own source. */
  private effectiveSource(): THREE.Texture | null {
    return this.inputOverride ?? this.sourceTexture;
  }

  /** Pixel size of the effective source (a render target carries none on `.image`). */
  private effectiveSize(): { w: number; h: number } {
    if (this.inputOverride) return { w: this.compWidth, h: this.compHeight };
    const img = (this.sourceTexture as { image?: { videoWidth?: number; width?: number; videoHeight?: number; height?: number } } | null)?.image;
    return { w: img?.videoWidth ?? img?.width ?? 0, h: img?.videoHeight ?? img?.height ?? 0 };
  }

  /** 18D: live camera active — the loop renders every RAF while true.
   * 18F: flipping this is a live-history boundary (start, stop, device or
   * target switch all funnel through the managers' teardown/start), so the
   * temporal buffer resets — history from two source identities, or from a
   * previous capture run, must never mix. */
  setLiveSourceActive(active: boolean): void {
    if (this.liveSourceActive !== active) this.temporal?.invalidate();
    this.liveSourceActive = active;
    this.invalidate();
  }

  setComposition(width: number, height: number, background: string): void {
    // v0.6: composition size and background are GLOBAL — a branch renders into
    // a target the host sized, so it has to agree about the dimensions.
    const changed = width !== this.compWidth || height !== this.compHeight;
    this.compWidth = width;
    this.compHeight = height;
    this.compBackground = background;
    // No `fit()` here: the view transform belongs to the composition, not to
    // a layer inside it.
    if (changed) this.rebuildOriginalQuad();
    this.invalidate();
  }

  setTechniqueRenderer(renderer: TechniqueRenderer | null): void {
    if (this.techniqueRenderer && this.techniqueRenderer !== renderer) {
      this.scene.remove(this.techniqueRenderer.object3d);
      this.techniqueRenderer.dispose();
    }
    this.techniqueRenderer = renderer;
    if (renderer) this.scene.add(renderer.object3d);
    this.invalidate();
  }

  get hasTechniqueChain(): boolean {
    return this.techniqueChain.length > 0;
  }

  setTechniqueChain(stages: readonly { stageId: string; renderer: TechniqueRenderer; params: ParamRecord }[]): void {
    for (const { renderer } of this.techniqueChain) this.scene.remove(renderer.object3d);
    this.techniqueChain = stages;
    this.resolvedStageParams = {};
    for (const { renderer } of stages) {
      renderer.object3d.visible = false;
      this.scene.add(renderer.object3d);
    }
    this.invalidate();
  }

  setTechniqueStageParams(params: ReadonlyMap<string, ParamRecord>): void {
    this.techniqueStageOverrides = params;
    this.resolvedStageParams = {};
    this.invalidate();
  }

  setTechniqueScratchTargets(
    targets: readonly [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null,
  ): void {
    this.techniqueScratchTargets = targets;
  }

  // ---- CE1F: the generator source. The engine owns the runtime, renders
  // it every frame with the RESOLVED source params (modulation is evaluated
  // by the editor's authority, exactly like technique params), and hands
  // the resulting texture to whatever technique is active.
  private generator: {
    renderFrame(
      renderer: THREE.WebGLRenderer,
      timeSec: number,
      params: ParamRecord,
      force?: boolean,
      width?: number,
      height?: number,
    ): void;
    advancePreview(renderer: THREE.WebGLRenderer, wallSec: number, params: ParamRecord): void;
    texture(): THREE.Texture | null;
    isStateless: boolean;
    dispose(): void;
    reset(): void;
  } | null = null;
  private sourceParams: ParamRecord = {};
  private sourceParamTransform: ((base: ParamRecord, timeSec: number) => ParamRecord) | null = null;

  setGeneratorSource(runtime: unknown): void {
    if (this.generator && this.generator !== runtime) this.generator.dispose();
    this.generator = (runtime as typeof this.generator) ?? null;
    this.invalidate();
  }

  setSourceParams(params: ParamRecord): void {
    this.sourceParams = params;
    this.invalidate();
  }

  setSourceParamTransform(fn: ((base: ParamRecord, timeSec: number) => ParamRecord) | null): void {
    this.sourceParamTransform = fn;
  }

  /** Final resolved generator params for this frame — the value the Output
   * receives (it never evaluates modulation itself). */
  resolvedSourceParams(timeSec = this.timeSec): ParamRecord {
    return this.sourceParamTransform
      ? this.sourceParamTransform(this.sourceParams, timeSec)
      : this.sourceParams;
  }

  /**
   * Does any layer need a frame even though nothing invalidated the host?
   *
   * The three "keep rendering" conditions — a live source, feedback, a
   * simulation generator — all moved onto the branches, so the host's own
   * flags are permanently false in layer mode and its loop went back to sleep
   * after every invalidation. Measured on a single animating generator: 19
   * rendered frames per second against 99 before layers, while rAF itself was
   * running at 120. Nothing looked broken; the picture just updated slowly.
   */
  get hasGenerator(): boolean {
    return this.generator !== null;
  }

  /** A live/simulation generator keeps the loop alive; a stateless one only
   * needs redraws when time or params move (dirty-driven). */
  get generatorActive(): boolean {
    return this.generator !== null && !this.generator.isStateless && !this.exportMode;
  }

  private renderGenerator(renderer: THREE.WebGLRenderer, timeSec: number, force = false): void {
    const gen = this.generator;
    if (!gen) return;
    const params = this.resolvedSourceParams(timeSec);
    if (gen.isStateless || this.exportMode) {
      gen.renderFrame(renderer, timeSec, params, force, this.compWidth, this.compHeight);
    } else {
      // Simulation generators keep CE1E preview semantics (wall clock).
      gen.advancePreview(renderer, performance.now() / 1000, params);
    }
    // A generator emits no decoded-frame event, so this is its frame identity.
    this.generatorRevision++;
    const tex = gen.texture();
    if (tex && tex !== this.sourceTexture) {
      this.sourceTexture = tex;
      this.rebuildOriginalQuad();
    }
  }

  setTechniqueParams(params: ParamRecord): void {
    this.techniqueParams = params;
    const perspective = params.perspective;
    if (typeof perspective === 'number') this.perspectiveAmount = perspective;
    this.invalidate();
  }

  setMaterialState(material: MaterialState): void {
    this.materialState = material;
    this.invalidate();
  }

  setMaterialTexture(texture: THREE.Texture | null): void {
    if (this.materialTexture && this.materialTexture !== texture) this.materialTexture.dispose();
    this.materialTexture = texture;
    this.invalidate();
  }

  /** Enable composition-time frame history (video tile / echo / slit scan). */
  setTemporalEnabled(enabled: boolean, config?: Partial<TemporalConfig>): void {
    if (enabled && !this.temporal) this.temporal = new TemporalFrameProvider(config);
    if (!enabled && this.temporal) {
      this.temporal.dispose();
      this.temporal = null;
    }
    this.temporalEnabled = enabled;
    this.invalidate();
  }

  setTemporalSource(source: TemporalSource | null): void {
    this.temporalSource = source;
    this.temporal?.invalidate();
    this.invalidate();
  }

  setBoundaryMode(mode: BoundaryMode): void {
    this.boundaryMode = mode;
  }

  /** Drop temporal history — seek, loop restart, source change (§13).
   * 18F: COMPOSITION-time resets only. In live mode history is realtime
   * observation — a timeline seek or loop wrap must not rewind reality, so
   * this is a no-op while a live source is active. Live-source boundaries
   * (start/stop/device/target/project switch) reset through the
   * setLiveSourceActive flip and setTemporalSource instead. */
  resetTemporal(): void {
    if (this.liveSourceActive) return;
    this.temporal?.invalidate();
    this.invalidate();
  }

  getTemporalStats(): TemporalStats | null {
    return this.temporal?.getStats() ?? null;
  }

  // ---- CE1D: the shared optical-flow service. ONE per renderer; consumers
  // receive ctx.flow. update() is gated by source-frame identity, so a
  // 30fps source yields ~30 flow computes/s under a 120Hz loop.
  private flow: OpticalFlowField | null = null;

  /**
   * v0.4A: flow is needed when a TECHNIQUE wants it OR a motion signal is
   * demanded. Without this, mapping `motion.amount` while a non-flow technique
   * is active would dispose the very field the signal measures.
   */
  private flowIsNeeded(): boolean {
    return this.techniqueWantsFlow() || demandNeedsFlow(this.visualDemand);
  }

  private techniqueWantsFlow(): boolean {
    const r = this.techniqueRenderer as {
      usesFlow?: boolean;
      wantsFlow?: (params: ParamRecord) => boolean;
    } | null;
    if (r?.usesFlow === true || this.techniqueChain.some(({ renderer, params }) => {
      const stage = renderer as { usesFlow?: boolean; wantsFlow?: (p: ParamRecord) => boolean };
      return stage.usesFlow === true || stage.wantsFlow?.(params) === true;
    })) return true;
    if (!r) return false;
    return r.wantsFlow?.(this.paramTransform
      ? this.paramTransform(this.techniqueParams, this.timeSec)
      : this.techniqueParams) === true;
  }

  // Source-frame identity via requestVideoFrameCallback: one counter tick
  // per DECODED frame, for file video and live capture alike. This is what
  // gates flow recomputation — a 30fps source yields ~30 keys/s no matter
  // how fast the render loop spins (§83 hard gate).
  private sourceFrameCounter = 0;
  /**
   * Generators produce new pixels without any decoded-frame event: their
   * texture is ONE object whose uuid never changes and `requestVideoFrameCallback`
   * does not exist for them, so `sourceFrameKey()` was constant and every
   * frame-gated consumer early-returned forever. Measured before the fix: 3 s
   * of preview at 120 fps over a noise generator with Motion Mosh produced 0
   * flow updates. Export was unaffected because it passes explicit keys, which
   * is exactly why the determinism matrix never saw it — a frozen field is
   * perfectly reproducible.
   */
  private generatorRevision = 0;
  private rvfcCancel: (() => void) | null = null;

  private watchSourceFrames(): void {
    this.rvfcCancel?.();
    this.rvfcCancel = null;
    const img = (this.sourceTexture as { image?: unknown } | null)?.image as
      | (HTMLVideoElement & {
          requestVideoFrameCallback?: (cb: () => void) => number;
          cancelVideoFrameCallback?: (h: number) => void;
        })
      | undefined;
    if (!img || typeof img.requestVideoFrameCallback !== 'function') return;
    let live = true;
    const tick = () => {
      if (!live) return;
      this.sourceFrameCounter++;
      img.requestVideoFrameCallback!(tick);
    };
    img.requestVideoFrameCallback(tick);
    this.rvfcCancel = () => {
      live = false;
    };
  }

  private sourceFrameKey(): string {
    if (this.inputOverride) return `below:${this.overrideRevision}`;
    return `${this.sourceTexture?.uuid ?? 'none'}:${this.sourceFrameCounter}:${this.generatorRevision}`;
  }

  /** The clock the source frames advance on: wall time for a live sensor or a
   * simulation generator stepping in preview, composition time otherwise. */
  private sourceClock(): number {
    const wall = this.liveSourceActive || (this.generator !== null && !this.generator.isStateless && !this.exportMode);
    return wall ? performance.now() / 1000 : this.timeSec;
  }

  private updateFlowService(renderer: THREE.WebGLRenderer, frameKey?: string, atSec?: number): void {
    if (!this.flowIsNeeded()) {
      if (this.flow) {
        // Demand-driven (§77): nothing needs flow — release the targets.
        this.flow.dispose();
        this.flow = null;
      }
      return;
    }
    if (!this.flow) this.flow = new OpticalFlowField();
    const { w, h } = this.effectiveSize();
    this.flow.update(renderer, this.effectiveSource(), w, h, frameKey ?? this.sourceFrameKey(), atSec);
  }

  /** Seek/loop discontinuity: invalidate the frame pair — for seekable
   * sources only (a live sensor's pair stays valid across composition
   * seeks, same rule as resetTemporal). */
  resetFlowPair(): void {
    if (this.liveSourceActive) return;
    this.flow?.reset();
  }

  /**
   * Export: advance flow deterministically for this frame (after the runner
   * seeked the source). First frame resets so the pair primes.
   *
   * CE1H: this is called from the export loop. It previously was not called
   * at all, and `renderFrame` skips flow in export mode — so every Motion
   * technique exported against a stale preview flow field, or none. That is
   * perfectly deterministic, which is why repeat and subrange comparisons
   * passed while the motion itself was missing; the preset contact sheet
   * caught it by rendering four different Flow Displace presets to
   * byte-identical tiles.
   */
  prepareFlowForExport(
    compositionTime: number,
    frameKey: string,
    isFirstFrame: boolean,
    width: number,
    height: number,
    params?: ParamRecord,
  ): void {
    const renderer = this.renderer;
    if (!renderer) return;
    if (params) this.syncScene(params);
    if (!this.flowIsNeeded()) return;
    if (isFirstFrame) {
      // The two-tap prime below builds a genuine adjacent pair, so the first
      // solve after it IS a measurement — unlike a preview discontinuity.
      this.flow?.reset(true);
      // CE1F: prime the pair with the PREVIOUS frame's source so the first
      // exported frame of a subrange carries the same motion as the same
      // global frame of a full export (flow needs two frames, always).
      if (this.generator && this.exportPrevSourceSec !== null) {
        this.prepareGeneratorForExport(this.exportPrevSourceSec, width, height);
        this.updateFlowService(renderer, `${frameKey}:pre`, this.exportPrevSourceSec);
        // Put the source back on THIS frame before the second tap, or the
        // pair holds the previous frame twice and the flow is zero.
        this.prepareGeneratorForExport(compositionTime, width, height);
      }
    }
    this.updateFlowService(renderer, frameKey, compositionTime);
    if (params) this.syncScene(params); // rebind ctx.flow after compute
  }

  // ---- v0.4A: image / motion signal analysis -------------------------------
  private visualStats: ImageStatsReducer | null = null;
  private visualDemand: ReadonlySet<VisualSignalId> = new Set();
  private latestVisual: RawVisualStats | null = null;
  /** The reducer's own object, for its "same frame, same object" cache. */
  private latestRaw: RawVisualStats | null = null;
  private lastVisualMs = 0;
  /** Preview analysis rate. Export is gated by frame key alone, so every
   * exported frame analyses exactly once. */
  private static readonly VISUAL_HZ = 30;

  private visualSink: ((stats: RawVisualStats | null) => void) | null = null;

  /** Where analysed stats go. The engine must not import the modulation
   * runtime, so authority wires this from the bridge. */
  setVisualSink(fn: ((stats: RawVisualStats | null) => void) | null): void {
    this.visualSink = fn;
  }

  /** Editor authority pushes the demanded set; empty releases the targets. */
  setVisualDemand(ids: ReadonlySet<VisualSignalId>): void {
    this.visualDemand = ids;
    if (ids.size === 0) {
      this.visualStats?.dispose();
      this.visualStats = null;
      this.latestVisual = null;
      this.latestRaw = null;
    }
    // A HOST has no source texture, so there is nothing here to measure. The
    // demand belongs to the layer set: without a per-layer split the selected
    // layer carries it, which is what a visual signal meant before layers.
    this.invalidate();
  }

  get visualSignalStats(): RawVisualStats | null {
    return this.latestVisual;
  }

  get visualDiagnostics(): { reductions: number; bytes: number; width: number; height: number } | null {
    return this.visualStats
      ? {
          reductions: this.visualStats.reductions,
          bytes: this.visualStats.bytes,
          ...this.visualStats.resolution,
        }
      : null;
  }

  /** Analysis grid: the flow grid when flow is live (sampling a vector field
   * 1:1 matters — bilinear resampling before `length()` under-reads magnitude
   * wherever directions oppose), else the source fitted under a cap. */
  private visualGrid(): { width: number; height: number } | null {
    const flowRes = this.flow?.resolution;
    if (flowRes && flowRes.width > 1) return flowRes;
    const { w, h } = this.effectiveSize();
    if (w < 2 || h < 2) return null;
    const scale = Math.min(256 / Math.max(w, h), 1);
    return { width: Math.max(Math.round(w * scale), 8), height: Math.max(Math.round(h * scale), 8) };
  }

  /**
   * Reduce this frame's source (and flow) to scalars.
   *
   * Called AFTER syncScene in preview, so `evalSources` has already consumed
   * what frame N-1 published. That one-frame delay is not a nicety: preview
   * evaluates signals after the source renders and export evaluates them
   * before, so sampling N-1 in both is what makes them agree.
   */
  private updateVisualStats(renderer: THREE.WebGLRenderer, frameKey?: string): void {
    if (this.visualDemand.size === 0) return;
    if (!frameKey) {
      const now = performance.now();
      if (now - this.lastVisualMs < 1000 / LayerRuntimeImpl.VISUAL_HZ) return;
      this.lastVisualMs = now;
    }
    const grid = this.visualGrid();
    if (!grid) return;
    if (!this.visualStats) this.visualStats = new ImageStatsReducer();
    const next = this.visualStats.analyse(
      renderer,
      this.effectiveSource(),
      // `ready` and not merely present: the priming update clears the field,
      // and publishing that zero seeds the motion calibrator with a low
      // extreme it then takes ~10 s to give back (measured: calibrated motion
      // sat at 0.89 mean, saturating at 1, on a source whose raw span was
      // 0.42-0.59). Absence is the honest report — publish.ts omits the keys.
      demandNeedsFlow(this.visualDemand) && this.flow?.ready
        ? (this.flow.texture() ?? null)
        : null,
      grid.width,
      grid.height,
      frameKey ?? this.sourceFrameKey(),
    );
    if (next !== this.latestRaw) {
      this.latestRaw = next;
      // v0.8.3: texels per REFERENCE frame, so a generator's velocity reads
      // the same at 60 Hz preview and 30 fps export. See MOTION_REFERENCE_FPS.
      const scale = referenceMotionScale(this.flow?.pairDtSec);
      this.latestVisual =
        next && scale !== 1 ? { ...next, motionAmount: next.motionAmount * scale } : next;
      this.visualSink?.(this.latestVisual);
    }
  }

  /** EXPORT: analyse this frame, keyed by GLOBAL frame so a subrange drives the
   * reducer exactly as a full export does. */
  updateVisualStatsForExport(frameKey: string): void {
    if (!this.renderer) return;
    this.updateVisualStats(this.renderer, frameKey);
  }

  get flowStats(): { updates: number; width: number; height: number; bytes: number } | null {
    return this.flow
      ? { updates: this.flow.updates, ...this.flow.resolution, bytes: this.flow.bytes }
      : null;
  }

  /** CE1B: a feedback technique keeps the loop stepping (its state is a
   * visual process — static image + static params still evolve, §24). */
  get feedbackActive(): boolean {
    return (
      (this.techniqueRenderer as { feedback?: boolean } | null)?.feedback === true &&
      !this.exportMode
    );
  }

  /** CE1B: drop feedback state — source identity change, context restore,
   * Candidate release. Next frame primes from the current image. */
  resetFeedback(): void {
    (this.techniqueRenderer as { resetFeedback?: () => void } | null)?.resetFeedback?.();
  }

  private lastFeedbackExportSec: number | null = null;

  /** Export path: deterministic feedback stepping (preroll on first frame,
   * incremental whole steps after). Mirrors prepareTemporalForExport. */
  prepareFeedbackForExport(
    compositionTime: number,
    isFirstFrame: boolean,
    params?: ParamRecord,
  ): void {
    const renderer = this.renderer;
    const fb = this.techniqueRenderer as {
      feedback?: boolean;
      exportBegin?: (r: THREE.WebGLRenderer, t: number) => void;
      exportAdvance?: (r: THREE.WebGLRenderer, from: number, to: number) => void;
    } | null;
    if (!renderer || fb?.feedback !== true) return;
    // Make sure the renderer holds THIS frame's params/context before any
    // stepping — a cold export (no preview ever ran) must still prime.
    if (params) this.syncScene(params);
    if (isFirstFrame || this.lastFeedbackExportSec === null) {
      fb.exportBegin?.(renderer, compositionTime);
    } else {
      fb.exportAdvance?.(renderer, this.lastFeedbackExportSec, compositionTime);
    }
    this.lastFeedbackExportSec = compositionTime;
  }

  /** True when the installed technique keeps a feedback surface — i.e. its
   * export state depends on every frame before it (CE1H §37). */
  /**
   * Does anything in this composition carry feedback history?
   *
   * The host holds no technique in layer mode, so asking only about itself
   * answered "no" while a layer was running Feedback Zoom. The export then
   * skipped the feedback preroll but still set `prerolled`, which made the
   * first real frame declare itself NOT the first — so the surface was never
   * reset and every export inherited the previous one's history. Two runs of
   * the same export stopped matching, while the evaluator stayed identical to
   * six decimals.
   */
  get isFeedbackTechnique(): boolean {
    if ((this.techniqueRenderer as { feedback?: boolean } | null)?.feedback === true) return true;
    return false;
  }

  get isLiveTemporalMode(): boolean {
    return this.liveSourceActive;
  }

  get isTemporalActive(): boolean {
    return this.temporalEnabled && this.temporal !== null;
  }

  /**
   * EXPORT path (§3): rebuild the history from exact composition timestamps.
   * Never reuses preview contents. Returns the sample schedule for tests.
   */
  async prepareTemporalForExport(
    compositionTime: number,
    isFirstFrame: boolean,
  ): Promise<{ logicalSlot: number; sourceTime: number }[]> {
    if (!this.temporal || !this.temporalEnabled || !this.renderer || !this.temporalSource)
      return [];
    this.exportMode = true;
    return isFirstFrame
      ? this.temporal.primeExact(
          this.renderer,
          compositionTime,
          this.temporalSource,
          this.boundaryMode,
        )
      : this.temporal.advanceExact(
          this.renderer,
          compositionTime,
          this.temporalSource,
          this.boundaryMode,
        );
  }

  /** Enter export mode: preview rendering pauses for the whole export, not
   * just temporal-active ones (see loop()). */
  beginExportMode(): void {
    this.exportMode = true;
  }

  /** Leave export mode and discard export-primed history (§13). */
  endExportMode(): void {
    this.exportMode = false;
    this.techniqueStageOverrides = new Map();
    this.resolvedStageParams = {};
    // Resolved export values must not survive into the preview, or a layer
    // keeps rendering the last exported frame’s parameters.
    this.temporal?.invalidate();
    this.invalidate();
  }

  setShowOriginal(show: boolean): void {
    this.showOriginal = show;
    this.invalidate();
  }

  setSeed(seed: number): void {
    this.seed = seed;
    this.invalidate();
  }

  setTime(timeSec: number): void {
    // One composition clock. Every branch reads the same time, which is what
    // keeps layers in step with each other and with export.
    this.timeSec = timeSec;
    this.invalidate();
  }

  // ---- view transform ----

  invalidate(): void {
    this.dirty = true;
  }

  /**
   * A serial layer with no technique of its own shows its input unchanged. The
   * quad may not exist (no source) and the accumulator ping-pongs between two
   * targets, so it is created on demand and re-pointed every frame.
   */
  private pointOriginalQuadAt(texture: THREE.Texture): void {
    if (!this.originalQuad) {
      this.originalQuad = new THREE.Mesh(
        new THREE.PlaneGeometry(this.compWidth, this.compHeight),
        new THREE.MeshBasicMaterial({ map: texture }),
      );
      this.originalQuad.visible = false;
      this.scene.add(this.originalQuad);
      return;
    }
    (this.originalQuad.material as THREE.MeshBasicMaterial).map = texture;
  }

  private rebuildOriginalQuad(): void {
    if (this.originalQuad) {
      this.scene.remove(this.originalQuad);
      this.originalQuad.geometry.dispose();
      (this.originalQuad.material as THREE.Material).dispose();
      this.originalQuad = null;
    }
    if (!this.sourceTexture) return;
    this.originalQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(this.compWidth, this.compHeight),
      new THREE.MeshBasicMaterial({ map: this.sourceTexture }),
    );
    this.originalQuad.visible = false;
    this.scene.add(this.originalQuad);
  }

  private updateCamera(aspect: number): void {
    // Perspective amount maps to fov; camera distance always frames the
    // composition height exactly at z=0, so depth=0 renders identically
    // regardless of the perspective setting.
    const fovDeg = 8 + this.perspectiveAmount * 42;
    this.camera.fov = fovDeg;
    this.camera.aspect = aspect;
    const distance = this.compHeight / 2 / Math.tan((fovDeg * Math.PI) / 360);
    this.camera.position.set(0, 0, distance);
    this.camera.near = Math.max(distance / 100, 1);
    this.camera.far = distance * 4;
    this.camera.updateProjectionMatrix();
  }

  private readonly blitCamera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);

  /** What technique shaders sample: the source itself, or its sRGB-correct copy for video. */
  private techniqueSource(): THREE.Texture | null {
    // The composite beneath is a render target: already sRGB-decoded on sample.
    if (this.inputOverride) return this.inputOverride;
    const source = this.sourceTexture;
    const video = (source as { isVideoTexture?: boolean } | null)?.isVideoTexture === true;
    if (!source || !video || !this.renderer) {
      this.videoIngest?.dispose();
      this.videoIngest = null;
      return source;
    }
    const el = (source as { image?: { videoWidth?: number; videoHeight?: number } }).image;
    this.videoIngest ??= new VideoIngest();
    this.videoIngest.update(this.renderer, source, el?.videoWidth ?? 0, el?.videoHeight ?? 0);
    return this.videoIngest.texture();
  }

  private syncScene(paramsOverride?: ParamRecord): void {
    const showProcessed = !this.showOriginal;
    if (this.inputOverride) this.pointOriginalQuadAt(this.inputOverride);
    // No technique = the source passes through untouched, not a blank layer.
    if (this.originalQuad) this.originalQuad.visible = !showProcessed || !this.techniqueRenderer;
    if (this.techniqueRenderer) {
      this.techniqueRenderer.object3d.visible = showProcessed;
      if (showProcessed && this.materialState) {
        // In export, resolved values come from authority and from nowhere
        // else. Falling through to the live transform let a branch sync its
        // scene from the PREVIEW runtime mid-render — which reads wall time —
        // and two runs of the same export stopped matching.
        const params =
          paramsOverride ??
          (this.paramTransform && !this.exportMode
            ? this.paramTransform(this.techniqueParams, this.timeSec)
            : this.techniqueParams);
        // RuntimeBus seam (18A): the live pass publishes its evaluated frame.
        // renderStill/export pass paramsOverride and never reach the bus —
        // export isolation is preserved by construction.
        this.lastResolvedParams = params;
        // A runtime NEVER publishes. The composition publishes once, from
        // RenderEngine.publishComposition(), with the whole stack attached.
        // Deleting the seam rather than guarding it is what makes that a
        // structural fact: there is exactly one emitFrame call in the tree.
        this.techniqueRenderer.update(params, {
          sourceTexture: this.techniqueSource(),
          materialTexture: this.materialTexture,
          temporal: this.temporalEnabled && this.temporal ? this.temporal.getUniforms() : null,
          flow: this.flow?.texture() ?? null,
          compWidth: this.compWidth,
          compHeight: this.compHeight,
          material: this.materialState,
          timeSec: this.timeSec,
          seed: this.seed,
          renderer: this.renderer,
        });
      }
    }
  }

  private renderTechniqueChain(
    target: THREE.WebGLRenderTarget,
    clear: boolean,
    paramsOverride?: ParamRecord,
  ): boolean {
    const renderer = this.renderer;
    const primary = this.techniqueRenderer;
    const material = this.materialState;
    const scratch = this.techniqueScratchTargets;
    const chainBehavior = primary?.chainBehavior;
    if (
      !renderer || !primary || !material || this.techniqueChain.length === 0 || !scratch ||
      (chainBehavior !== 'stateless' && chainBehavior !== 'flow') || this.temporalEnabled
    ) return false;

    const primaryParams = paramsOverride ?? (this.paramTransform && !this.exportMode
      ? this.paramTransform(this.techniqueParams, this.timeSec)
      : this.techniqueParams);
    const stages = [
      { renderer: primary, params: primaryParams },
      ...this.techniqueChain,
    ];
    this.resolvedStageParams = {};
    let passIndex = 0;
    const previousTarget = renderer.getRenderTarget();
    const previousScissorTest = renderer.getScissorTest();
    const visibility = new Map(this.scene.children.map((child) => [child, child.visible]));
    try {
      this.scene.children.forEach((child) => { child.visible = false; });
      renderTechniqueChainPasses(
        this.techniqueSource(),
        stages,
        scratch,
        (stage, input, output) => {
          const stageId = 'stageId' in stage ? String(stage.stageId) : null;
          const overrides = stageId ? this.techniqueStageOverrides.get(stageId) : undefined;
          const params = stage.renderer === primary
            ? stage.params
            : this.paramTransform && !this.exportMode && stageId
              ? this.paramTransform({ ...stage.params, ...(overrides ?? {}) }, this.timeSec, stageId)
              : { ...stage.params, ...(overrides ?? {}) };
          if (stageId) this.resolvedStageParams[stageId] = params;
          stage.renderer.object3d.visible = true;
          stage.renderer.update(params, {
            sourceTexture: input,
            materialTexture: this.materialTexture,
            temporal: null,
            // Flow remains measured from original layer input by contract.
            flow: this.flow?.texture() ?? null,
            compWidth: this.compWidth,
            compHeight: this.compHeight,
            material,
            timeSec: this.timeSec,
            seed: this.seed,
            renderer,
          });
          if (stage.renderer === primary) this.lastResolvedParams = params;
          bindTarget(renderer, output);
          const isFinal = passIndex === stages.length - 1;
          if (!isFinal || clear) {
            renderer.setClearColor(0x000000, 0);
            renderer.clear();
          }
          renderer.render(this.scene, this.camera);
          stage.renderer.object3d.visible = false;
          passIndex++;
        },
        target,
      );
      return true;
    } finally {
      for (const [child, visible] of visibility) child.visible = visible;
      renderer.setRenderTarget(previousTarget);
      renderer.setScissorTest(previousScissorTest);
    }
  }

  /**
   * Deterministic offscreen render at arbitrary resolution (export path,
   * Explore thumbnails). Optional paramsOverride bypasses the live modulation
   * transform. Returns tightly packed RGBA bytes, top row first.
   */
  /** CE1F export seam: render the generator's exact frame for this
   * composition time before the still is taken (deterministic, no decoder). */
  /** Composition time of the frame before the current export frame — used
   * to prime motion analysis at a subrange boundary. */
  private exportPrevSourceSec: number | null = null;

  setExportPreviousTime(sec: number | null): void {
    this.exportPrevSourceSec = sec;
  }

  prepareGeneratorForExport(compositionTime: number, width: number, height: number): void {
    const renderer = this.renderer;
    if (!renderer || !this.generator) return;
    const prevW = this.compWidth;
    const prevH = this.compHeight;
    // Procedural scale semantics are normalized: render at the export size.
    this.compWidth = width;
    this.compHeight = height;
    this.renderGenerator(renderer, compositionTime, true);
    this.compWidth = prevW;
    this.compHeight = prevH;
  }
}

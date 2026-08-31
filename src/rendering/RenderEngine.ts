import * as THREE from 'three';
import { bindTarget } from './bindTarget';
import type { MaterialState, ParamRecord } from '@shared/schemas/project';
import type { TechniqueRenderer } from '@/techniques/types';
import { OpticalFlowField } from './flow/OpticalFlowField';
import { ImageStatsReducer } from './analysis/ImageStatsReducer';
import { demandNeedsFlow } from '@/signals/visual/demand';
import type { RawVisualStats, VisualSignalId } from '@/signals/visual/types';
import {
  TransitionCompositor,
  type TransitionParams,
} from './transition/TransitionCompositor';
import { runtimeBus } from '@/runtime/RuntimeBus';
import { LayerCompositor, type CompositeLayer } from './layers/LayerCompositor';
import type { LayerRenderState } from './layers/layerTypes';
import {
  TemporalFrameProvider,
  type BoundaryMode,
  type TemporalConfig,
  type TemporalSource,
  type TemporalStats,
} from './temporal/TemporalFrameProvider';

export interface ViewTransform {
  zoom: number; // composition px → CSS px
  panX: number; // CSS px offset of composition center from viewport center
  panY: number;
}

export interface EngineStats {
  fps: number;
  frameTimeMs: number;
  instanceCount: number;
  rendererName: string;
}

const FIT_MARGIN = 0.94;

/** Shared empty set: a branch that is not the measured one allocates nothing. */
const EMPTY_VISUAL_DEMAND: ReadonlySet<VisualSignalId> = new Set();

/**
 * GPU render engine. Lives outside React — React (and the store bridge) push
 * state in via setters; the engine renders on demand in its own rAF loop.
 */
export class RenderEngine {
  private renderer: THREE.WebGLRenderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(20, 1, 10, 100000);

  private sourceTexture: THREE.Texture | null = null;
  private materialTexture: THREE.Texture | null = null;
  private temporal: TemporalFrameProvider | null = null;
  private temporalEnabled = false;
  private temporalSource: TemporalSource | null = null;
  private boundaryMode: BoundaryMode = 'clamp';
  /** While true the preview capture path is disabled (export owns the buffer). */
  private exportMode = false;
  private originalQuad: THREE.Mesh | null = null;
  private techniqueRenderer: TechniqueRenderer | null = null;
  private techniqueParams: ParamRecord = {};
  private materialState: MaterialState | null = null;

  private compWidth = 1920;
  private compHeight = 1080;
  private compBackground = '#000000';
  private wellColor = '#08090a';
  private checkerboard = false;
  private showOriginal = false;
  private perspectiveAmount = 0.35;
  private seed = 1;

  view: ViewTransform = { zoom: 0.5, panX: 0, panY: 0 };

  /** Optional per-frame parameter transform (modulation). */
  private paramTransform: ((base: ParamRecord, timeSec: number) => ParamRecord) | null = null;

  private frameSink: (() => void) | null = null;

  /**
   * v0.6E — one message per frame, carrying the whole stack.
   *
   * The Output is a replica of the COMPOSITION, so it needs every layer's
   * resolved parameters and every layer's resolved opacity — a signal may be
   * driving either, and the replica must never work that out for itself.
   * `finalParams` stays the selected layer's, so everything that read it
   * before layers still reads the same thing.
   */
  private publishComposition(): void {
    if (this.exportMode || this.branches.length === 0) return;
    const selected = this.branches[this.selectedLayerIndex] ?? this.branches[0];
    if (!selected) return;
    const layerParams: Record<string, ParamRecord> = {};
    const layerOpacity: Record<string, number> = {};
    // A generator's SOURCE parameters are a different set from its layer's
    // technique parameters, and the replica drives its local generator with
    // them. Sending only the technique's produced a flat grey image in the
    // Output while the editor showed a moving pattern.
    const layerSourceParams: Record<string, ParamRecord> = {};
    for (const [i, b] of this.branches.entries()) {
      const resolved = b.engine.lastResolved;
      if (resolved) layerParams[b.id] = resolved;
      layerOpacity[b.id] = this.effectiveOpacity(i);
      if (b.engine.hasGenerator) layerSourceParams[b.id] = b.engine.resolvedSourceParams();
    }
    const primary = selected.engine.lastResolved;
    if (!primary) return;
    runtimeBus.emitFrame(
      this.timeSec,
      primary,
      selected.engine.isTemporalActive,
      selected.engine.hasGenerator ? selected.engine.resolvedSourceParams() : undefined,
      this.transitionState
        ? {
            generation: this.transitionGeneration,
            progress: this.transitionState.progress,
            style: this.transitionState.params.style,
            params: { ...this.transitionState.params } as unknown as Record<string, number>,
          }
        : undefined,
      { layerParams, layerOpacity, layerSourceParams },
    );
  }

  /** Read by the host when it publishes the stack. */
  get lastResolved(): ParamRecord | null {
    return this.lastResolvedParams;
  }

  /** What this engine last resolved for its technique — the host reads it
   * off each branch to publish the stack in one message. */
  private lastResolvedParams: ParamRecord | null = null;

  get compositionWidth(): number {
    return this.compWidth;
  }

  get compositionHeight(): number {
    return this.compHeight;
  }

  /** Composition time, for authority that resolves values against it. */
  get currentTimeSec(): number {
    return this.timeSec;
  }

  /** Called once per rendered frame, before anything resolves a value. */
  setFrameSink(fn: (() => void) | null): void {
    this.frameSink = fn;
  }

  setParamTransform(fn: ((base: ParamRecord, timeSec: number) => ParamRecord) | null): void {
    this.paramTransform = fn;
    this.invalidate();
  }

  /**
   * v0.6B — how a branch resolves ITS parameters. Held as a factory so a layer
   * added later is wired the same way as one that existed at startup, without
   * the bridge having to re-push after every add.
   */
  private layerParamTransform:
    | ((layerId: string) => (base: ParamRecord, timeSec: number) => ParamRecord)
    | null = null;

  setLayerParamTransform(
    make: ((layerId: string) => (base: ParamRecord, timeSec: number) => ParamRecord) | null,
  ): void {
    this.layerParamTransform = make;
    for (const b of this.branches) b.engine.setParamTransform(make ? make(b.id) : null);
  }

  private dirty = true;
  private liveSourceActive = false;
  private rafId = 0;
  private lastFrameTime = 0;
  private fpsEma = 0;
  private timeSec = 0;

  // ---- lifecycle ----

  init(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    // A remount (StrictMode's double effect, a workspace switch, a restored
    // context) builds a NEW renderer. Any branch still holding the previous
    // one would draw into framebuffers this renderer cannot read.
    const adopting = this.branches.length > 0;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    // Context loss seam (18A): preventDefault on loss allows the browser to
    // restore the context; Three rebuilds its GL state on restore, but the
    // temporal atlas render target's CONTENTS are gone — drop the history so
    // techniques never sample garbage as if it were real frames.
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    if (adopting) {
      // Re-point survivors and drop their targets: a target allocated by the
      // previous renderer is unreadable by this one.
      for (const b of this.branches) {
        b.engine.initBranch(this.renderer);
        b.target?.dispose();
        b.target = null;
      }
      this.applyBranchVisualDemand();
    }
    this.loop();
  }

  // ---- v0.6: the composition this engine hosts --------------------------

  /**
   * Layer branches, bottom first. Every layer is a RenderEngine in branch
   * mode — including the first, so no layer is special. The host owns the
   * canvas, the loop, the view and the compositor; it owns no creative state
   * of its own.
   */
  private branches: { id: string; engine: RenderEngine; target: THREE.WebGLRenderTarget | null }[] =
    [];
  private layerStates: LayerRenderState[] = [];
  private selectedLayerIndex = 0;
  private readonly layerCompositor = new LayerCompositor();

  /** The branch that single-branch API calls act on (the selected layer). */
  private get activeBranch(): RenderEngine | null {
    return this.branches[this.selectedLayerIndex]?.engine ?? null;
  }

  /**
   * v0.6B — ONE acquisition, every layer that shows it.
   *
   * A camera or a screen capture is a physical device: it is acquired once, no
   * matter how many layers display it. The manager that owns the device
   * publishes its texture here; the bridge has already said which layers are
   * showing that kind, and every one of them gets the same texture object. Two
   * layers on one camera therefore cost one `getUserMedia`, one decode and —
   * because they share a pixel origin — one calibration envelope.
   */
  private liveTextures = new Map<'camera' | 'capture', THREE.Texture | null>();
  private liveLayerKinds = new Map<string, 'camera' | 'capture'>();

  setLiveSource(kind: 'camera' | 'capture', texture: THREE.Texture | null): void {
    this.liveTextures.set(kind, texture);
    this.distributeLiveSources();
  }

  /** Which layers display a live device, decided by the bridge from project
   * state. Replaces the map wholesale so a removed layer stops being fed. */
  setLiveLayerKinds(kinds: ReadonlyMap<string, 'camera' | 'capture'>): void {
    this.liveLayerKinds = new Map(kinds);
    this.distributeLiveSources();
  }

  private distributeLiveSources(): void {
    for (const b of this.branches) {
      const kind = this.liveLayerKinds.get(b.id);
      if (!kind) continue;
      const texture = this.liveTextures.get(kind) ?? null;
      b.engine.setSource(texture);
      b.engine.setLiveSourceActive(texture !== null);
    }
    this.invalidate();
  }

  /** Branch for a layer id, for the bridge to configure directly. */
  branchFor(layerId: string): RenderEngine | null {
    return this.branches.find((b) => b.id === layerId)?.engine ?? null;
  }

  get layerCount(): number {
    return this.branches.length;
  }

  get layerIds(): string[] {
    return this.branches.map((b) => b.id);
  }

  /** Diagnostics: composite draws and the memory the accumulators hold. */
  get compositorStats(): { passes: number; bytes: number; layerTargetBytes: number } {
    const layerBytes = this.branches.reduce(
      (n, b) => n + (b.target ? b.target.width * b.target.height * 4 : 0),
      0,
    );
    return {
      passes: this.layerCompositor.passes,
      bytes: this.layerCompositor.bytes,
      layerTargetBytes: layerBytes,
    };
  }

  /**
   * Reconcile the branch list with the project's layers.
   *
   * Identity is the layer ID, never the index: reordering rebuilds no runtime,
   * so a feedback surface or a simulation survives being moved up the stack.
   * A branch is created lazily on first appearance and disposed when its layer
   * goes away — nothing else touches another layer's resources.
   */
  syncLayers(states: readonly LayerRenderState[]): void {
    const renderer = this.renderer;
    const next: typeof this.branches = [];
    for (const state of states) {
      const existing = this.branches.find((b) => b.id === state.id);
      if (existing) {
        next.push(existing);
        continue;
      }
      const engine = new RenderEngine();
      if (renderer) engine.initBranch(renderer);
      if (this.layerParamTransform) engine.setParamTransform(this.layerParamTransform(state.id));
      next.push({ id: state.id, engine, target: null });
    }
    for (const previous of this.branches) {
      if (next.some((b) => b.id === previous.id)) continue;
      previous.engine.disposeBranch();
      previous.target?.dispose();
    }
    this.branches = next;
    this.layerStates = [...states];
    const selected = states.findIndex((s) => s.selected);
    this.selectedLayerIndex = selected >= 0 ? selected : 0;
    // Global state belongs to every branch.
    for (const b of this.branches) {
      b.engine.setComposition(this.compWidth, this.compHeight, this.compBackground);
      b.engine.setSeed(this.seed);
      b.engine.setTime(this.timeSec);
      if (this.exportMode) b.engine.beginExportMode();
    }
    this.applyBranchVisualDemand();
    this.distributeLiveSources();
    this.invalidate();
  }

  private ensureLayerTarget(index: number): THREE.WebGLRenderTarget {
    const slot = this.branches[index];
    const w = Math.max(this.compWidth, 1);
    const h = Math.max(this.compHeight, 1);
    if (!slot) throw new Error('layer index out of range');
    if (!slot.target || slot.target.width !== w || slot.target.height !== h) {
      slot.target?.dispose();
      slot.target = new THREE.WebGLRenderTarget(w, h, {
        depthBuffer: false,
        stencilBuffer: false,
        colorSpace: THREE.SRGBColorSpace,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
    }
    return slot.target;
  }

  /** Which layers actually contribute a draw this frame. */
  /**
   * v0.6C — the state each layer is actually composited with THIS frame.
   *
   * Stored opacity is the resting value; a `layer.opacity` mapping moves it,
   * the same way a mapping moves a technique parameter. Resolution happens
   * here, once per frame, rather than in the store: a signal-driven value is
   * not project state and must never be written back.
   */
  private layerStateSink:
    | ((layerId: string, opacity: number) => { opacity: number })
    | null = null;

  setLayerStateSink(
    fn: ((layerId: string, opacity: number) => { opacity: number }) | null,
  ): void {
    this.layerStateSink = fn;
  }

  private effectiveOpacity(index: number): number {
    const state = this.layerStates[index];
    if (!state) return 0;
    // Authority first: during an export, and in the Output replica, the value
    // has already been resolved elsewhere and this engine must not re-derive
    // it. Checking the live sink first meant the replica ignored the resolved
    // opacity it had just been sent.
    const authority = this.authorityLayerOpacity?.get(state.id);
    if (authority !== undefined) return authority;
    if (!this.layerStateSink) return state.opacity;
    return this.layerStateSink(state.id, state.opacity).opacity;
  }

  /** What a layer is ACTUALLY being composited at, for the performance UI.
   * Null when the layer is unknown, so the strip can tell "not modulated"
   * apart from "modulated to exactly the stored value". */
  resolvedOpacity(layerId: string): number | null {
    const index = this.layerStates.findIndex((s) => s.id === layerId);
    return index < 0 ? null : this.effectiveOpacity(index);
  }

  /** EXPORT authority: resolved opacities, resolved by the export evaluator. */
  private authorityLayerOpacity: ReadonlyMap<string, number> | undefined;

  setAuthorityLayerOpacity(byLayer: ReadonlyMap<string, number> | undefined): void {
    this.authorityLayerOpacity = byLayer;
  }

  private visibleLayers(): number[] {
    const out: number[] = [];
    for (const [i, state] of this.layerStates.entries()) {
      if (!state.enabled) continue;
      // Opacity 0 still RENDERS: a stateful branch that stopped would lose the
      // feedback or simulation it has been accumulating, and fading back in
      // would start from nothing. It just contributes nothing to the result.
      if (!this.branches[i]) continue;
      out.push(i);
    }
    return out;
  }

  /**
   * Render every visible layer and blend them. Returns the composed texture,
   * or null when nothing is visible.
   */
  /**
   * True when the composition is exactly one fully opaque Normal layer.
   *
   * The compositor is then mathematically a no-op — `mix(bg, layer, layer.a)`
   * is what drawing that layer straight onto the cleared background already
   * produces — so the layer renders directly into the destination and skips
   * both the layer target and the accumulator.
   *
   * That is not an optimisation dressed up as a rule: routing through two more
   * 8-bit sRGB targets cost up to one code on 0.45% of bytes against the
   * pre-v0.6 render. Measured, small, and still not zero — and a v3 project
   * that migrates has to render EXACTLY as it did.
   */
  private singleOpaqueLayer(): number | null {
    const visible = this.visibleLayers();
    if (visible.length !== 1) return null;
    const only = visible[0] as number;
    const state = this.layerStates[only];
    if (!state || state.blendMode !== 'normal') return null;
    // Resolved, not stored: a layer faded by a signal must go through the
    // compositor even though the project still says 1.
    if (this.effectiveOpacity(only) < 1) return null;
    return only;
  }

  /**
   * Draw the composition straight into the bound target. Returns false when
   * the fast path does not apply and the caller must composite.
   */
  private renderDirectLayer(
    renderer: THREE.WebGLRenderer,
    paramsByLayer: ReadonlyMap<string, ParamRecord> | undefined,
  ): boolean {
    const index = this.singleOpaqueLayer();
    if (index === null) return false;
    const slot = this.branches[index]!;
    const override = paramsByLayer?.get(slot.id);
    const target = renderer.getRenderTarget();
    if (!target) return false;
    if (override) slot.engine.renderLayerToWithParams(target, override, false);
    else slot.engine.renderLayerTo(target, { clear: false });
    return true;
  }

  private renderComposition(
    renderer: THREE.WebGLRenderer,
    transparent: boolean,
    override?: ReadonlyMap<string, ParamRecord>,
  ): THREE.Texture | null {
    // The Output replica evaluates nothing: its parameters arrive resolved and
    // are held as authority values, so the ordinary preview path has to reach
    // for them exactly as the export path does.
    const paramsByLayer = override ?? this.authorityLayerParams;
    const indices = this.visibleLayers();
    const composed: CompositeLayer[] = [];
    for (const i of indices) {
      const slot = this.branches[i]!;
      const state = this.layerStates[i]!;
      const target = this.ensureLayerTarget(i);
      const override = paramsByLayer?.get(state.id);
      if (override) {
        slot.engine.renderLayerToWithParams(target, override);
      } else {
        slot.engine.renderLayerTo(target, { clear: true });
      }
      composed.push({
        texture: target.texture,
        opacity: this.effectiveOpacity(i),
        blendMode: state.blendMode,
      });
    }
    return this.layerCompositor.composite(renderer, composed, this.compWidth, this.compHeight, {
      color: transparent ? '#000000' : this.compBackground,
      alpha: transparent ? 0 : 1,
    });
  }

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
    this.isBranch = true;
  }

  /** True when this engine is a layer inside a composition, not the host. */
  private isBranch = false;

  get branchMode(): boolean {
    return this.isBranch;
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
    try {
      // Neither setPixelRatio nor setViewport belongs here — see bindTarget.
      if (this.temporalEnabled && this.temporal && this.sourceTexture && !this.exportMode) {
        const temporalClock = this.liveSourceActive ? performance.now() / 1000 : this.timeSec;
        this.temporal.advancePreview(renderer, temporalClock, this.sourceTexture);
      }
      this.updateCamera(target.width / Math.max(target.height, 1));
      if (!this.exportMode) this.renderGenerator(renderer, this.timeSec);
      if (!this.exportMode) this.updateFlowService(renderer);
      this.syncScene();
      if (!this.exportMode) this.updateVisualStats(renderer);
      if (this.feedbackActive) {
        (
          this.techniqueRenderer as unknown as {
            feedbackPrepass?: (r: THREE.WebGLRenderer, clockSec: number) => void;
          }
        ).feedbackPrepass?.(renderer, performance.now() / 1000);
      }
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
    if (this.temporalEnabled && this.temporal && this.sourceTexture && !this.exportMode) {
      const temporalClock = this.liveSourceActive ? performance.now() / 1000 : this.timeSec;
      this.temporal.advancePreview(renderer, temporalClock, this.sourceTexture);
    }
    if (!this.exportMode) this.renderGenerator(renderer, this.timeSec);
    if (!this.exportMode) this.updateFlowService(renderer);
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
    try {
      this.updateCamera(target.width / Math.max(target.height, 1));
      this.syncScene(params);
      bindTarget(renderer, target);
      if (clear) {
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
      }
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.setRenderTarget(prevTarget);
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
    this.originalQuad?.geometry.dispose();
    (this.originalQuad?.material as THREE.Material | undefined)?.dispose();
    this.originalQuad = null;
    this.rvfcCancel?.();
    this.rvfcCancel = null;
    this.sourceTexture = null;
    // The renderer is the composition's, never this branch's.
    this.renderer = null;
  }

  /** Branch-side restore, driven by the host (a branch has no canvas). */
  handleContextRestored(): void {
    this.onContextRestored();
  }

  private onContextLost = (event: Event): void => {
    event.preventDefault();
    console.warn('[engine] WebGL context lost — awaiting restore');
  };

  private onContextRestored = (): void => {
    console.warn('[engine] WebGL context restored — rebuilding GPU state');
    // CE1H §57: marking state stale is not enough. Every render target
    // allocated on the LOST context is a dead GL handle, and the first pass
    // that touches one raises INVALID_OPERATION (measured: 1282 after
    // restore on Time Field, Motion Mosh and Reaction Diffusion). The
    // targets have to be reallocated, not just emptied.
    if (this.temporal) {
      const config = this.temporal.config;
      this.temporal.dispose();
      this.temporal = new TemporalFrameProvider(config);
    }
    this.flow?.dispose();
    this.flow = null; // updateFlowService rebuilds it on demand
    this.compositor.release();
    this.visualStats?.dispose();
    this.visualStats = null;
    this.latestVisual = null;
    this.resetFeedback();
    (
      this.techniqueRenderer as { onContextRestored?: () => void } | null
    )?.onContextRestored?.();
    // v0.6: every layer allocated its targets on the SAME lost context, so
    // each branch has to rebuild too. The host owns the canvas listener; the
    // branches never see the event and would otherwise keep dead handles.
    this.layerCompositor.release();
    for (const b of this.branches) {
      b.target?.dispose();
      b.target = null;
      b.engine.handleContextRestored();
    }
    this.invalidate();
  };

  dispose(): void {
    this.canvas?.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas?.removeEventListener('webglcontextrestored', this.onContextRestored);
    cancelAnimationFrame(this.rafId);
    // Branches hold render targets and programs that belong to the renderer
    // about to be destroyed. Leaving them behind orphans every layer: they
    // keep drawing into the OLD renderer's framebuffers while the host reads
    // the new one's, and the composition goes silently black.
    for (const b of this.branches) {
      b.engine.disposeBranch();
      b.target?.dispose();
    }
    this.branches = [];
    this.layerStates = [];
    this.layerCompositor.dispose();
    this.temporal?.dispose();
    this.temporal = null;
    this.techniqueRenderer?.dispose();
    this.originalQuad?.geometry.dispose();
    (this.originalQuad?.material as THREE.Material | undefined)?.dispose();
    this.renderer?.dispose();
    this.renderer = null;
    this.canvas = null;
  }

  // ---- state setters (bridge pushes project state here) ----

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
    for (const b of this.branches) b.engine.setComposition(width, height, background);
    const changed = width !== this.compWidth || height !== this.compHeight;
    this.compWidth = width;
    this.compHeight = height;
    this.compBackground = background;
    if (changed) {
      this.rebuildOriginalQuad();
      this.fit();
    }
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
  private get branchesAnimating(): boolean {
    for (const b of this.branches) {
      const e = b.engine;
      if (e.liveSourceActive || e.feedbackActive || e.generatorActive) return true;
    }
    return false;
  }

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
    for (const b of this.branches) b.engine.resetTemporal();
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
    if (!r) return false;
    if (r.usesFlow === true) return true;
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
    return `${this.sourceTexture?.uuid ?? 'none'}:${this.sourceFrameCounter}:${this.generatorRevision}`;
  }

  private updateFlowService(renderer: THREE.WebGLRenderer, frameKey?: string): void {
    if (!this.flowIsNeeded()) {
      if (this.flow) {
        // Demand-driven (§77): nothing needs flow — release the targets.
        this.flow.dispose();
        this.flow = null;
      }
      return;
    }
    if (!this.flow) this.flow = new OpticalFlowField();
    const img = (this.sourceTexture as { image?: { videoWidth?: number; width?: number; videoHeight?: number; height?: number } } | null)?.image;
    const w = img?.videoWidth ?? img?.width ?? 0;
    const h = img?.videoHeight ?? img?.height ?? 0;
    this.flow.update(renderer, this.sourceTexture, w, h, frameKey ?? this.sourceFrameKey());
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
    if (this.branches.length > 0) {
      for (const b of this.branches) {
        b.engine.prepareFlowForExport(
          compositionTime,
          `${b.id}:${frameKey}`,
          isFirstFrame,
          width,
          height,
          this.authorityLayerParams?.get(b.id),
        );
      }
      return;
    }
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
        this.updateFlowService(renderer, `${frameKey}:pre`);
        // Put the source back on THIS frame before the second tap, or the
        // pair holds the previous frame twice and the flow is zero.
        this.prepareGeneratorForExport(compositionTime, width, height);
      }
    }
    this.updateFlowService(renderer, frameKey);
    if (params) this.syncScene(params); // rebind ctx.flow after compute
  }

  // ---- v0.4A: image / motion signal analysis -------------------------------
  private visualStats: ImageStatsReducer | null = null;
  private visualDemand: ReadonlySet<VisualSignalId> = new Set();
  private latestVisual: RawVisualStats | null = null;
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
    }
    // In layer mode the branches own the source textures, so the host has
    // nothing to measure. v0.6A keeps the v0.5 meaning of a visual signal by
    // measuring the SELECTED layer; every other branch is told to release its
    // analysis targets. v0.6B replaces this with explicit per-layer routing.
    this.applyBranchVisualDemand();
    this.invalidate();
  }

  /**
   * v0.6B — each layer analyses only what something actually reads from it.
   *
   * Authority pushes a per-layer demand map: a layer nobody routes from
   * analyses nothing and releases its reduction targets. Until a map arrives
   * (or for a project with no routes at all) the selected layer carries the
   * whole demand, which is what a visual signal meant before layers.
   */
  private layerVisualDemand: ReadonlyMap<string, ReadonlySet<VisualSignalId>> | null = null;

  setVisualDemandByLayer(byLayer: ReadonlyMap<string, ReadonlySet<VisualSignalId>>): void {
    this.layerVisualDemand = byLayer;
    this.applyBranchVisualDemand();
    this.invalidate();
  }

  private applyBranchVisualDemand(): void {
    if (this.branches.length === 0) return;
    const byLayer = this.layerVisualDemand;
    const active = this.activeBranch;
    for (const b of this.branches) {
      const demand = byLayer
        ? (byLayer.get(b.id) ?? EMPTY_VISUAL_DEMAND)
        : b.engine === active
          ? this.visualDemand
          : EMPTY_VISUAL_DEMAND;
      const id = b.id;
      b.engine.setVisualSink(
        demand.size > 0 ? (stats) => this.onBranchVisual(id, stats) : null,
      );
      b.engine.setVisualDemand(demand);
    }
  }

  private onBranchVisual(layerId: string, stats: RawVisualStats | null): void {
    if (this.activeBranch === this.branchFor(layerId)) this.latestVisual = stats;
    this.layerVisualSink?.(layerId, stats);
  }

  /** Where per-layer analysis goes. Authority wires this from the bridge. */
  private layerVisualSink: ((layerId: string, stats: RawVisualStats | null) => void) | null = null;

  setLayerVisualSink(
    fn: ((layerId: string, stats: RawVisualStats | null) => void) | null,
  ): void {
    this.layerVisualSink = fn;
  }

  get visualSignalStats(): RawVisualStats | null {
    return this.latestVisual;
  }

  get visualDiagnostics(): { reductions: number; bytes: number; width: number; height: number } | null {
    if (this.branches.length > 0) return this.activeBranch?.visualDiagnostics ?? null;
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
    const img = (
      this.sourceTexture as {
        image?: { videoWidth?: number; width?: number; videoHeight?: number; height?: number };
      } | null
    )?.image;
    const w = img?.videoWidth ?? img?.width ?? 0;
    const h = img?.videoHeight ?? img?.height ?? 0;
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
      if (now - this.lastVisualMs < 1000 / RenderEngine.VISUAL_HZ) return;
      this.lastVisualMs = now;
    }
    const grid = this.visualGrid();
    if (!grid) return;
    if (!this.visualStats) this.visualStats = new ImageStatsReducer();
    const next = this.visualStats.analyse(
      renderer,
      this.sourceTexture,
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
    if (next !== this.latestVisual) {
      this.latestVisual = next;
      this.visualSink?.(next);
    }
  }

  /** EXPORT: analyse this frame, keyed by GLOBAL frame so a subrange drives the
   * reducer exactly as a full export does. */
  updateVisualStatsForExport(frameKey: string): void {
    if (this.branches.length > 0) {
      // Each layer analyses its OWN source; the frame key is namespaced so two
      // layers cannot share a cache entry.
      for (const b of this.branches) b.engine.updateVisualStatsForExport(`${b.id}:${frameKey}`);
      return;
    }
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

  /** Temporal history anywhere in the stack, for the same reason. */
  get isTemporalActiveAnywhere(): boolean {
    return this.isTemporalActive || this.branches.some((b) => b.engine.isTemporalActive);
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
    if (this.branches.length > 0) {
      // Feedback is per branch: each layer's surface has its own history and
      // must be prerolled on its own.
      for (const b of this.branches) {
        b.engine.prepareFeedbackForExport(
          compositionTime,
          isFirstFrame,
          this.authorityLayerParams?.get(b.id),
        );
      }
      return;
    }
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
    return this.branches.some((b) => b.engine.isFeedbackTechnique);
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
    if (this.branches.length > 0) {
      // Every layer that samples history primes its own; a subrange export
      // must arrive with each branch carrying the frames a full export would
      // have given it.
      const all: { logicalSlot: number; sourceTime: number }[] = [];
      for (const b of this.branches) {
        all.push(...(await b.engine.prepareTemporalForExport(compositionTime, isFirstFrame)));
      }
      return all;
    }
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
    for (const b of this.branches) b.engine.beginExportMode();
    this.exportMode = true;
  }

  /** Leave export mode and discard export-primed history (§13). */
  endExportMode(): void {
    for (const b of this.branches) b.engine.endExportMode();
    this.exportMode = false;
    // Resolved export values must not survive into the preview, or a layer
    // keeps rendering the last exported frame’s parameters.
    this.authorityLayerParams = undefined;
    this.authorityLayerOpacity = undefined;
    this.temporal?.invalidate();
    this.invalidate();
  }

  setShowOriginal(show: boolean): void {
    this.showOriginal = show;
    this.invalidate();
  }

  setCheckerboard(on: boolean): void {
    this.checkerboard = on;
    this.invalidate();
  }

  setSeed(seed: number): void {
    for (const b of this.branches) b.engine.setSeed(seed);
    this.seed = seed;
    this.invalidate();
  }

  setTime(timeSec: number): void {
    // One composition clock. Every branch reads the same time, which is what
    // keeps layers in step with each other and with export.
    for (const b of this.branches) b.engine.setTime(timeSec);
    this.timeSec = timeSec;
    this.invalidate();
  }

  // ---- view transform ----

  invalidate(): void {
    this.dirty = true;
  }

  fit(): void {
    if (!this.canvas) return;
    const { clientWidth, clientHeight } = this.canvas;
    if (clientWidth === 0 || clientHeight === 0) return;
    const zoom =
      Math.min(clientWidth / this.compWidth, clientHeight / this.compHeight) * FIT_MARGIN;
    this.view = { zoom, panX: 0, panY: 0 };
    this.invalidate();
  }

  zoomTo(zoom: number): void {
    this.view = { ...this.view, zoom: Math.min(Math.max(zoom, 0.02), 32) };
    this.invalidate();
  }

  /** Zoom keeping the given CSS-px point (relative to canvas center) stable. */
  zoomAround(factor: number, cx: number, cy: number): void {
    const oldZoom = this.view.zoom;
    const newZoom = Math.min(Math.max(oldZoom * factor, 0.02), 32);
    const scale = newZoom / oldZoom;
    this.view = {
      zoom: newZoom,
      panX: cx - (cx - this.view.panX) * scale,
      panY: cy - (cy - this.view.panY) * scale,
    };
    this.invalidate();
  }

  panBy(dx: number, dy: number): void {
    this.view = { ...this.view, panX: this.view.panX + dx, panY: this.view.panY + dy };
    this.invalidate();
  }

  // ---- stats ----

  getStats(): EngineStats {
    const info = this.renderer?.getContext();
    const instanceCount =
      this.techniqueRenderer && 'instanceCount' in this.techniqueRenderer
        ? (this.techniqueRenderer as { instanceCount: number }).instanceCount
        : 0;
    return {
      fps: Math.round(this.fpsEma),
      frameTimeMs: this.lastFrameTime,
      instanceCount,
      rendererName: info ? String(info.getParameter(info.VERSION)) : 'none',
    };
  }

  // ---- render ----

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

  private renderFrame(): void {
    const renderer = this.renderer;
    const canvas = this.canvas;
    if (!renderer || !canvas) return;

    const dpr = window.devicePixelRatio;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    const devW = Math.round(cssW * dpr);
    const devH = Math.round(cssH * dpr);
    if (canvas.width !== devW || canvas.height !== devH) {
      renderer.setSize(cssW, cssH, false);
    }

    // Composition rect in CSS px — three multiplies by pixelRatio internally.
    const rectW = this.compWidth * this.view.zoom;
    const rectH = this.compHeight * this.view.zoom;
    const rectX = cssW / 2 + this.view.panX - rectW / 2;
    const rectY = cssH / 2 - this.view.panY - rectH / 2; // GL y-up

    // Clear the well.
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, cssW, cssH);
    renderer.setClearColor(this.wellColor, 1);
    renderer.clear();

    // Composition area.
    renderer.setViewport(rectX, rectY, rectW, rectH);
    renderer.setScissor(rectX, rectY, rectW, rectH);
    renderer.setScissorTest(true);
    if (this.checkerboard) {
      renderer.setClearColor('#000000', 0);
    } else {
      renderer.setClearColor(this.compBackground, 1);
    }
    renderer.clear();

    // PREVIEW temporal capture. File sources address history by COMPOSITION
    // time (seekable grid). Live sources (18F) address it by a MONOTONIC
    // wall clock instead: paused transport keeps accumulating, seeks never
    // rewind observed reality, loops never replay it — history is realtime
    // observation, "N seconds before now", which is exactly how the shared
    // shader samples (offsetSeconds behind head). Disabled during export so
    // preview contents can never influence a render (§3).
    if (this.temporalEnabled && this.temporal && this.sourceTexture && !this.exportMode) {
      const temporalClock = this.liveSourceActive ? performance.now() / 1000 : this.timeSec;
      this.temporal.advancePreview(renderer, temporalClock, this.sourceTexture);
      // Restore the on-canvas viewport state clobbered by the capture pass.
      renderer.setViewport(rectX, rectY, rectW, rectH);
      renderer.setScissor(rectX, rectY, rectW, rectH);
      renderer.setScissorTest(true);
    }

    // v0.6: with layers configured the host renders no creative state of its
    // own — every branch draws to its own target and the compositor blends
    // them. The blit below is the only place composition pixels reach the
    // canvas.
    if (this.branches.length > 0) {
      // One opaque Normal layer is the overwhelmingly common case, and it
      // needs no compositor at all: the branch draws straight onto the canvas
      // inside the composition rect, exactly as the pre-layer engine did.
      //
      // Routing it through the compositor instead costs a 1080p layer target,
      // a background clear, a blend pass and a blit — measured at 21 fps
      // against 99 fps for the same single-mosaic project on v0.5.0. The
      // direct path restores it and makes the common case pixel-identical to
      // v0.5 by construction rather than by luck.
      const single = !this.transitionState ? this.singleOpaqueLayer() : null;
      if (single !== null) {
        const slot = this.branches[single]!;
        slot.engine.renderLayerToCanvas(renderer);
        renderer.setScissorTest(false);
        this.publishComposition();
        return;
      }
      const composed = this.renderComposition(renderer, this.checkerboard);
      renderer.setViewport(rectX, rectY, rectW, rectH);
      renderer.setScissor(rectX, rectY, rectW, rectH);
      renderer.setScissorTest(true);
      if (composed) {
        const transition = this.transitionState;
        if (transition && this.compositor.hasSnapshot) {
          this.compositor.composite(
            renderer,
            composed,
            transition.progress,
            transition.params,
            this.compWidth / Math.max(this.compHeight, 1),
          );
        } else {
          this.blit(renderer, composed);
        }
      }
      renderer.setScissorTest(false);
      this.publishComposition();
      return;
    }

    this.updateCamera(this.compWidth / this.compHeight);
    // CE1F: the generator produces this frame's source pixels first.
    if (!this.exportMode) this.renderGenerator(renderer, this.timeSec);
    // CE1D: refresh the shared flow service first — syncScene binds ctx.flow.
    if (!this.exportMode) this.updateFlowService(renderer);
    this.syncScene();
    // v0.4A: analyse AFTER syncScene — evalSources has already consumed what
    // frame N-1 published, which is the N-1 contract that makes preview and
    // export agree despite evaluating in opposite order.
    if (!this.exportMode) this.updateVisualStats(renderer);
    // CE1B feedback prepass: preview steps on WALL time (live, paused
    // transport and static images all evolve — export steps separately and
    // deterministically via prepareFeedbackForExport).
    if (this.feedbackActive) {
      (
        this.techniqueRenderer as unknown as {
          feedbackPrepass?: (r: THREE.WebGLRenderer, clockSec: number) => void;
        }
      ).feedbackPrepass?.(renderer, performance.now() / 1000);
    }
    // CE1G: with a transition reveal open, the live render becomes the B
    // side and is composited against the snapshot taken at the identity
    // switch. Authority stays in the editor: it decides progress/style; the
    // Output receives resolved values and composites its OWN local frames.
    const transition = this.transitionState;
    if (transition && this.compositor.hasSnapshot) {
      const live = this.ensureLiveTarget(renderer);
      const prevTarget = renderer.getRenderTarget();
      renderer.setRenderTarget(live);
      renderer.setScissorTest(false);
      renderer.render(this.scene, this.camera);
      renderer.setRenderTarget(prevTarget);
      renderer.setViewport(rectX, rectY, rectW, rectH);
      renderer.setScissor(rectX, rectY, rectW, rectH);
      renderer.setScissorTest(true);
      this.compositor.composite(
        renderer,
        live.texture,
        transition.progress,
        transition.params,
        this.compWidth / Math.max(this.compHeight, 1),
      );
      renderer.setScissorTest(false);
      return;
    }
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
  }

  /** Draw a texture over the current viewport, 1:1, no resampling beyond the
   * viewport scale the user chose. */
  private blitScene: THREE.Scene | null = null;
  private blitMaterial: THREE.ShaderMaterial | null = null;

  private blit(renderer: THREE.WebGLRenderer, texture: THREE.Texture): void {
    if (!this.blitScene || !this.blitMaterial) {
      this.blitMaterial = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: `out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }`,
        fragmentShader: `precision highp float; uniform sampler2D uTex; in vec2 vUv; out vec4 fragColor;
void main() { fragColor = texture(uTex, vUv); }`,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        uniforms: { uTex: { value: null } },
      });
      this.blitScene = new THREE.Scene();
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.blitMaterial);
      mesh.frustumCulled = false;
      this.blitScene.add(mesh);
    }
    this.blitMaterial.uniforms.uTex!.value = texture;
    renderer.render(this.blitScene, this.blitCamera);
  }

  private readonly blitCamera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);

  // ---- CE1G transition plumbing ----
  private compositor = new TransitionCompositor();
  private liveTarget: THREE.WebGLRenderTarget | null = null;
  private transitionState: { progress: number; params: TransitionParams } | null = null;

  private ensureLiveTarget(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
    const gl = renderer.getContext();
    const w = Math.max(gl.drawingBufferWidth, 2);
    const h = Math.max(gl.drawingBufferHeight, 2);
    if (!this.liveTarget || this.liveTarget.width !== w || this.liveTarget.height !== h) {
      this.liveTarget?.dispose();
      this.liveTarget = new THREE.WebGLRenderTarget(w, h, {
        depthBuffer: false,
        colorSpace: THREE.SRGBColorSpace,
      });
    }
    return this.liveTarget;
  }

  /**
   * Export authority: resolved params per layer for the frame being rendered.
   * Set by the export runner immediately before renderStill, so every branch
   * draws the values the evaluator produced rather than whatever the preview
   * last pushed.
   */
  private authorityLayerParams: ReadonlyMap<string, ParamRecord> | undefined;

  /**
   * QA capture, OFF by default: every resolved per-layer set an export
   * published, in order.
   *
   * Comparing two runs of the same export tells an evaluator divergence apart
   * from a render divergence, which is otherwise guesswork — it is how a
   * v0.6B non-determinism was pinned to the feedback surface rather than to
   * the maths, when the parameters matched to six decimals and the pixels did
   * not. Enabling it allocates; leaving it off costs one null check.
   */
  exportParamLog: Record<string, ParamRecord>[] | null = null;

  setAuthorityLayerParams(params: ReadonlyMap<string, ParamRecord> | undefined): void {
    if (params && this.exportParamLog && this.exportParamLog.length < 4096) {
      this.exportParamLog.push(Object.fromEntries([...params].map(([k, v]) => [k, { ...v }])));
    }
    this.authorityLayerParams = params;
  }

  /** Editor/replica set this each frame from RESOLVED values. */
  transitionGeneration = 0;

  setTransition(state: { progress: number; params: TransitionParams } | null): void {
    if (state && !this.transitionState) this.transitionGeneration++;
    this.transitionState = state;
    if (!state) this.compositor.release();
    this.invalidate();
  }

  /** Take the A snapshot from the CURRENT visual (called at the switch). */
  captureTransitionSnapshot(): void {
    const renderer = this.renderer;
    if (!renderer) return;
    const gl = renderer.getContext();
    const w = Math.max(gl.drawingBufferWidth, 2);
    const h = Math.max(gl.drawingBufferHeight, 2);
    this.compositor.capture(renderer, w, h, () => {
      this.syncScene();
      renderer.render(this.scene, this.camera);
    });
  }

  get transitionDiagnostics(): {
    snapshots: number;
    allocations: number;
    disposals: number;
    bytes: number;
  } {
    return {
      snapshots: this.compositor.hasSnapshot ? 1 : 0,
      allocations: this.compositor.allocations,
      disposals: this.compositor.disposals,
      bytes: this.compositor.snapshotBytes,
    };
  }

  private syncScene(paramsOverride?: ParamRecord): void {
    const showProcessed = !this.showOriginal;
    if (this.originalQuad) this.originalQuad.visible = !showProcessed;
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
        // A BRANCH is not the composition: if every layer published, the
        // Output would receive one message per layer per frame and show
        // whichever arrived last. The host publishes once, below, with the
        // whole stack attached.
        if (paramsOverride === undefined && !this.exportMode && !this.isBranch) {
          runtimeBus.emitFrame(
            this.timeSec,
            params,
            this.isTemporalActive,
            this.generator ? this.resolvedSourceParams() : undefined,
            this.transitionState
              ? {
                  generation: this.transitionGeneration,
                  progress: this.transitionState.progress,
                  style: this.transitionState.params.style,
                  params: {
                    softness: this.transitionState.params.softness,
                    amount: this.transitionState.params.amount,
                    scale: this.transitionState.params.scale,
                    centerX: this.transitionState.params.centerX,
                    centerY: this.transitionState.params.centerY,
                    angle: this.transitionState.params.angle,
                    seed: this.transitionState.params.seed,
                  },
                }
              : undefined,
          );
        }
        this.techniqueRenderer.update(params, {
          sourceTexture: this.sourceTexture,
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

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    // No preview renders during export: an interleaved render re-uploads the
    // video texture and hardware decode is not bit-stable, so live input
    // (e.g. MIDI) invalidating the preview could perturb export frames at
    // the LSB level. The dirty flag survives — preview repaints on finish.
    if (this.exportMode) return;
    // 18D: a live source delivers new pixels every frame outside our
    // invalidation model — while one is active, render continuously.
    if (
      !this.dirty &&
      !this.liveSourceActive &&
      !this.feedbackActive &&
      !this.generatorActive &&
      !this.branchesAnimating
    )
      return;
    this.dirty = false;
    // One frame, one dt: the modulation runtime is asked for a step by every
    // layer and by every layer's opacity, and it must answer the same thing.
    this.frameSink?.();
    const start = performance.now();
    this.renderFrame();
    this.lastFrameTime = performance.now() - start;
    const now = performance.now();
    if (this.lastLoopTs > 0) {
      // Two renders can land in one vsync window (invalidate burst after
      // Freeze release / param storms), producing a bogus multi-hundred-fps
      // instantaneous sample — clamp to a plausible display rate (§18G).
      const instFps = Math.min(1000 / Math.max(now - this.lastLoopTs, 0.1), 130);
      this.fpsEma = this.fpsEma === 0 ? instFps : this.fpsEma * 0.9 + instFps * 0.1;
    }
    this.lastLoopTs = now;
  };
  private lastLoopTs = 0;

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
    for (const b of this.branches) b.engine.setExportPreviousTime(sec);
    this.exportPrevSourceSec = sec;
  }

  prepareGeneratorForExport(compositionTime: number, width: number, height: number): void {
    // EVERY layer's generator advances, not just the selected one — an export
    // that prepared one branch would render the others from stale preview
    // state, deterministically and wrongly.
    for (const b of this.branches) {
      b.engine.prepareGeneratorForExport(compositionTime, width, height);
    }
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

  /**
   * EXPORT: capture the transition's A side from EXPLICIT params, at export
   * resolution. Unlike the preview capture this reads nothing from the
   * canvas — the snapshot is a pure function of the params handed in, which
   * is what lets a subrange export reproduce a full export's frames.
   */
  captureExportSnapshot(width: number, height: number, params: ParamRecord): void {
    const renderer = this.renderer;
    if (!renderer) return;
    const prevPixelRatio = renderer.getPixelRatio();
    try {
      renderer.setPixelRatio(1);
      this.updateCamera(width / height);
      this.compositor.capture(renderer, width, height, () => {
        renderer.setClearColor(this.compBackground, 1);
        renderer.clear();
        this.syncScene(params);
        renderer.render(this.scene, this.camera);
      });
    } finally {
      renderer.setPixelRatio(prevPixelRatio);
    }
  }

  /** Drop any A snapshot held for export. */
  releaseTransitionSnapshot(): void {
    this.compositor.release();
  }

  renderStill(
    width: number,
    height: number,
    paramsOverride?: ParamRecord,
    transparent = false,
    transition?: { progress: number; params: TransitionParams },
  ): Uint8Array {
    const renderer = this.renderer;
    if (!renderer) throw new Error('Engine not initialized');
    const target = new THREE.WebGLRenderTarget(width, height, {
      colorSpace: THREE.SRGBColorSpace,
    });
    const prevTarget = renderer.getRenderTarget();
    const prevPixelRatio = renderer.getPixelRatio();
    try {
      // Viewport units are multiplied by pixelRatio — neutralize for offscreen.
      renderer.setPixelRatio(1);
      renderer.setRenderTarget(target);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, width, height);
      // Alpha exports composite onto transparency, not the comp background.
      if (transparent) renderer.setClearColor('#000000', 0);
      else renderer.setClearColor(this.compBackground, 1);
      renderer.clear();
      this.updateCamera(width / height);
      // v0.6: export composites exactly as preview does — every layer to its
      // own target at export resolution, then one blend chain. Layer targets
      // are sized from the composition, so an export at a different size
      // re-renders each branch rather than scaling a preview.
      if (this.branches.length > 0) {
        const prevW = this.compWidth;
        const prevH = this.compHeight;
        this.compWidth = width;
        this.compHeight = height;
        for (const b of this.branches) b.engine.setComposition(width, height, this.compBackground);
        try {
          // A single-layer export still arrives with one `paramsOverride`,
          // which is the evaluator's resolved values. Route it to the layer it
          // belongs to, or modulation would silently vanish from renders of
          // every project written before v0.6.
          // The export runner resolves the SECONDARY layers and hands them
          // over as a map; the primary arrives as `paramsOverride`, because
          // that is the one the morph, Look and trigger replay applies to.
          // Both have to reach the branches: taking the map alone dropped the
          // primary's modulation, and taking the override alone dropped every
          // route into another layer.
          let byLayer = this.authorityLayerParams;
          if (paramsOverride) {
            const id = this.branches[this.selectedLayerIndex]?.id ?? this.branches[0]?.id;
            if (id) byLayer = new Map([...(byLayer ?? []), [id, paramsOverride]]);
          }
          renderer.setRenderTarget(target);
          const direct = !transition && this.renderDirectLayer(renderer, byLayer);
          const composed = direct ? null : this.renderComposition(renderer, transparent, byLayer);
          renderer.setRenderTarget(target);
          if (!direct && composed) {
            if (transition && this.compositor.hasSnapshot) {
              renderer.clear();
              this.compositor.composite(
                renderer,
                composed,
                transition.progress,
                transition.params,
                width / Math.max(height, 1),
              );
            } else {
              this.blit(renderer, composed);
            }
          }
          const out = new Uint8Array(width * height * 4);
          renderer.readRenderTargetPixels(target, 0, 0, width, height, out);
          // GL reads bottom row first — flip vertically, as the single-branch
          // path below does.
          const flippedOut = new Uint8Array(out.length);
          const stride = width * 4;
          for (let y = 0; y < height; y++) {
            flippedOut.set(out.subarray(y * stride, (y + 1) * stride), (height - 1 - y) * stride);
          }
          return flippedOut;
        } finally {
          this.compWidth = prevW;
          this.compHeight = prevH;
          for (const b of this.branches) b.engine.setComposition(prevW, prevH, this.compBackground);
        }
      }
      if (transition && this.compositor.hasSnapshot) {
        // Dual render: B into its own target, then the SAME shader the
        // preview uses composites it against the A snapshot. One
        // implementation of the mask math — export cannot drift from what
        // the user watched.
        const bTarget = new THREE.WebGLRenderTarget(width, height, {
          colorSpace: THREE.SRGBColorSpace,
          depthBuffer: false,
        });
        try {
          renderer.setRenderTarget(bTarget);
          if (transparent) renderer.setClearColor('#000000', 0);
          else renderer.setClearColor(this.compBackground, 1);
          renderer.clear();
          this.syncScene(paramsOverride);
          renderer.render(this.scene, this.camera);
          renderer.setRenderTarget(target);
          renderer.clear();
          this.compositor.composite(
            renderer,
            bTarget.texture,
            transition.progress,
            transition.params,
            width / height,
          );
        } finally {
          bTarget.dispose();
        }
      } else {
        this.syncScene(paramsOverride);
        renderer.render(this.scene, this.camera);
      }
      const pixels = new Uint8Array(width * height * 4);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
      // GL reads bottom row first — flip vertically.
      const flipped = new Uint8Array(pixels.length);
      const rowBytes = width * 4;
      for (let y = 0; y < height; y++) {
        flipped.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), (height - 1 - y) * rowBytes);
      }
      return flipped;
    } finally {
      renderer.setPixelRatio(prevPixelRatio);
      renderer.setRenderTarget(prevTarget);
      target.dispose();
      this.invalidate();
    }
  }
}

export const engine = new RenderEngine();

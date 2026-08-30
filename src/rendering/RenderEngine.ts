import * as THREE from 'three';
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

  setParamTransform(fn: ((base: ParamRecord, timeSec: number) => ParamRecord) | null): void {
    this.paramTransform = fn;
    this.invalidate();
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
    this.loop();
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
    this.invalidate();
  };

  dispose(): void {
    this.canvas?.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas?.removeEventListener('webglcontextrestored', this.onContextRestored);
    cancelAnimationFrame(this.rafId);
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
  get isFeedbackTechnique(): boolean {
    return (this.techniqueRenderer as { feedback?: boolean } | null)?.feedback === true;
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
    this.seed = seed;
    this.invalidate();
  }

  setTime(timeSec: number): void {
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
        const params =
          paramsOverride ??
          (this.paramTransform
            ? this.paramTransform(this.techniqueParams, this.timeSec)
            : this.techniqueParams);
        // RuntimeBus seam (18A): the live pass publishes its evaluated frame.
        // renderStill/export pass paramsOverride and never reach the bus —
        // export isolation is preserved by construction.
        if (paramsOverride === undefined && !this.exportMode) {
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
    if (!this.dirty && !this.liveSourceActive && !this.feedbackActive && !this.generatorActive)
      return;
    this.dirty = false;
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

import * as THREE from 'three';
import { LayerHost } from './layers/LayerHost';
import { GLSL_SRGB_OETF } from './shaders/chunks';
import { LayerRuntimeImpl } from './layers/LayerRuntimeImpl';
import type { LayerRuntime } from './layers/layerRuntime';
import type { ParamRecord } from '@shared/schemas/project';
import type { TechniqueRenderer } from '@/techniques/types';
import type { RawVisualStats, VisualSignalId } from '@/signals/visual/types';
import {
  TransitionCompositor,
  type TransitionParams,
} from './transition/TransitionCompositor';
import { runtimeBus } from '@/runtime/RuntimeBus';
import type { LayerRenderState } from './layers/layerTypes';
import type { TemporalStats } from './temporal/TemporalFrameProvider';

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

  /** While true the preview capture path is disabled (export owns the buffer). */
  private exportMode = false;
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
  private paramTransform: ((base: ParamRecord, timeSec: number, stageId?: string) => ParamRecord) | null = null;

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
    if (this.exportMode || this.layerHost.isEmpty) return;
    const selected = this.layerHost.selectedRuntime;
    const primary = selected?.lastResolved;
    if (!selected || !primary) return;
    const stack = this.layerHost.publishableState();
    runtimeBus.emitFrame(
      this.timeSec,
      primary,
      selected.isTemporalActive,
      selected.hasGenerator ? selected.resolvedSourceParams() : undefined,
      this.transitionState
        ? {
            generation: this.transitionGeneration,
            progress: this.transitionState.progress,
            style: this.transitionState.params.style,
            params: { ...this.transitionState.params } as unknown as Record<string, number>,
          }
        : undefined,
      stack,
    );
  }

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

  setParamTransform(fn: ((base: ParamRecord, timeSec: number, stageId?: string) => ParamRecord) | null): void {
    this.paramTransform = fn;
    this.invalidate();
  }

  /**
   * v0.6B — how a branch resolves ITS parameters. Held as a factory so a layer
   * added later is wired the same way as one that existed at startup, without
   * the bridge having to re-push after every add.
   */
  private layerParamTransform:
    | ((layerId: string) => (base: ParamRecord, timeSec: number, stageId?: string) => ParamRecord)
    | null = null;

  setLayerParamTransform(
    make: ((layerId: string) => (base: ParamRecord, timeSec: number, stageId?: string) => ParamRecord) | null,
  ): void {
    this.layerHost.setParamTransformFactory(make);
  }

  private dirty = true;
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
    // A remount — StrictMode's double effect, a workspace switch, a restored
    // context — builds a NEW renderer on the same canvas. Any runtime still
    // holding the previous one draws into framebuffers this renderer cannot
    // read: every layer black, deterministically, with no error. Adoption is
    // the host's explicit responsibility and it is idempotent.
    this.layerHost.adoptRenderer(this.renderer);
    this.loop();
  }

  // ---- v0.6: the composition this engine hosts --------------------------

  /**
   * Layer branches, bottom first. Every layer is a RenderEngine in branch
   * mode — including the first, so no layer is special. The host owns the
   * canvas, the loop, the view and the compositor; it owns no creative state
   * of its own.
   */
  /**
   * v0.6.1 — the layer set lives behind an explicit host.
   *
   * This engine owns the canvas, the loop, the view and the compositing
   * destination. It owns no source, no technique, no feedback and no
   * analysis, so it cannot answer a creative question about itself — every
   * such question goes to `layerHost`, whose method names carry the scope
   * being asked about.
   */
  private readonly layerHost = new LayerHost(() => new LayerRuntimeImpl());

  /** Runtime for ONE named layer, for the bridge to configure directly. */
  branchFor(layerId: string): LayerRuntimeImpl | null {
    return (this.layerHost.runtimeFor(layerId) as LayerRuntimeImpl | null) ?? null;
  }

  get layerCount(): number {
    return this.layerHost.layerCount;
  }

  get layerIds(): string[] {
    return this.layerHost.layerIds;
  }

  get compositorStats(): {
    passes: number;
    bytes: number;
    layerTargetBytes: number;
    runtimes: number;
    staleRuntimes: number;
  } {
    return this.layerHost.stats;
  }

  setLiveSource(kind: 'camera' | 'capture', texture: THREE.Texture | null): void {
    this.layerHost.setLiveSource(kind, texture);
    this.invalidate();
  }

  setLiveLayerKinds(kinds: ReadonlyMap<string, 'camera' | 'capture'>): void {
    this.layerHost.setLiveLayerKinds(kinds);
    this.invalidate();
  }

  /** Reconcile the runtime set with the project's layers. */
  syncLayers(states: readonly LayerRenderState[]): void {
    this.layerHost.adoptRenderer(this.renderer);
    this.layerHost.sync(states);
    this.invalidate();
  }

  setLayerStateSink(
    fn: ((layerId: string, opacity: number) => { opacity: number }) | null,
  ): void {
    this.layerHost.setOpacitySink(fn);
  }

  /** What ONE layer is actually being composited at, for the performance UI. */
  resolvedOpacity(layerId: string): number | null {
    return this.layerHost.resolvedOpacityFor(layerId);
  }

  setAuthorityLayerOpacity(byLayer: ReadonlyMap<string, number> | undefined): void {
    this.layerHost.setAuthorityOpacity(byLayer);
  }

  setAuthorityLayerEnabled(byLayer: ReadonlyMap<string, boolean> | undefined): void {
    this.layerHost.setAuthorityEnabled(byLayer);
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
    // The host owns the canvas listener and its own compositing targets; each
    // layer allocated its own on the SAME lost context, and never sees the
    // event, so the host tells every one of them to rebuild.
    this.compositor.release();
    this.layerHost.handleContextRestored();
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
    this.layerHost.disposeAll();
    this.renderer?.dispose();
    this.renderer = null;
    this.canvas = null;
  }

  // ---- state setters (bridge pushes project state here) ----

  setComposition(width: number, height: number, background: string): void {
    // Composition size and background are GLOBAL — a layer renders into a
    // target the host sized, so it has to agree about the dimensions.
    this.layerHost.setComposition(width, height, background);
    const changed = width !== this.compWidth || height !== this.compHeight;
    this.compWidth = width;
    this.compHeight = height;
    this.compBackground = background;
    if (changed) this.fit();
    this.invalidate();
  }

  /** Drop temporal history — seek, loop restart, source change (§13).
   * 18F: COMPOSITION-time resets only. In live mode history is realtime
   * observation — a timeline seek or loop wrap must not rewind reality, so
   * this is a no-op while a live source is active. Live-source boundaries
   * (start/stop/device/target/project switch) reset through the
   * setLiveSourceActive flip and setTemporalSource instead. */
  resetTemporal(): void {
    this.layerHost.forEachRuntime((r) => r.resetTemporal());
    this.invalidate();
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
    // Every layer's flow, not the host's: a layer using Motion on a source
    // the host never sees must still solve during export.
    this.layerHost.forEachRuntime((runtime, layerId) =>
      this.layerHost.prepare(layerId, 'flow', () =>
        runtime.prepareFlowForExport(
          compositionTime,
          `${layerId}:${frameKey}`,
          isFirstFrame,
          width,
          height,
          this.layerHost.authorityParamsSnapshot?.get(layerId),
        ),
      ),
    );
    void params;
  }

  /** Editor authority pushes the demanded set; empty releases the targets. */
  setVisualDemand(ids: ReadonlySet<VisualSignalId>): void {
    // A host has no source texture and nothing to measure. The demand belongs
    // to the layer set: without a per-layer split the selected layer carries
    // it, which is what a visual signal meant before layers.
    this.layerHost.setFlatVisualDemand(ids);
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
  setVisualDemandByLayer(byLayer: ReadonlyMap<string, ReadonlySet<VisualSignalId>>): void {
    this.layerHost.setVisualDemandByLayer(byLayer);
    this.invalidate();
  }

  /** Where per-layer analysis goes. Authority wires this from the bridge. */
  setLayerVisualSink(
    fn: ((layerId: string, stats: RawVisualStats | null) => void) | null,
  ): void {
    this.layerHost.setVisualSink(fn);
  }

  /** Analysis from the layer the scope is watching. */
  get visualSignalStats(): RawVisualStats | null {
    return this.layerHost.selectedVisualStats;
  }

  get visualDiagnostics(): { reductions: number; bytes: number; width: number; height: number } | null {
    return this.layerHost.selectedVisualDiagnostics;
  }

  /** EXPORT: analyse this frame, keyed by GLOBAL frame so a subrange drives the
   * reducer exactly as a full export does. */
  updateVisualStatsForExport(frameKey: string): void {
    // Each layer analyses its OWN source; the frame key is namespaced so two
    // layers cannot share a cache entry.
    this.layerHost.forEachRuntime((runtime, layerId) =>
      this.layerHost.prepare(layerId, 'stats', () =>
        runtime.updateVisualStatsForExport(`${layerId}:${frameKey}`),
      ),
    );
  }

  /** Enter export mode across the whole composition. */
  beginExportMode(): void {
    this.layerHost.beginExportMode();
    this.exportMode = true;
  }

  /** Drop feedback state on EVERY layer — a Candidate release, a source
   * identity change, a context restore. */
  resetFeedbackEverywhere(): void {
    this.layerHost.forEachRuntime((r) => r.resetFeedback());
    this.invalidate();
  }

  /** Drop the optical-flow pair on EVERY layer: a seek makes the two frames
   * either side of it non-adjacent, and their difference is not motion. */
  resetFlowPairEverywhere(): void {
    this.layerHost.forEachRuntime((r) => r.resetFlowPair());
    this.invalidate();
  }

  /** Material texture is composition-wide; every layer gets the same one. */
  setMaterialTexture(texture: THREE.Texture | null): void {
    this.layerHost.forEachRuntime((r) => r.setMaterialTexture(texture));
    this.invalidate();
  }

  /** Temporal diagnostics for the layer the scope is watching. */
  getTemporalStats(): TemporalStats | null {
    return this.layerHost.selectedRuntime?.getTemporalStats() ?? null;
  }

  /** Is the SELECTED layer addressing frame history? */
  get isTemporalActive(): boolean {
    return this.layerHost.selectedRuntime?.isTemporalActive ?? false;
  }

  /**
   * Export renderer sync (pre-v0.3 hotfix) acts on the SELECTED layer: a
   * cross-technique morph switches that layer's technique mid-export, and the
   * renderer has to follow the evaluated frame. Forwarded so the export runner
   * keeps a single handle.
   */
  setTechniqueRenderer(renderer: TechniqueRenderer | null): void {
    this.layerHost.selectedRuntime?.setTechniqueRenderer(renderer);
    this.invalidate();
  }

  setTechniqueChain(
    layerId: string,
    stages: readonly { stageId: string; renderer: TechniqueRenderer; params: ParamRecord }[],
  ): void {
    this.layerHost.setTechniqueChain(layerId, stages);
    this.invalidate();
  }

  setTechniqueStageParams(params: ReadonlyMap<string, ReadonlyMap<string, ParamRecord>>): void {
    this.layerHost.setTechniqueStageParams(params);
    this.invalidate();
  }

  setTemporalEnabled(enabled: boolean): void {
    this.layerHost.selectedRuntime?.setTemporalEnabled(enabled);
    this.invalidate();
  }

  /** Flow diagnostics for the layer the scope is watching. */
  get flowStats(): { updates: number; width: number; height: number; bytes: number } | null {
    return this.layerHost.selectedRuntime?.flowStats ?? null;
  }

  /** Is the SELECTED layer running on a live source? */
  get isLiveTemporalMode(): boolean {
    return this.layerHost.selectedRuntime?.isLiveTemporalMode ?? false;
  }

  /** Temporal history ANYWHERE in the stack. */
  /** A serial layer carries state (feedback, history, flow, signals) that a preroll must walk. */
  get hasStatefulSerialLayers(): boolean {
    return this.layerHost.anySerialLayerIsStateful();
  }

  get isTemporalActiveAnywhere(): boolean {
    return this.layerHost.anyLayerUsesTemporalHistory();
  }

  /** Export path: deterministic feedback stepping (preroll on first frame,
   * incremental whole steps after). Mirrors prepareTemporalForExport. */
  prepareFeedbackForExport(
    compositionTime: number,
    isFirstFrame: boolean,
    params?: ParamRecord,
  ): void {
    // Feedback is per layer: each surface has its own history and must be
    // prerolled on its own.
    this.layerHost.forEachRuntime((runtime, layerId) =>
      this.layerHost.prepare(layerId, 'feedback', () =>
        runtime.prepareFeedbackForExport(
          compositionTime,
          isFirstFrame,
          this.layerHost.authorityParamsSnapshot?.get(layerId),
        ),
      ),
    );
    void params;
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
    return this.layerHost.anyLayerUsesFeedback();
  }

  /**
   * EXPORT path (§3): rebuild the history from exact composition timestamps.
   * Never reuses preview contents. Returns the sample schedule for tests.
   */
  async prepareTemporalForExport(
    compositionTime: number,
    isFirstFrame: boolean,
  ): Promise<{ logicalSlot: number; sourceTime: number }[]> {
    // Every layer that samples history primes its own; a subrange export must
    // arrive with each layer carrying the frames a full export would have
    // given it.
    const all: { logicalSlot: number; sourceTime: number }[] = [];
    const runtimes: LayerRuntime[] = [];
    // A serial layer's history is fed frame by frame from the composite beneath it
    // (LayerHost.composite); there is no source of its own to seek.
    this.layerHost.forEachRuntime((r, layerId) => {
      if (!this.layerHost.isSerial(layerId)) runtimes.push(r);
    });
    for (const runtime of runtimes) {
      all.push(...(await runtime.prepareTemporalForExport(compositionTime, isFirstFrame)));
    }
    return all;
  }

  /** Leave export mode and discard export-primed history (§13). */
  endExportMode(): void {
    this.layerHost.endExportMode();
    this.exportMode = false;
    // Resolved export values must not survive into the preview, or a layer
    // keeps rendering the last exported frame’s parameters.
    this.layerHost.setAuthorityParams(undefined);
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
    this.layerHost.setSeed(seed);
    this.seed = seed;
    this.invalidate();
  }

  setTime(timeSec: number): void {
    // One composition clock. Every branch reads the same time, which is what
    // keeps layers in step with each other and with export.
    this.layerHost.setTime(timeSec);
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
    const selected = this.layerHost.selectedRuntime as { instanceCount?: number } | null;
    const instanceCount = typeof selected?.instanceCount === 'number' ? selected.instanceCount : 0;
    return {
      fps: Math.round(this.fpsEma),
      frameTimeMs: this.lastFrameTime,
      instanceCount,
      rendererName: info ? String(info.getParameter(info.VERSION)) : 'none',
    };
  }

  // ---- render ----

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

    // v0.6: with layers configured the host renders no creative state of its
    // own — every branch draws to its own target and the compositor blends
    // them. The blit below is the only place composition pixels reach the
    // canvas.
    if (!this.layerHost.isEmpty) {
      // One opaque Normal layer is the overwhelmingly common case, and it
      // needs no compositor at all: the layer draws straight onto the canvas
      // inside the composition rect, exactly as the pre-layer engine did.
      //
      // Routing it through the compositor instead costs a 1080p layer target,
      // a background clear, a blend pass and a blit — measured at 21 fps
      // against 99 fps for the same single-mosaic project on v0.5.0. The
      // direct path restores it and makes the common case pixel-identical to
      // v0.5 by construction rather than by luck.
      //
      // v0.8.3: the fast path still skips the compositor, but no longer draws
      // onto the canvas itself — it draws into the layer's own target and the
      // engine blits that with the sRGB transfer, like every other frame.
      const single = this.transitionState ? null : this.layerHost.renderSingleOpaqueToOwnTarget(renderer);
      const composed = single ?? this.layerHost.composite(renderer, this.checkerboard);
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
            /* encode */ true,
          );
        } else {
          this.blit(renderer, composed, /* encode */ true);
        }
      }
      renderer.setScissorTest(false);
      this.publishComposition();
      return;
    }
  }


  /**
   * Draw a texture over the current viewport, 1:1, no resampling beyond the
   * viewport scale the user chose.
   *
   * `encode` is the ONE place preview pixels get the sRGB transfer, and it
   * exists because of a measurement: a 128-grey PNG through an identity
   * technique exported as 128 and previewed as 55. Every intermediate target
   * is SRGB8 — the GPU decodes on sample and encodes on write, so the values a
   * shader handles are linear and the bytes a target stores are sRGB. Export
   * reads those bytes and is right. The canvas is not an sRGB target: a raw
   * write lands linear light on screen, which is what the preview showed for
   * every mid-tone until v0.8.3. A blit into another SRGB8 target (export,
   * snapshot) must NOT encode — the hardware already does.
   */
  private static readonly BLIT_CAMERA = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  private blitScene: THREE.Scene | null = null;
  private blitMaterial: THREE.ShaderMaterial | null = null;

  private blit(renderer: THREE.WebGLRenderer, texture: THREE.Texture, encode = false): void {
    if (!this.blitScene || !this.blitMaterial) {
      this.blitMaterial = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: `out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }`,
        fragmentShader: `precision highp float; uniform sampler2D uTex; uniform float uEncode; in vec2 vUv; out vec4 fragColor;
${GLSL_SRGB_OETF}
void main() { vec4 c = texture(uTex, vUv); fragColor = vec4(uEncode > 0.5 ? srgbOetf(c.rgb) : c.rgb, c.a); }`,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        uniforms: { uTex: { value: null }, uEncode: { value: 0 } },
      });
      this.blitScene = new THREE.Scene();
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.blitMaterial);
      mesh.frustumCulled = false;
      this.blitScene.add(mesh);
    }
    this.blitMaterial.uniforms.uTex!.value = texture;
    this.blitMaterial.uniforms.uEncode!.value = encode ? 1 : 0;
    renderer.render(this.blitScene, RenderEngine.BLIT_CAMERA);
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

  /**
   * Export authority: resolved params per layer for the frame being rendered.
   * Set by the export runner immediately before renderStill, so every branch
   * draws the values the evaluator produced rather than whatever the preview
   * last pushed.
   */

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
    // ONE owner. Keeping a second copy on the engine meant the export
    // prerolls — which read the host's — were handed undefined, so a feedback
    // or motion layer prerolled from live state and a subrange stopped
    // matching a full export.
    this.layerHost.setAuthorityParams(params);
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
    // The A side is the composition as it stands, drawn through the same
    // layer path the live frame uses — never a layer in isolation.
    this.compositor.capture(renderer, w, h, () => {
      if (!this.layerHost.renderSingleOpaqueToCanvas(renderer)) {
        const composed = this.layerHost.composite(renderer, false);
        if (composed) this.blit(renderer, composed);
      }
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

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    // No preview renders during export: an interleaved render re-uploads the
    // video texture and hardware decode is not bit-stable, so live input
    // (e.g. MIDI) invalidating the preview could perturb export frames at
    // the LSB level. The dirty flag survives — preview repaints on finish.
    if (this.exportMode) return;
    // 18D: a live source delivers new pixels every frame outside our
    // invalidation model — while one is active, render continuously.
    // A live source, feedback and a simulation generator are the three things
    // that keep rendering without an explicit invalidate, and all three live
    // on the layers — so this is one question about the SET, not three about
    // the host. Asking the host produced 19 rendered frames per second while
    // rAF ran at 120.
    if (!this.dirty && !this.layerHost.anyLayerNeedsContinuousRender()) return;
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

  setExportPreviousTime(sec: number | null): void {
    this.layerHost.forEachRuntime((r) => r.setExportPreviousTime(sec));
  }

  prepareGeneratorForExport(compositionTime: number, width: number, height: number): void {
    // EVERY layer's generator advances, not just the selected one — an export
    // that prepared one would render the others from stale preview state,
    // deterministically and wrongly.
    this.layerHost.forEachRuntime((r) =>
      r.prepareGeneratorForExport(compositionTime, width, height),
    );
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
      // The A side is the whole composition, drawn through the same layer
      // path an exported frame uses.
      const byLayer = new Map(this.layerHost.authorityParamsSnapshot ?? []);
      const selected = this.layerHost.selectedLayerId;
      if (selected) byLayer.set(selected, params);
      this.compositor.capture(renderer, width, height, () => {
        renderer.setClearColor(this.compBackground, 1);
        renderer.clear();
        if (!this.layerHost.renderSingleOpaqueToBoundTarget(renderer, byLayer)) {
          const composed = this.layerHost.composite(renderer, false, byLayer);
          if (composed) this.blit(renderer, composed);
        }
      });
    } finally {
      renderer.setPixelRatio(prevPixelRatio);
    }
  }

  /** Drop any A snapshot held for export. */
  releaseTransitionSnapshot(): void {
    this.compositor.release();
  }

  /**
   * Export preroll: draw the whole stack once and keep nothing. It exists to run
   * the serial layers' preparation (feedback steps, flow pair, history ring)
   * against the composite beneath them for frames BEFORE the exported range.
   */
  walkCompositeForExport(width: number, height: number, paramsOverride?: ParamRecord): void {
    this.renderStill(width, height, paramsOverride, false);
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
      if (!this.layerHost.isEmpty) {
        const prevW = this.compWidth;
        const prevH = this.compHeight;
        this.compWidth = width;
        this.compHeight = height;
        this.layerHost.setComposition(width, height, this.compBackground);
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
          let byLayer = this.layerHost.authorityParamsSnapshot;
          if (paramsOverride) {
            const id = this.layerHost.selectedLayerId;
            if (id) byLayer = new Map([...(byLayer ?? []), [id, paramsOverride]]);
          }
          renderer.setRenderTarget(target);
          const direct =
            !transition && this.layerHost.renderSingleOpaqueToBoundTarget(renderer, byLayer);
          const composed = direct
            ? null
            : this.layerHost.composite(renderer, transparent, byLayer);
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
          this.layerHost.setComposition(prevW, prevH, this.compBackground);
        }
      }
      // No non-layer path: a composition always has at least one layer, so
      // the block above is the only way a still is produced.
      throw new Error('renderStill: composition has no layers');
    } finally {
      renderer.setPixelRatio(prevPixelRatio);
      renderer.setRenderTarget(prevTarget);
      target.dispose();
      this.invalidate();
    }
  }
}

export const engine = new RenderEngine();

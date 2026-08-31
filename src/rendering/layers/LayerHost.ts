import * as THREE from 'three';
import type { ParamRecord } from '@shared/schemas/project';
import type { RawVisualStats, VisualSignalId } from '@/signals/visual/types';
import { LayerCompositor, type CompositeLayer } from './LayerCompositor';
import { requirementsOf, type LayerRequirements, type LayerRuntime } from './layerRuntime';
import type { LayerRenderState } from './layerTypes';

const EMPTY_DEMAND: ReadonlySet<VisualSignalId> = new Set();

interface Slot {
  readonly id: string;
  readonly runtime: LayerRuntime;
  target: THREE.WebGLRenderTarget | null;
  /** Which renderer this runtime was built against. See `adoptRenderer`. */
  rendererGeneration: number;
}

/**
 * v0.6.1 — the layer set, and every question that is about the SET.
 *
 * `RenderEngine` owns the canvas, the loop, the view and the compositor. It
 * owns no creative state, so it cannot be asked a creative question. Anything
 * about sources, techniques, feedback, flow or analysis is asked here, and
 * every method name says what it is asking about:
 *
 *     anyLayer*        → true if ANY layer in the set
 *     *For(layerId)    → about ONE named layer
 *     exportRequirements() → about the EXPORT graph
 *
 * That naming is the whole point of this class. v0.6 shipped nine defects of
 * one shape — a host-level predicate still answering for the host after the
 * work moved onto the branches — and every one of them would have been a
 * compile error or an obviously wrong call site under these names.
 */
export class LayerHost {
  private slots: Slot[] = [];
  private states: LayerRenderState[] = [];
  private selectedIndex = 0;
  private readonly compositor = new LayerCompositor();

  private renderer: THREE.WebGLRenderer | null = null;
  /**
   * Bumped every time the host installs a different renderer.
   *
   * A runtime holds the renderer it was built with. A remount — StrictMode's
   * double effect, a workspace switch, a restored context — builds a NEW
   * WebGLRenderer on the same canvas, and a runtime still holding the old one
   * draws into framebuffers the host cannot read: every layer black,
   * deterministically, with no error. The generation makes "which renderer is
   * this runtime bound to" an answerable question instead of an assumption.
   */
  private rendererGeneration = 0;

  private compWidth = 1920;
  private compHeight = 1080;
  private compBackground = '#000000';
  private seed = 1;
  private timeSec = 0;
  private exportMode = false;

  constructor(private readonly createRuntime: () => LayerRuntime) {}

  // ---- renderer ownership ---------------------------------------------------

  /**
   * Install the renderer every layer must draw with.
   *
   * Idempotent for the same renderer. For a different one it bumps the
   * generation, re-binds every surviving runtime and drops their targets,
   * because a target allocated by the previous renderer is unreadable by this
   * one.
   */
  adoptRenderer(renderer: THREE.WebGLRenderer | null): void {
    if (this.renderer === renderer) return;
    this.renderer = renderer;
    this.rendererGeneration++;
    for (const slot of this.slots) {
      slot.target?.dispose();
      slot.target = null;
      slot.rendererGeneration = this.rendererGeneration;
      if (renderer) slot.runtime.initBranch(renderer);
    }
  }

  /** Diagnostics: a runtime bound to a renderer the host no longer uses. */
  get staleRuntimeCount(): number {
    return this.slots.filter((s) => s.rendererGeneration !== this.rendererGeneration).length;
  }

  get currentRendererGeneration(): number {
    return this.rendererGeneration;
  }

  // ---- composition-wide state ----------------------------------------------

  setComposition(width: number, height: number, background: string): void {
    this.compWidth = width;
    this.compHeight = height;
    this.compBackground = background;
    for (const s of this.slots) s.runtime.setComposition(width, height, background);
  }

  setSeed(seed: number): void {
    this.seed = seed;
    for (const s of this.slots) s.runtime.setSeed(seed);
  }

  setTime(timeSec: number): void {
    this.timeSec = timeSec;
    for (const s of this.slots) s.runtime.setTime(timeSec);
  }

  beginExportMode(): void {
    this.exportMode = true;
    for (const s of this.slots) s.runtime.beginExportMode();
  }

  endExportMode(): void {
    this.exportMode = false;
    this.authorityParams = undefined;
    this.authorityOpacity = undefined;
    this.authorityEnabled = undefined;
    for (const s of this.slots) s.runtime.endExportMode();
  }

  // ---- reconciliation -------------------------------------------------------

  /**
   * Reconcile the runtime set with the project's layers.
   *
   * Identity is the layer id, never the index: reordering rebuilds nothing, so
   * a feedback surface or a simulation survives being moved up the stack.
   */
  sync(states: readonly LayerRenderState[]): void {
    const next: Slot[] = [];
    for (const state of states) {
      const existing = this.slots.find((s) => s.id === state.id);
      if (existing) {
        next.push(existing);
        continue;
      }
      const runtime = this.createRuntime();
      if (this.renderer) runtime.initBranch(this.renderer);
      if (this.paramTransformFactory) runtime.setParamTransform(this.paramTransformFactory(state.id));
      next.push({
        id: state.id,
        runtime,
        target: null,
        rendererGeneration: this.rendererGeneration,
      });
    }
    for (const previous of this.slots) {
      if (next.some((s) => s.id === previous.id)) continue;
      previous.runtime.disposeBranch();
      previous.target?.dispose();
    }
    this.slots = next;
    this.states = [...states];
    const selected = states.findIndex((s) => s.selected);
    this.selectedIndex = selected >= 0 ? selected : 0;
    for (const s of this.slots) {
      s.runtime.setComposition(this.compWidth, this.compHeight, this.compBackground);
      s.runtime.setSeed(this.seed);
      s.runtime.setTime(this.timeSec);
      if (this.exportMode) s.runtime.beginExportMode();
    }
    this.applyVisualDemand();
    this.distributeLiveSources();
  }

  /** Every layer allocated its targets on the SAME lost context, so each has
   * to rebuild. The host owns the canvas listener; runtimes never see the
   * event and would otherwise keep dead handles. */
  handleContextRestored(): void {
    this.compositor.release();
    for (const s of this.slots) {
      s.target?.dispose();
      s.target = null;
      s.runtime.handleContextRestored();
    }
  }

  disposeAll(): void {
    for (const s of this.slots) {
      s.runtime.disposeBranch();
      s.target?.dispose();
    }
    this.slots = [];
    this.states = [];
    this.compositor.dispose();
  }

  // ---- identity -------------------------------------------------------------

  /** The runtime for ONE named layer, or null if there is no such layer. */
  runtimeFor(layerId: string): LayerRuntime | null {
    return this.slots.find((s) => s.id === layerId)?.runtime ?? null;
  }

  /** The runtime the performer is holding. */
  get selectedRuntime(): LayerRuntime | null {
    return this.slots[this.selectedIndex]?.runtime ?? null;
  }

  get selectedLayerId(): string | null {
    return this.slots[this.selectedIndex]?.id ?? null;
  }

  get layerIds(): string[] {
    return this.slots.map((s) => s.id);
  }

  get layerCount(): number {
    return this.slots.length;
  }

  get isEmpty(): boolean {
    return this.slots.length === 0;
  }

  forEachRuntime(fn: (runtime: LayerRuntime, layerId: string) => void): void {
    for (const s of this.slots) fn(s.runtime, s.id);
  }

  // ---- questions about the SET ----------------------------------------------

  /**
   * Does ANY layer need a frame even though nothing invalidated the host?
   *
   * A live source, feedback and a simulation generator are the three things
   * that keep the loop rendering without an explicit invalidate, and all three
   * live on the layers. Asking the host produced 19 rendered frames per second
   * while rAF ran at 120.
   */
  anyLayerNeedsContinuousRender(): boolean {
    return this.slots.some((s) => requirementsOf(s.runtime).needsContinuousRender);
  }

  /**
   * Does ANY layer carry feedback history?
   *
   * Export asks this to decide whether to walk the feedback preroll. Asking
   * the host answered "no" while a layer ran Feedback Zoom, so the preroll was
   * skipped, `prerolled` was still set, the first real frame declared itself
   * not-first, and every export inherited the previous one's history.
   */
  anyLayerUsesFeedback(): boolean {
    return this.slots.some((s) => requirementsOf(s.runtime).needsFeedbackPreroll);
  }

  /** Does ANY layer address frame history? */
  anyLayerUsesTemporalHistory(): boolean {
    return this.slots.some((s) => requirementsOf(s.runtime).needsTemporalHistory);
  }

  /** Is ANY layer showing a live device right now? */
  hasLiveSourceConsumers(): boolean {
    return this.slots.some((s) => requirementsOf(s.runtime).needsLiveSource);
  }

  /** What ONE named layer needs. */
  requirementsFor(layerId: string): LayerRequirements | null {
    const runtime = this.runtimeFor(layerId);
    return runtime ? requirementsOf(runtime) : null;
  }

  /**
   * What the EXPORT graph needs, aggregated across every layer that will
   * actually render — never from the selected technique alone.
   */
  exportRequirements(): LayerRequirements {
    const all = this.slots.map((s) => requirementsOf(s.runtime));
    return {
      needsContinuousRender: all.some((r) => r.needsContinuousRender),
      needsLiveSource: all.some((r) => r.needsLiveSource),
      needsFeedbackPreroll: all.some((r) => r.needsFeedbackPreroll),
      needsTemporalHistory: all.some((r) => r.needsTemporalHistory),
      needsGenerator: all.some((r) => r.needsGenerator),
    };
  }

  // ---- shared live devices --------------------------------------------------

  private liveTextures = new Map<'camera' | 'capture', THREE.Texture | null>();
  private liveLayerKinds = new Map<string, 'camera' | 'capture'>();

  /**
   * ONE acquisition, every layer that shows it. A camera is a physical device:
   * it is acquired once no matter how many layers display it.
   */
  setLiveSource(kind: 'camera' | 'capture', texture: THREE.Texture | null): void {
    this.liveTextures.set(kind, texture);
    this.distributeLiveSources();
  }

  setLiveLayerKinds(kinds: ReadonlyMap<string, 'camera' | 'capture'>): void {
    this.liveLayerKinds = new Map(kinds);
    this.distributeLiveSources();
  }

  /** How many layers consume ONE live device kind. */
  consumerCountFor(kind: 'camera' | 'capture'): number {
    let n = 0;
    for (const k of this.liveLayerKinds.values()) if (k === kind) n++;
    return n;
  }

  private distributeLiveSources(): void {
    for (const s of this.slots) {
      const kind = this.liveLayerKinds.get(s.id);
      if (!kind) continue;
      const texture = this.liveTextures.get(kind) ?? null;
      s.runtime.setSource(texture);
      s.runtime.setLiveSourceActive(texture !== null);
    }
  }

  // ---- authority ------------------------------------------------------------

  private paramTransformFactory:
    | ((layerId: string) => (base: ParamRecord, timeSec: number) => ParamRecord)
    | null = null;
  private opacitySink: ((layerId: string, opacity: number) => { opacity: number }) | null = null;
  private authorityParams: ReadonlyMap<string, ParamRecord> | undefined;
  private authorityOpacity: ReadonlyMap<string, number> | undefined;
  private authorityEnabled: ReadonlyMap<string, boolean> | undefined;

  setParamTransformFactory(
    make: ((layerId: string) => (base: ParamRecord, timeSec: number) => ParamRecord) | null,
  ): void {
    this.paramTransformFactory = make;
    for (const s of this.slots) s.runtime.setParamTransform(make ? make(s.id) : null);
  }

  setOpacitySink(fn: ((layerId: string, opacity: number) => { opacity: number }) | null): void {
    this.opacitySink = fn;
  }

  /** Values resolved elsewhere — the export evaluator, or the editor feeding
   * the Output replica. They win over anything this host could re-derive. */
  setAuthorityParams(byLayer: ReadonlyMap<string, ParamRecord> | undefined): void {
    this.authorityParams = byLayer;
  }

  setAuthorityOpacity(byLayer: ReadonlyMap<string, number> | undefined): void {
    this.authorityOpacity = byLayer;
  }

  /**
   * v0.7: a Take can mute a layer, and export has to obey.
   *
   * Enabled is not expressible as opacity 0 — the comment on `visibleIndices`
   * says why. Opacity 0 deliberately keeps drawing, so a feedback or
   * simulation branch does not lose what it has been accumulating; disabling
   * stops the branch. A replayed mute has to reproduce whichever of those the
   * performer actually did, so it gets its own authority channel rather than
   * being folded into the other one.
   */
  setAuthorityEnabled(byLayer: ReadonlyMap<string, boolean> | undefined): void {
    this.authorityEnabled = byLayer;
  }

  get authorityParamsSnapshot(): ReadonlyMap<string, ParamRecord> | undefined {
    return this.authorityParams;
  }

  /**
   * What ONE layer is actually composited at this frame.
   *
   * Authority first: during an export, and in the Output replica, the value
   * has already been resolved elsewhere and must not be re-derived. Checking
   * the live sink first made the replica ignore the opacity it had just been
   * sent.
   */
  private effectiveOpacityAt(index: number): number {
    const state = this.states[index];
    if (!state) return 0;
    const authority = this.authorityOpacity?.get(state.id);
    if (authority !== undefined) return authority;
    if (!this.opacitySink) return state.opacity;
    return this.opacitySink(state.id, state.opacity).opacity;
  }

  resolvedOpacityFor(layerId: string): number | null {
    const index = this.states.findIndex((s) => s.id === layerId);
    return index < 0 ? null : this.effectiveOpacityAt(index);
  }

  // ---- analysis demand ------------------------------------------------------

  private demandByLayer: ReadonlyMap<string, ReadonlySet<VisualSignalId>> | null = null;
  private flatDemand: ReadonlySet<VisualSignalId> = EMPTY_DEMAND;
  private visualSink: ((layerId: string, stats: RawVisualStats | null) => void) | null = null;

  /** Demand with no per-layer split yet: the selected layer carries it all,
   * which is what a visual signal meant before layers. */
  setFlatVisualDemand(ids: ReadonlySet<VisualSignalId>): void {
    this.flatDemand = ids;
    this.applyVisualDemand();
  }

  /** Only layers something actually routes FROM are analysed; the rest release
   * their reduction targets. */
  setVisualDemandByLayer(byLayer: ReadonlyMap<string, ReadonlySet<VisualSignalId>>): void {
    this.demandByLayer = byLayer;
    this.applyVisualDemand();
  }

  setVisualSink(fn: ((layerId: string, stats: RawVisualStats | null) => void) | null): void {
    this.visualSink = fn;
    this.applyVisualDemand();
  }

  private applyVisualDemand(): void {
    const byLayer = this.demandByLayer;
    for (const [i, s] of this.slots.entries()) {
      const demand = byLayer
        ? (byLayer.get(s.id) ?? EMPTY_DEMAND)
        : i === this.selectedIndex
          ? this.flatDemand
          : EMPTY_DEMAND;
      const id = s.id;
      s.runtime.setVisualSink(
        demand.size > 0 && this.visualSink ? (stats) => this.visualSink?.(id, stats) : null,
      );
      s.runtime.setVisualDemand(demand);
    }
  }

  /** Analysis from the layer the scope is watching. */
  get selectedVisualStats(): RawVisualStats | null {
    return this.selectedRuntime?.visualSignalStats ?? null;
  }

  get selectedVisualDiagnostics():
    | { reductions: number; bytes: number; width: number; height: number }
    | null {
    return this.selectedRuntime?.visualDiagnostics ?? null;
  }

  // ---- render ---------------------------------------------------------------

  /** Which layers contribute a draw. Opacity 0 still RENDERS: a stateful
   * branch that stopped would lose what it has been accumulating. */
  private visibleIndices(): number[] {
    const out: number[] = [];
    for (const [i, state] of this.states.entries()) {
      if (!(this.authorityEnabled?.get(state.id) ?? state.enabled)) continue;
      if (!this.slots[i]) continue;
      out.push(i);
    }
    return out;
  }

  /**
   * True when the composition is exactly one fully opaque Normal layer, in
   * which case the compositor is mathematically a no-op and the layer can draw
   * straight into the destination. Not merely an optimisation: routing through
   * two more 8-bit sRGB targets cost up to one code on 0.45% of bytes against
   * the pre-layer render, and a migrated v3 project has to render EXACTLY as
   * it did.
   */
  private singleOpaqueIndex(): number | null {
    const visible = this.visibleIndices();
    if (visible.length !== 1) return null;
    const only = visible[0] as number;
    const state = this.states[only];
    if (!state || state.blendMode !== 'normal') return null;
    if (this.effectiveOpacityAt(only) < 1) return null;
    return only;
  }

  /** Draw straight to the canvas when the fast path applies. */
  renderSingleOpaqueToCanvas(renderer: THREE.WebGLRenderer): boolean {
    const index = this.singleOpaqueIndex();
    if (index === null) return false;
    this.slots[index]!.runtime.renderLayerToCanvas(renderer);
    return true;
  }

  /** Draw straight into the bound target when the fast path applies. */
  renderSingleOpaqueToBoundTarget(
    renderer: THREE.WebGLRenderer,
    override?: ReadonlyMap<string, ParamRecord>,
  ): boolean {
    const index = this.singleOpaqueIndex();
    if (index === null) return false;
    const slot = this.slots[index]!;
    const params = (override ?? this.authorityParams)?.get(slot.id);
    const target = renderer.getRenderTarget();
    if (!target) return false;
    if (params) slot.runtime.renderLayerToWithParams(target, params, false);
    else slot.runtime.renderLayerTo(target, { clear: false });
    return true;
  }

  private ensureTarget(index: number): THREE.WebGLRenderTarget {
    const slot = this.slots[index];
    if (!slot) throw new Error('layer index out of range');
    const w = Math.max(this.compWidth, 1);
    const h = Math.max(this.compHeight, 1);
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

  /** Render every visible layer and blend them. */
  composite(
    renderer: THREE.WebGLRenderer,
    transparent: boolean,
    override?: ReadonlyMap<string, ParamRecord>,
  ): THREE.Texture | null {
    const paramsByLayer = override ?? this.authorityParams;
    const composed: CompositeLayer[] = [];
    for (const i of this.visibleIndices()) {
      const slot = this.slots[i]!;
      const state = this.states[i]!;
      const target = this.ensureTarget(i);
      const params = paramsByLayer?.get(state.id);
      if (params) slot.runtime.renderLayerToWithParams(target, params);
      else slot.runtime.renderLayerTo(target, { clear: true });
      composed.push({
        texture: target.texture,
        opacity: this.effectiveOpacityAt(i),
        blendMode: state.blendMode,
      });
    }
    return this.compositor.composite(renderer, composed, this.compWidth, this.compHeight, {
      color: transparent ? '#000000' : this.compBackground,
      alpha: transparent ? 0 : 1,
    });
  }

  /** Per-layer resolved values for the ONE publication the host makes. */
  publishableState(): {
    layerParams: Record<string, ParamRecord>;
    layerOpacity: Record<string, number>;
    layerSourceParams: Record<string, ParamRecord>;
  } {
    const layerParams: Record<string, ParamRecord> = {};
    const layerOpacity: Record<string, number> = {};
    const layerSourceParams: Record<string, ParamRecord> = {};
    for (const [i, s] of this.slots.entries()) {
      const resolved = s.runtime.lastResolved;
      if (resolved) layerParams[s.id] = resolved;
      layerOpacity[s.id] = this.effectiveOpacityAt(i);
      if (s.runtime.hasGenerator) layerSourceParams[s.id] = s.runtime.resolvedSourceParams();
    }
    return { layerParams, layerOpacity, layerSourceParams };
  }

  // ---- diagnostics ----------------------------------------------------------

  get stats(): {
    passes: number;
    bytes: number;
    layerTargetBytes: number;
    runtimes: number;
    staleRuntimes: number;
  } {
    return {
      passes: this.compositor.passes,
      bytes: this.compositor.bytes,
      layerTargetBytes: this.slots.reduce(
        (n, s) => n + (s.target ? s.target.width * s.target.height * 4 : 0),
        0,
      ),
      runtimes: this.slots.length,
      staleRuntimes: this.staleRuntimeCount,
    };
  }
}

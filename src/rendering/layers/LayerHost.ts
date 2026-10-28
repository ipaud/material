import * as THREE from 'three';
import type { ParamRecord } from '@shared/schemas/project';
import type { RawVisualStats, VisualSignalId } from '@/signals/visual/types';
import { LayerCompositor, type CompositeLayer } from './LayerCompositor';
import { requirementsOf, type LayerRequirements, type LayerRuntime } from './layerRuntime';
import type { LayerRenderState } from './layerTypes';
import type { TechniqueRenderer } from '@/techniques/types';

const EMPTY_DEMAND: ReadonlySet<VisualSignalId> = new Set();
/** Scratch pairs kept per size: the preview's and one export size. */
const MAX_SCRATCH_SIZES = 2;

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
  private readonly techniqueScratchBySize = new Map<string, [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]>();
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
    this.releaseTechniqueScratch();
    for (const slot of this.slots) {
      slot.target?.dispose();
      slot.target = null;
      slot.rendererGeneration = this.rendererGeneration;
      if (renderer) slot.runtime.initBranch(renderer);
    }
    this.syncTechniqueScratch();
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
    this.syncTechniqueScratch();
  }

  setTechniqueChain(
    layerId: string,
    stages: readonly { stageId: string; renderer: TechniqueRenderer; params: ParamRecord }[],
  ): void {
    this.slots.find((slot) => slot.id === layerId)?.runtime.setTechniqueChain(stages);
    this.syncTechniqueScratch();
  }

  setTechniqueStageParams(params: ReadonlyMap<string, ReadonlyMap<string, ParamRecord>>): void {
    for (const slot of this.slots) slot.runtime.setTechniqueStageParams(params.get(slot.id) ?? new Map());
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
    this.syncTechniqueScratch();
  }

  /** Every layer allocated its targets on the SAME lost context, so each has
   * to rebuild. The host owns the canvas listener; runtimes never see the
   * event and would otherwise keep dead handles. */
  handleContextRestored(): void {
    this.compositor.release();
    this.releaseTechniqueScratch();
    for (const s of this.slots) {
      s.target?.dispose();
      s.target = null;
      s.runtime.handleContextRestored();
    }
    this.syncTechniqueScratch();
  }

  disposeAll(): void {
    this.releaseTechniqueScratch();
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

  /** Serial layer: its input is the composite beneath it (see Layer.input). */
  isSerial(layerId: string): boolean {
    return this.states.find((s) => s.id === layerId)?.input === 'below';
  }

  /** Does any visible serial layer carry state that must be advanced every frame? */
  anySerialLayerIsStateful(): boolean {
    return this.states.some(
      (s, i) =>
        s.input === 'below' &&
        s.enabled &&
        (this.slots[i]?.runtime.isFeedbackTechnique ||
          this.slots[i]?.runtime.isTemporalActive ||
          this.slots[i]?.runtime.needsFlowOrStats),
    );
  }

  /** Per-layer work queued until that layer's input exists, keyed by kind (latest wins). */
  private deferred = new Map<string, Map<string, () => void>>();

  /**
   * Run `work` for a layer's export preparation. An ordinary layer prepares now.
   * A serial layer cannot: its input is the composite of the layers beneath it,
   * which does not exist until the compositor reaches it this frame, so the work
   * is queued and runs inside `composite()` right after the input is bound.
   */
  prepare(layerId: string, kind: string, work: () => void): void {
    if (!this.isSerial(layerId)) {
      work();
      return;
    }
    let queue = this.deferred.get(layerId);
    if (!queue) {
      queue = new Map();
      this.deferred.set(layerId, queue);
    }
    queue.set(kind, work);
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
    | ((layerId: string) => (base: ParamRecord, timeSec: number, stageId?: string) => ParamRecord)
    | null = null;
  private opacitySink: ((layerId: string, opacity: number) => { opacity: number }) | null = null;
  private authorityParams: ReadonlyMap<string, ParamRecord> | undefined;
  private authorityOpacity: ReadonlyMap<string, number> | undefined;
  private authorityEnabled: ReadonlyMap<string, boolean> | undefined;

  setParamTransformFactory(
    make: ((layerId: string) => (base: ParamRecord, timeSec: number, stageId?: string) => ParamRecord) | null,
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
    if (!state || state.blendMode !== 'normal' || (state.input ?? 'source') !== 'source') return null;
    if (this.effectiveOpacityAt(only) < 1) return null;
    return only;
  }

  /** Draw straight to the canvas when the fast path applies. */
  renderSingleOpaqueToCanvas(renderer: THREE.WebGLRenderer): boolean {
    const index = this.singleOpaqueIndex();
    if (index === null) return false;
    if (this.slots[index]!.runtime.hasTechniqueChain) return false;
    this.slots[index]!.runtime.renderLayerToCanvas(renderer);
    return true;
  }

  /**
   * v0.8.3: the preview fast path draws into the layer's OWN target and hands
   * the texture back, so the engine's one canvas write can apply the sRGB
   * transfer. Drawing straight onto the canvas put the technique's raw
   * (linear) output on screen — see RenderEngine.blit.
   */
  renderSingleOpaqueToOwnTarget(_renderer: THREE.WebGLRenderer): THREE.Texture | null {
    const index = this.singleOpaqueIndex();
    if (index === null) return null;
    const target = this.ensureTarget(index);
    this.slots[index]!.runtime.renderLayerTo(target, { clear: true });
    return target.texture;
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

  private releaseTechniqueScratch(): void {
    this.techniqueScratchBySize.forEach((pair) => pair.forEach((target) => target.dispose()));
    this.techniqueScratchBySize.clear();
    for (const slot of this.slots) slot.runtime.setTechniqueScratchTargets(null);
  }

  private syncTechniqueScratch(): void {
    const needed = this.slots.some((slot) => slot.runtime.hasTechniqueChain);
    if (!needed || !this.renderer) {
      this.releaseTechniqueScratch();
      return;
    }
    const w = Math.max(this.compWidth, 1);
    const h = Math.max(this.compHeight, 1);
    // renderStill flips the composition to the export size and back on EVERY
    // frame. Keeping one pair per size (preview + export) stops that from
    // reallocating two full-size targets twice a frame.
    const key = `${w}x${h}`;
    let pair = this.techniqueScratchBySize.get(key);
    if (pair) {
      this.techniqueScratchBySize.delete(key); // re-insert: most recently used last
    } else {
      const create = () => new THREE.WebGLRenderTarget(w, h, {
        depthBuffer: false,
        stencilBuffer: false,
        colorSpace: THREE.SRGBColorSpace,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      pair = [create(), create()];
    }
    this.techniqueScratchBySize.set(key, pair);
    // ponytail: two sizes cover preview + one export size; a third evicts the oldest.
    for (const [oldKey, old] of this.techniqueScratchBySize) {
      if (this.techniqueScratchBySize.size <= MAX_SCRATCH_SIZES) break;
      old.forEach((target) => target.dispose());
      this.techniqueScratchBySize.delete(oldKey);
    }
    for (const slot of this.slots) slot.runtime.setTechniqueScratchTargets(pair);
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
      const draw = (): void => {
        if (params) slot.runtime.renderLayerToWithParams(target, params);
        else slot.runtime.renderLayerTo(target, { clear: true });
      };
      const serial = state.input === 'below';
      if (!serial) {
        slot.runtime.setInputOverride(null);
        draw();
      }
      composed.push({
        // A serial layer is drawn by the compositor, once the layers beneath it
        // have been blended: its input is that accumulated result.
        ...(serial
          ? {
              before: (backdrop: THREE.Texture) => {
                slot.runtime.setInputOverride(backdrop);
                const queued = this.deferred.get(state.id);
                if (queued) {
                  for (const work of queued.values()) work();
                  queued.clear();
                }
                // Export steps history by hand; preview advances it inside the draw.
                slot.runtime.advanceTemporalFromInput();
                draw();
              },
            }
          : {}),
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
    layerStageParams: Record<string, Record<string, ParamRecord>>;
    layerOpacity: Record<string, number>;
    layerSourceParams: Record<string, ParamRecord>;
  } {
    const layerParams: Record<string, ParamRecord> = {};
    const layerStageParams: Record<string, Record<string, ParamRecord>> = {};
    const layerOpacity: Record<string, number> = {};
    const layerSourceParams: Record<string, ParamRecord> = {};
    for (const [i, s] of this.slots.entries()) {
      const resolved = s.runtime.lastResolved;
      if (resolved) layerParams[s.id] = resolved;
      if (Object.keys(s.runtime.lastResolvedStageParams).length > 0) {
        layerStageParams[s.id] = { ...s.runtime.lastResolvedStageParams };
      }
      layerOpacity[s.id] = this.effectiveOpacityAt(i);
      if (s.runtime.hasGenerator) layerSourceParams[s.id] = s.runtime.resolvedSourceParams();
    }
    return { layerParams, layerStageParams, layerOpacity, layerSourceParams };
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

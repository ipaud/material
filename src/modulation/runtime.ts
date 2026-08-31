import type { NumberParamDef } from '@/techniques/types';
import { applyLayerModulations, isLayerTarget, type LayerDynamicState } from './layerState';
import type { ModulationMapping, ParamRecord } from '@shared/schemas/project';
import { getTechnique } from '@/techniques/registry';
import { evalSources, type SourceContext } from './sources';
import { calibrationStore } from '@/signals/visual/calibrationStore';
import { visualDemand } from '@/signals/visual/demand';
import { publishVisualSignals } from '@/signals/visual/publish';
import type { RawVisualStats, VisualSignalId } from '@/signals/visual/types';
import { applySourceModulations, applyModulations, SmoothingState } from './evaluator';
import { applyPulses } from '@/signals/pulseEngine';
import { getTriggerState, liveScheduler } from '@/signals/triggerRuntime';
import { morphRuntime } from '@/performance/morphRuntime';
import { applyMacros } from '@/performance/macros';
import { candidateRuntime } from '@/performance/candidateRuntime';
import type { Macro } from '@shared/schemas/project';

/**
 * Live modulation runtime: the bridge feeds it project state; the render
 * engine calls transform() every frame. Kept outside React entirely.
 */
/** One layer's slice of the modulation problem. */
interface LayerModulation {
  readonly layerId: string;
  readonly techniqueId: string | null;
  /** Mappings that drive THIS layer's technique parameters. */
  readonly mappings: ModulationMapping[];
  /** Which layer's visual signals each of those mappings reads. */
  readonly signalSource: ReadonlyMap<string, string>;
}

class ModulationRuntime {
  private mappings: ModulationMapping[] = [];
  /**
   * v0.6B — the same problem, once per layer.
   *
   * Smoothing, macros, triggers, morph and candidate stay single instances:
   * mapping ids are unique project-wide, and an overlay is a property of the
   * performer's focus rather than of a layer. What gains a layer dimension is
   * only what a layer actually owns — its technique, the mappings pointed at
   * it, and the pixels its signals are measured from.
   */
  private layerMods: LayerModulation[] = [];
  private primaryLayerId: string | null = null;
  private macros: Macro[] = [];
  private techniqueId: string | null = null;
  private sourceCtx: SourceContext = {
    analysis: null,
    durationSec: 0,
    bpm: null,
    beatOffsetSec: 0,
    beatsPerBar: 4,
  };
  private readonly smoothing = new SmoothingState();
  private lastTime = -1;
  /** Latest shaped source values (UI meters / freeze capture). Null until the
   * first `transform()`, so the source-param path can tell "not evaluated yet"
   * from "evaluated to nothing" — `{} ?? x` is `{}`, so an empty-object
   * initialiser made the fallback below unreachable and skipped every
   * `source.*` mapping on the first frame. */
  lastSourceValues: Record<string, number> | null = null;

  // ---- v0.4A: image / motion signals ---------------------------------------
  private visualDemand: ReadonlySet<VisualSignalId> = new Set();
  private visualOrigin: string | null = null;
  private lastVisualStats: RawVisualStats | null = null;
  private lastVisualAtSec = -1;
  /** Per-layer analysis: stats, the wall time they arrived, and the pixel
   * origin their calibration is scoped to. Two layers showing the same camera
   * share an origin key, so they share one calibration envelope. */
  private visualByLayer = new Map<
    string,
    { stats: RawVisualStats | null; atSec: number; origin: string | null }
  >();

  /** Demand the UI adds on its own (an open scope), independent of mappings. */
  private scopeDemand: ReadonlySet<VisualSignalId> = new Set();
  private demandSink: ((ids: ReadonlySet<VisualSignalId>) => void) | null = null;
  private lastDemandKey = '\u0000';

  setVisualDemand(ids: ReadonlySet<VisualSignalId>): void {
    this.visualDemand = ids;
  }

  /**
   * v0.4E — who decides which signals are analysed.
   *
   * It cannot be the project's mapping list alone. A morph resolves an OVERLAY
   * whose modulations replace the project's for as long as it runs, so a Look
   * being morphed TO needs its signals analysed before the morph commits —
   * otherwise its mappings sit dark for the whole transition and snap into
   * life at the end. Candidate preview has the same shape.
   *
   * The runtime is the layer that resolves the overlay, so it is the layer
   * that knows. It pushes the effective set outward; the bridge forwards it to
   * the engine, which owns the GPU.
   */
  setScopeDemand(ids: ReadonlySet<VisualSignalId>): void {
    this.scopeDemand = ids;
    this.lastDemandKey = '\u0000';
  }

  setDemandSink(fn: ((ids: ReadonlySet<VisualSignalId>) => void) | null): void {
    this.demandSink = fn;
    this.lastDemandKey = '\u0000';
  }

  /** True while a morph or audition overlay is replacing the primary layer's
   * mappings, so its demand is not derivable from the project. */
  private overlayActive = false;

  private pushDemand(mappings: readonly ModulationMapping[]): void {
    const ids = visualDemand(mappings, this.scopeDemand as ReadonlySet<string>);
    const key = [...ids].sort().join(',');
    if (key === this.lastDemandKey) return;
    this.lastDemandKey = key;
    this.visualDemand = ids;
    this.demandSink?.(ids);
  }

  /** The pixel origin calibration is scoped to. Null clears publication. */
  setVisualOrigin(origin: string | null): void {
    this.visualOrigin = origin;
  }

  /**
   * Analysed stats arrive here from the engine, one frame BEHIND the params
   * that will consume them. Calibration advances on arrival, so it is driven
   * by analysis cadence rather than render cadence.
   */
  setVisualStats(stats: RawVisualStats | null, atSec: number): void {
    const dt = this.lastVisualAtSec >= 0 ? Math.min(Math.abs(atSec - this.lastVisualAtSec), 1) : 1 / 30;
    this.lastVisualAtSec = atSec;
    this.lastVisualStats = stats;
    calibrationStore.advance(this.visualOrigin, stats, dt);
  }

  /** v0.6B — analysis from ONE layer's pixels. */
  setLayerVisualStats(layerId: string, stats: RawVisualStats | null, atSec: number): void {
    const prev = this.visualByLayer.get(layerId);
    const dt = prev && prev.atSec >= 0 ? Math.min(Math.abs(atSec - prev.atSec), 1) : 1 / 30;
    const origin = prev?.origin ?? null;
    this.visualByLayer.set(layerId, { stats, atSec, origin });
    calibrationStore.advance(origin, stats, dt);
    if (layerId === this.primaryLayerId) {
      this.lastVisualStats = stats;
      this.lastVisualAtSec = atSec;
    }
  }

  /** The pixel origin one layer's calibration is scoped to. */
  setLayerVisualOrigin(layerId: string, origin: string | null): void {
    const prev = this.visualByLayer.get(layerId);
    this.visualByLayer.set(layerId, {
      stats: prev?.stats ?? null,
      atSec: prev?.atSec ?? -1,
      origin,
    });
    if (layerId === this.primaryLayerId) this.visualOrigin = origin;
  }

  /** Signals as published by ONE layer, calibrated to that layer's origin. */
  visualValuesFor(layerId: string): Record<string, number> {
    const entry = this.visualByLayer.get(layerId);
    if (!entry) return {};
    return publishVisualSignals(entry.stats, this.visualDemand, (id, raw) =>
      calibrationStore.value(entry.origin, id, raw),
    );
  }

  /** Which visual signals each layer must analyse, given where routes read
   * from. A layer nobody reads analyses nothing and releases its targets. */
  demandByLayer(): Map<string, ReadonlySet<VisualSignalId>> {
    const out = new Map<string, Set<VisualSignalId>>();
    for (const entry of this.layerMods) out.set(entry.layerId, new Set());
    for (const entry of this.layerMods) {
      for (const m of entry.mappings) {
        if (!m.enabled) continue;
        const from = entry.signalSource.get(m.id) ?? entry.layerId;
        const bucket = out.get(from);
        if (!bucket) continue;
        for (const id of visualDemand([m], new Set())) bucket.add(id);
      }
    }
    // An open scope watches the layer the performer is looking at.
    if (this.primaryLayerId && this.scopeDemand.size > 0) {
      const bucket = out.get(this.primaryLayerId);
      if (bucket) for (const id of this.scopeDemand) bucket.add(id as VisualSignalId);
    }
    // A morph or audition replaces the primary layer's mappings with a Look's,
    // so its demand cannot be read off the project. Fold the effective set in
    // for as long as one runs, or the incoming Look's signals sit dark for the
    // whole transition and snap into life at the end (the v0.4E lesson).
    if (this.overlayActive && this.primaryLayerId) {
      const bucket = out.get(this.primaryLayerId);
      if (bucket) for (const id of this.visualDemand) bucket.add(id);
    }
    return new Map([...out].map(([k, v]) => [k, v as ReadonlySet<VisualSignalId>]));
  }

  /** The pixel origin calibration is currently scoped to (scope readout). */
  get visualOriginKey(): string | null {
    return this.visualOrigin;
  }

  /** Latest published visual values — also what the scope reads. */
  visualValues(): Record<string, number> {
    return publishVisualSignals(this.lastVisualStats, this.visualDemand, (id, raw) =>
      calibrationStore.value(this.visualOrigin, id, raw),
    );
  }

  get visualStats(): RawVisualStats | null {
    return this.lastVisualStats;
  }

  /** Soak diagnostics: the calibration cache is bounded by the project's
   * source count, so this must not grow while sources are merely cycled. */
  get calibrationSize(): number {
    return calibrationStore.size;
  }

  configure(mappings: ModulationMapping[], techniqueId: string | null, ctx: SourceContext): void {
    this.mappings = mappings;
    this.techniqueId = techniqueId;
    this.sourceCtx = ctx;
  }

  /**
   * v0.6B — the whole stack at once. `primaryLayerId` is the layer an overlay
   * (morph, candidate audition) applies to and the one the scope reads.
   */
  configureLayers(entries: readonly LayerModulation[], primaryLayerId: string | null): void {
    this.layerMods = [...entries];
    this.primaryLayerId = primaryLayerId;
    const primary = entries.find((e) => e.layerId === primaryLayerId);
    // Keep the single-layer view coherent for everything that still asks for
    // it: FREEZE, the scope, the source-param path and the export evaluator.
    this.mappings = primary ? primary.mappings : [];
    this.techniqueId = primary?.techniqueId ?? null;
    this.visualOrigin = primaryLayerId
      ? (this.visualByLayer.get(primaryLayerId)?.origin ?? null)
      : null;
    for (const id of [...this.visualByLayer.keys()]) {
      if (!entries.some((e) => e.layerId === id)) this.visualByLayer.delete(id);
    }
  }

  /**
   * v0.6C — resolve ONE layer's own state (opacity), as opposed to the state
   * of the technique inside it. Same evaluator, same Add/Set rules, same
   * freeze; only the target namespace differs.
   */
  resolveLayerState(
    layerId: string,
    stored: LayerDynamicState,
    timeSec: number,
  ): LayerDynamicState {
    const entry = this.layerMods.find((e) => e.layerId === layerId);
    if (!entry) return stored;
    const layerMappings = entry.mappings.filter((m) => isLayerTarget(m.target));
    if (layerMappings.length === 0) return stored;
    return applyLayerModulations(
      stored,
      layerMappings,
      this.sourcesFor(entry, timeSec),
      this.smoothing,
      this.previewDt(timeSec),
    );
  }

  /** Resolve ONE layer's technique parameters. */
  transformFor(layerId: string, base: ParamRecord, timeSec: number): ParamRecord {
    if (layerId === this.primaryLayerId) return this.transform(base, timeSec);
    const entry = this.layerMods.find((e) => e.layerId === layerId);
    if (!entry?.techniqueId) return base;
    const definition = getTechnique(entry.techniqueId);
    if (!definition) return base;
    const dt = this.previewDt(timeSec);
    // A non-primary layer takes no overlay: a morph or an audition is scoped
    // to what the performer is holding, and applying it to every layer would
    // make one gesture rewrite the whole composition.
    const modulated = applyModulations(
      applyMacros(base, this.macros, definition),
      entry.mappings,
      this.sourcesFor(entry, timeSec),
      definition,
      this.smoothing,
      dt,
    );
    const { triggers, ctx } = getTriggerState();
    return applyPulses(
      modulated,
      triggers,
      timeSec,
      ctx,
      definition,
      liveScheduler.livePulseContributions(timeSec),
    );
  }

  /**
   * Source values for one layer. Everything that is not a visual signal —
   * audio, time, beat, pattern — is composition-wide and identical for every
   * layer; only the image and motion families are read per layer, from
   * whichever layer each mapping routes to.
   */
  private sourcesFor(entry: LayerModulation, timeSec: number): Record<string, number> {
    const own = this.visualValuesFor(entry.layerId);
    const routed = new Set(
      [...entry.signalSource.values()].filter((id) => id !== entry.layerId),
    );
    let visual = own;
    if (routed.size > 0) {
      // A cross-layer route replaces the signal wholesale: a mapping reads
      // exactly one layer's image, never a blend of two.
      visual = { ...own };
      for (const from of routed) Object.assign(visual, this.visualValuesFor(from));
    }
    return evalSources(timeSec, { ...this.sourceCtx, visual });
  }

  configureMacros(macros: Macro[]): void {
    this.macros = macros;
  }

  hasActiveMappings(): boolean {
    return this.mappings.some((m) => m.enabled);
  }

  private lastWallSec = -1;

  /**
   * The step smoothing advances by, in PREVIEW.
   *
   * Transport time is the right clock while the transport is moving: it keeps
   * a mapping reproducible and it is what export replays. But a live source
   * with the transport parked is exactly the v0.6 performance case — a camera
   * feeding one layer while another reacts to it — and there transport time
   * never advances, so `dt` collapsed to zero and every smoothed mapping froze
   * at its first sample. Measured on a camera route: the raw signal moved
   * 0.13 to 0.20 while the driven parameter sat at 296.3042 forever.
   *
   * So: transport time when it is moving, wall clock when it is not. This is
   * the same rule the calibration store already follows, and for the same
   * reason. Export never reaches here — it runs its own evaluator, stepped by
   * a fixed 1/fps — so determinism is untouched.
   */
  private previewDt(timeSec: number): number {
    // Computed ONCE per rendered frame. Several things ask for it now — the
    // primary layer, each secondary layer, each layer's own opacity — and a
    // function that advances its own clock would have split one frame's dt
    // between them and quietly slowed every smoothed mapping by the layer
    // count.
    if (this.frameDt !== null) return this.frameDt;
    const wall = performance.now() / 1000;
    const transportDt = this.lastTime >= 0 ? Math.abs(timeSec - this.lastTime) : 0;
    const wallDt = this.lastWallSec >= 0 ? Math.abs(wall - this.lastWallSec) : 0;
    this.lastWallSec = wall;
    // A stopped transport reports a dt of exactly zero, not a small one.
    const dt = this.lastTime < 0 ? 1 / 60 : Math.min(transportDt > 0 ? transportDt : wallDt, 0.1);
    this.frameDt = dt;
    return dt;
  }

  private frameDt: number | null = null;

  /** The engine calls this once at the top of every rendered frame. */
  markFrame(): void {
    this.frameDt = null;
  }

  /** Shaped current value of one mapping (0..1) — used by FREEZE. */
  currentShapedValue(mappingId: string): number | null {
    return this.smoothing.peek(mappingId) ?? null;
  }

  /** CE1F: resolve generator params for this frame (editor authority). */
  transformSource(
    base: ParamRecord,
    timeSec: number,
    paramDefs: readonly NumberParamDef[],
  ): ParamRecord {
    if (!this.mappings.some((m) => m.enabled && m.target.startsWith('source.'))) return base;
    const dt = this.lastTime >= 0 ? Math.min(Math.abs(timeSec - this.lastTime), 0.1) : 1 / 60;
    const sources = this.lastSourceValues ?? evalSources(timeSec, this.sourceCtx);
    // NOTE: source params intentionally read the PREVIOUS frame's values —
    // see the one-frame-delay contract in docs/SIGNALS.md.
    return applySourceModulations(base, this.mappings, sources, paramDefs, this.smoothing, dt);
  }

  transform(base: ParamRecord, timeSec: number): ParamRecord {
    // An armed morph replaces the base layer entirely: params, modulations
    // and triggers all come from the interpolated look core. CANDIDATE
    // preview does the same for auditioning — visual only, never committed
    // (Phase 16). Morph wins: MUTATE is blocked while one runs.
    const overlay = morphRuntime.resolveOverlay(timeSec) ?? candidateRuntime.resolveOverlay();
    // Before any early return: demand has to track the overlay even on a frame
    // this function decides not to resolve.
    this.overlayActive = overlay !== null;
    this.pushDemand(overlay ? overlay.modulations : this.mappings);
    const techniqueId = overlay?.techniqueId ?? this.techniqueId;
    if (!techniqueId) return base;
    const definition = getTechnique(techniqueId);
    if (!definition) return base;
    const dt = this.previewDt(timeSec);
    this.lastTime = timeSec;
    // The primary layer routes like any other: a mapping on it may read
    // another layer's image, and that has to reach the evaluator here too or
    // cross-layer routing would work everywhere except where the performer is
    // looking.
    const primary = this.layerMods.find((e) => e.layerId === this.primaryLayerId);
    const sources = primary
      ? this.sourcesFor(primary, timeSec)
      : evalSources(timeSec, { ...this.sourceCtx, visual: this.visualValues() });
    this.lastSourceValues = sources;
    // Evaluation order (docs/PARAMETER_EVALUATION.md):
    // (morph base) → macros → continuous modulation (freeze inside) →
    // pulses → clamp. Macros ride ON TOP of look/morph state (§13) — they
    // are performance state, applied after the overlay, never stored into
    // Looks.
    const effectiveBase = applyMacros(overlay ? overlay.params : base, this.macros, definition);
    const effectiveMappings = overlay ? overlay.modulations : this.mappings;
    const modulated = applyModulations(
      effectiveBase,
      effectiveMappings,
      sources,
      definition,
      this.smoothing,
      dt,
    );
    const { triggers, ctx } = getTriggerState();
    const effectiveTriggers = overlay ? overlay.triggers : triggers;
    return applyPulses(
      modulated,
      effectiveTriggers,
      timeSec,
      ctx,
      definition,
      liveScheduler.livePulseContributions(timeSec),
    );
  }

  reset(): void {
    this.visualByLayer.clear();
    this.lastVisualStats = null;
    this.lastVisualAtSec = -1;
    this.lastSourceValues = null;
    calibrationStore.reset();
    this.smoothing.reset();
    this.lastTime = -1;
    this.lastWallSec = -1;
    this.frameDt = null;
  }
}

export const modulationRuntime = new ModulationRuntime();

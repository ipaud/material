import type { NumberParamDef } from '@/techniques/types';
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
class ModulationRuntime {
  private mappings: ModulationMapping[] = [];
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

  configureMacros(macros: Macro[]): void {
    this.macros = macros;
  }

  hasActiveMappings(): boolean {
    return this.mappings.some((m) => m.enabled);
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
    this.pushDemand(overlay ? overlay.modulations : this.mappings);
    const techniqueId = overlay?.techniqueId ?? this.techniqueId;
    if (!techniqueId) return base;
    const definition = getTechnique(techniqueId);
    if (!definition) return base;
    const dt = this.lastTime >= 0 ? Math.min(Math.abs(timeSec - this.lastTime), 0.1) : 1 / 60;
    this.lastTime = timeSec;
    const sources = evalSources(timeSec, { ...this.sourceCtx, visual: this.visualValues() });
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
    this.lastVisualStats = null;
    this.lastVisualAtSec = -1;
    this.lastSourceValues = null;
    calibrationStore.reset();
    this.smoothing.reset();
    this.lastTime = -1;
  }
}

export const modulationRuntime = new ModulationRuntime();

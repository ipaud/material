import type { ModulationMapping, ParamRecord } from '@shared/schemas/project';
import { getTechnique } from '@/techniques/registry';
import { evalSources, type SourceContext } from './sources';
import { applyModulations, SmoothingState } from './evaluator';
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
  /** Latest shaped source values (UI meters / freeze capture). */
  lastSourceValues: Record<string, number> = {};

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

  transform(base: ParamRecord, timeSec: number): ParamRecord {
    // An armed morph replaces the base layer entirely: params, modulations
    // and triggers all come from the interpolated look core. CANDIDATE
    // preview does the same for auditioning — visual only, never committed
    // (Phase 16). Morph wins: MUTATE is blocked while one runs.
    const overlay = morphRuntime.resolveOverlay(timeSec) ?? candidateRuntime.resolveOverlay();
    const techniqueId = overlay?.techniqueId ?? this.techniqueId;
    if (!techniqueId) return base;
    const definition = getTechnique(techniqueId);
    if (!definition) return base;
    const dt = this.lastTime >= 0 ? Math.min(Math.abs(timeSec - this.lastTime), 0.1) : 1 / 60;
    this.lastTime = timeSec;
    const sources = evalSources(timeSec, this.sourceCtx);
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
    this.smoothing.reset();
    this.lastTime = -1;
  }
}

export const modulationRuntime = new ModulationRuntime();

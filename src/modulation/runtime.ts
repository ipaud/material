import type { ModulationMapping, ParamRecord } from '@shared/schemas/project';
import { getTechnique } from '@/techniques/registry';
import { evalSources, type SourceContext } from './sources';
import { applyModulations, SmoothingState } from './evaluator';

/**
 * Live modulation runtime: the bridge feeds it project state; the render
 * engine calls transform() every frame. Kept outside React entirely.
 */
class ModulationRuntime {
  private mappings: ModulationMapping[] = [];
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

  hasActiveMappings(): boolean {
    return this.mappings.some((m) => m.enabled);
  }

  /** Shaped current value of one mapping (0..1) — used by FREEZE. */
  currentShapedValue(mappingId: string): number | null {
    return this.smoothing.peek(mappingId) ?? null;
  }

  transform(base: ParamRecord, timeSec: number): ParamRecord {
    if (!this.techniqueId || this.mappings.length === 0) return base;
    const definition = getTechnique(this.techniqueId);
    if (!definition) return base;
    const dt = this.lastTime >= 0 ? Math.min(Math.abs(timeSec - this.lastTime), 0.1) : 1 / 60;
    this.lastTime = timeSec;
    const sources = evalSources(timeSec, this.sourceCtx);
    this.lastSourceValues = sources;
    return applyModulations(base, this.mappings, sources, definition, this.smoothing, dt);
  }

  reset(): void {
    this.smoothing.reset();
    this.lastTime = -1;
  }
}

export const modulationRuntime = new ModulationRuntime();

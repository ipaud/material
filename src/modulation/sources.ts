import { sampleTrack, type AudioAnalysis, type TrackId } from '@/audio/analysis';
import { divisionPhase, type MusicalDivision } from '@/audio/beatGrid';
import { evaluatePattern } from '@/pattern/evaluatePattern';
import { patternClockAt } from '@/pattern/patternClock';
import { recordPatternDiagnostic, type PatternSourceHandle } from '@/pattern/patternSourceRuntime';
import { PATTERN_INACTIVE } from '@/pattern/patternTypes';

export interface ModSourceDef {
  id: string;
  label: string;
  group: 'audio' | 'time' | 'beat' | 'pattern' | 'image' | 'motion';
}

export const MOD_SOURCES: ModSourceDef[] = [
  { id: 'master', label: 'Master', group: 'audio' },
  { id: 'rms', label: 'RMS', group: 'audio' },
  { id: 'peak', label: 'Peak', group: 'audio' },
  { id: 'bass', label: 'Bass', group: 'audio' },
  { id: 'mids', label: 'Mids', group: 'audio' },
  { id: 'highs', label: 'Highs', group: 'audio' },
  { id: 'centroid', label: 'Centroid', group: 'audio' },
  { id: 'flux', label: 'Flux', group: 'audio' },
  { id: 'onset', label: 'Onset', group: 'audio' },
  { id: 'transients', label: 'Transients', group: 'audio' },
  { id: 'time', label: 'Time · 0–1 over the clip', group: 'time' },
  // Raw seconds. Pair with the From/To window (in seconds) for a ramp that does not
  // depend on how long the clip is: From 54, To 220 = enter at 0:54, full at 3:40.
  { id: 'time.sec', label: 'Time · seconds', group: 'time' },
  { id: 'beat:bar', label: 'Beat · Bar', group: 'beat' },
  { id: 'beat:1/2', label: 'Beat · 1/2', group: 'beat' },
  { id: 'beat:1/4', label: 'Beat · 1/4', group: 'beat' },
  { id: 'beat:1/8', label: 'Beat · 1/8', group: 'beat' },
  { id: 'beat:1/16', label: 'Beat · 1/16', group: 'beat' },
  // v0.4A — the image itself. Values are injected per frame (ctx.visual);
  // see docs/SIGNALS.md for the RAW/CALIBRATED split and the N-1 contract.
  { id: 'image.luminance', label: 'Luminance', group: 'image' },
  { id: 'image.contrast', label: 'Contrast', group: 'image' },
  { id: 'image.edgeEnergy', label: 'Edge Energy', group: 'image' },
  { id: 'motion.amount', label: 'Motion Amount', group: 'motion' },
  { id: 'motion.activity', label: 'Motion Activity', group: 'motion' },
  { id: 'motion.x', label: 'Motion X', group: 'motion' },
  { id: 'motion.y', label: 'Motion Y', group: 'motion' },
  { id: 'motion.centroidX', label: 'Motion Centre X', group: 'motion' },
  { id: 'motion.centroidY', label: 'Motion Centre Y', group: 'motion' },
];

export interface SourceContext {
  analysis: AudioAnalysis | null;
  durationSec: number;
  bpm: number | null;
  beatOffsetSec: number;
  beatsPerBar: number;
  /**
   * P4: compiled pattern sources (see patternSourceRuntime). Each emits
   * `pattern:<id>` — or NOTHING when inactive (degrade-gated, boolean value,
   * compile error, no BPM): an absent key is the resolver's true neutral,
   * the mapping is skipped entirely.
   */
  patterns?: PatternSourceHandle[];
  /** P4: deterministic probability seed — project.explore.lastSeed ?? 1. */
  projectSeed?: number;
  /**
   * v0.4A: image/motion signal values sampled from the PREVIOUS analysed
   * frame. Injected rather than computed here, because these are the one
   * signal family that is not a function of `(project, analysis, timeSec)` —
   * they read pixels. Same precedent as `patterns`: the caller resolves, this
   * function stays pure with respect to its arguments.
   */
  visual?: Record<string, number>;
}

/**
 * Evaluate every modulation source at an exact time. Pure + deterministic:
 * preview and export produce identical values for identical inputs.
 */
export function evalSources(timeSec: number, ctx: SourceContext): Record<string, number> {
  const values: Record<string, number> = {};
  const audioTracks: TrackId[] = [
    'master',
    'rms',
    'peak',
    'bass',
    'mids',
    'highs',
    'centroid',
    'flux',
    'onset',
    'transients',
  ];
  for (const id of audioTracks) {
    values[id] = ctx.analysis ? sampleTrack(ctx.analysis, id, timeSec) : 0;
  }
  values['time.sec'] = Math.max(timeSec, 0);
  values.time = ctx.durationSec > 0 ? Math.min(Math.max(timeSec / ctx.durationSec, 0), 1) : 0;
  const divisions: MusicalDivision[] = ['bar', '1/2', '1/4', '1/8', '1/16'];
  for (const div of divisions) {
    values[`beat:${div}`] =
      ctx.bpm && ctx.bpm > 0
        ? divisionPhase(timeSec, ctx.bpm, ctx.beatOffsetSec, div, ctx.beatsPerBar)
        : 0;
  }
  // P4: pattern sources. SourceContext is structurally a PatternTiming —
  // patterns read the same resolved grid as beat sources, so they cannot
  // drift. No BPM → patternClockAt returns null → no keys → every pattern
  // mapping is neutral (P1 contract, no 120 fallback). Numeric-only in P4:
  // boolean values stay engine-internal and contribute nothing (documented).
  if (ctx.patterns && ctx.patterns.length > 0) {
    const projectSeed = ctx.projectSeed ?? 1;
    for (const handle of ctx.patterns) {
      // Every handle reports its state every pass, including the ones that
      // cannot produce a value — otherwise a source that turns invalid (or
      // loses its grid) would keep showing its last healthy diagnostic.
      const clock = handle.compiled ? patternClockAt(timeSec, ctx, handle.beatsPerCycle) : null;
      if (!handle.compiled || !clock) {
        recordPatternDiagnostic(handle, 0, PATTERN_INACTIVE);
        continue;
      }
      const result = evaluatePattern(handle.compiled, clock, {
        projectSeed,
        patternId: handle.id,
      });
      recordPatternDiagnostic(handle, clock.cycleIndex, result);
      if (!result.active || typeof result.value !== 'number') continue;
      values[handle.sourceKey] = Math.min(Math.max(result.value, 0), 1);
    }
  }
  // v0.4A: merged last so a visual signal id can never be shadowed by an
  // audio track that happens to share a name (none do — the dotted family
  // prefix guarantees it — but the ordering makes the intent explicit).
  if (ctx.visual) {
    for (const [id, v] of Object.entries(ctx.visual)) {
      if (Number.isFinite(v)) values[id] = v;
    }
  }
  return values;
}

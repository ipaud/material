import { beatsAt } from '@/audio/beatGrid';

/**
 * PatternClock (Pattern Engine P1) — a pure temporal VIEW over MATERIAL's
 * existing composition-time authority. It owns no time, no timer, no BPM:
 * callers pass the composition time they already have (live: the
 * PlaybackController tick; export: startSec + i/fps) plus the project's
 * timeline grid, and get musical coordinates back.
 *
 * Everything derives from beatGrid.beatsAt — the same primitive behind
 * modulation beat sources, trigger events and quantization, so Pattern
 * timing can never drift from the rest of the instrument.
 *
 * NO BPM → null (established product convention: beat sources emit 0,
 * deterministic triggers emit nothing, the monitor says "SET BPM FOR BEAT
 * SIGNALS" — patterns are simply inactive until a grid exists; no invented
 * 120 BPM fallback).
 *
 * Pre-roll (t < beatOffsetSec): indices go NEGATIVE (mathematical floor),
 * phases stay in [0,1). This deliberately diverges from the UI's
 * musicalPosition (which clamps to BAR 1 for the readout): pattern
 * evaluation needs a stable, seek-safe index everywhere on the timeline —
 * a clamped plateau would make transforms and deterministic probability
 * ambiguous before the grid start.
 */

export interface PatternTiming {
  /** Resolved authoritative BPM (manual or detected) — null = no grid. */
  bpm: number | null;
  beatOffsetSec: number;
  beatsPerBar: number;
}

export interface PatternClockState {
  timeSec: number;
  bpm: number;
  /** Whole beats since grid start (negative in pre-roll). */
  beatIndex: number;
  /** [0,1) position inside the current beat. */
  beatPhase: number;
  barIndex: number;
  barPhase: number;
  cycleIndex: number;
  cyclePhase: number;
  beatsPerBar: number;
  beatsPerCycle: number;
}

/** Default: one cycle = 4 beats (one bar at 4/4) — configurable per pattern. */
export const DEFAULT_BEATS_PER_CYCLE = 4;

function split(units: number): { index: number; phase: number } {
  const index = Math.floor(units);
  const phase = units - index;
  // Exact boundaries must land on phase 0 of the NEXT unit, never 1.0 of the
  // previous one; floating error can produce 0.9999999999999999 here.
  if (phase > 1 - 1e-12) return { index: index + 1, phase: 0 };
  return { index, phase };
}

/**
 * Musical coordinates at an exact composition time. Pure: same inputs →
 * same output, forever — seek, export and the Output authority all agree by
 * construction.
 */
export function patternClockAt(
  timeSec: number,
  timing: PatternTiming,
  beatsPerCycle: number = DEFAULT_BEATS_PER_CYCLE,
): PatternClockState | null {
  const { bpm, beatOffsetSec } = timing;
  if (bpm === null || !Number.isFinite(bpm) || bpm <= 0) return null;
  if (!Number.isFinite(timeSec)) return null;
  if (!Number.isFinite(beatsPerCycle) || beatsPerCycle <= 0) return null;
  const beatsPerBar = Math.max(1, Math.floor(timing.beatsPerBar) || 1);

  const beats = beatsAt(timeSec, bpm, beatOffsetSec);
  const beat = split(beats);
  const bar = split(beats / beatsPerBar);
  const cycle = split(beats / beatsPerCycle);

  return {
    timeSec,
    bpm,
    beatIndex: beat.index,
    beatPhase: beat.phase,
    barIndex: bar.index,
    barPhase: bar.phase,
    cycleIndex: cycle.index,
    cyclePhase: cycle.phase,
    beatsPerBar,
    beatsPerCycle,
  };
}

/** Convenience: timing view of a project's timeline block. */
export function timingFromTimeline(timeline: {
  bpm: number | null;
  beatOffsetSec: number;
  beatsPerBar: number;
}): PatternTiming {
  return {
    bpm: timeline.bpm,
    beatOffsetSec: timeline.beatOffsetSec,
    beatsPerBar: timeline.beatsPerBar,
  };
}

/**
 * Manual BPM beat grid. Pure functions — deterministic for export.
 * Musical divisions are phase ramps 0..1 (sawtooth) derived from clock+BPM;
 * modulation curves can turn them into pulses.
 */

export type MusicalDivision = 'bar' | '1/2' | '1/4' | '1/8' | '1/16';

export const DIVISION_BEATS: Record<MusicalDivision, number> = {
  bar: 4, // assumes 4/4 — good default until time signatures exist
  '1/2': 2,
  '1/4': 1,
  '1/8': 0.5,
  '1/16': 0.25,
};

/** Beats elapsed at timeSec for a given bpm/offset (can be negative before offset). */
export function beatsAt(timeSec: number, bpm: number, beatOffsetSec: number): number {
  return ((timeSec - beatOffsetSec) * bpm) / 60;
}

/** Phase 0..1 within the given musical division. */
export function divisionPhase(
  timeSec: number,
  bpm: number,
  beatOffsetSec: number,
  division: MusicalDivision,
): number {
  const beats = beatsAt(timeSec, bpm, beatOffsetSec) / DIVISION_BEATS[division];
  return beats - Math.floor(beats);
}

/** Beat timestamps within [startSec, endSec] for grid drawing. */
export function beatTimes(
  startSec: number,
  endSec: number,
  bpm: number,
  beatOffsetSec: number,
): number[] {
  if (bpm <= 0) return [];
  const beatDur = 60 / bpm;
  const first = Math.ceil((startSec - beatOffsetSec) / beatDur);
  const times: number[] = [];
  for (let b = first; beatOffsetSec + b * beatDur <= endSec; b++) {
    times.push(beatOffsetSec + b * beatDur);
  }
  return times;
}

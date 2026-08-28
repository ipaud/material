/**
 * Manual BPM beat grid. Pure functions — deterministic for export.
 * Musical divisions are phase ramps 0..1 (sawtooth) derived from clock+BPM;
 * modulation curves can turn them into pulses.
 */

export type MusicalDivision = 'bar' | '1/2' | '1/4' | '1/8' | '1/16';

/** Beats per division; 'bar' depends on the time signature. */
export function divisionBeats(division: MusicalDivision, beatsPerBar = 4): number {
  switch (division) {
    case 'bar':
      return beatsPerBar;
    case '1/2':
      return 2;
    case '1/4':
      return 1;
    case '1/8':
      return 0.5;
    case '1/16':
      return 0.25;
  }
}

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
  beatsPerBar = 4,
): number {
  const beats = beatsAt(timeSec, bpm, beatOffsetSec) / divisionBeats(division, beatsPerBar);
  return beats - Math.floor(beats);
}

/**
 * Musical position readout: 1-based bar and beat plus intra-beat fraction.
 * Times before the grid start (t < beatOffsetSec) clamp to BAR 1 · BEAT 1 —
 * a pre-roll region, not negative bars.
 */
export function musicalPosition(
  timeSec: number,
  bpm: number,
  beatOffsetSec: number,
  beatsPerBar = 4,
): { bar: number; beat: number; phase: number } {
  const beats = beatsAt(timeSec, bpm, beatOffsetSec);
  if (beats < 0) return { bar: 1, beat: 1, phase: 0 };
  const whole = Math.floor(beats);
  return {
    bar: Math.floor(whole / beatsPerBar) + 1,
    beat: (whole % beatsPerBar) + 1,
    phase: beats - whole,
  };
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

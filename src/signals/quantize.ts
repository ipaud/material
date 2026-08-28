import type { QuantizeMode } from '@shared/schemas/project';

/**
 * Next musical boundary at or after `timeSec`. Pure — both the live scheduler
 * and export replay quantize through this one function.
 * Returns `timeSec` unchanged for 'off' or when no BPM exists (nothing to
 * quantize to).
 */
export function nextBoundary(
  timeSec: number,
  mode: QuantizeMode,
  bpm: number | null,
  beatOffsetSec: number,
  beatsPerBar: number,
): number {
  if (mode === 'off' || !bpm || bpm <= 0) return timeSec;
  const beatSec = 60 / bpm;
  const unitSec =
    mode === 'beat'
      ? beatSec
      : mode === 'bar'
        ? beatSec * beatsPerBar
        : mode === '2bars'
          ? beatSec * beatsPerBar * 2
          : beatSec * beatsPerBar * 4;
  const rel = (timeSec - beatOffsetSec) / unitSec;
  const EPS = 1e-9;
  // A time already exactly on the boundary executes now, not a unit later.
  const next = Math.abs(rel - Math.round(rel)) < EPS ? Math.round(rel) : Math.ceil(rel);
  return beatOffsetSec + next * unitSec;
}

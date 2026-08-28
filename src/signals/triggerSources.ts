import type { AudioAnalysis } from '@/audio/analysis';
import type { TimelineMarker } from '@shared/schemas/project';

/**
 * Trigger sources produce EVENT TIMES — exact composition times, computed as
 * pure functions of (grid, analysis, markers). Never thresholds sampled on a
 * UI tick: an event either lies in an interval or it does not, identically in
 * preview and export.
 */

export interface TriggerContext {
  bpm: number | null;
  beatOffsetSec: number;
  beatsPerBar: number;
  analysis: AudioAnalysis | null;
  markers: TimelineMarker[];
}

/** True for sources whose events are reproducible in export. */
export function isDeterministicSource(source: string): boolean {
  return source !== 'manual' && !source.startsWith('key:') && !source.startsWith('midi:');
}

function gridUnitSec(source: string, ctx: TriggerContext): number | null {
  if (!ctx.bpm || ctx.bpm <= 0) return null;
  const beat = 60 / ctx.bpm;
  switch (source) {
    case 'beat':
      return beat;
    case 'bar':
      return beat * ctx.beatsPerBar;
    case 'div:1/2':
      return beat * 2;
    case 'div:1/4':
      return beat;
    case 'div:1/8':
      return beat / 2;
    case 'div:1/16':
      return beat / 4;
    default:
      return null;
  }
}

// ---- onset events ----

/** Peak-picking thresholds for the onset envelope. */
const ONSET_THRESHOLD = 0.3;
const ONSET_MIN_SEPARATION_SEC = 0.12;

const onsetCache = new WeakMap<AudioAnalysis, Float32Array>();

/**
 * Discrete onset event times: local maxima of the onset track above threshold
 * with a minimum separation. Cached per analysis — pure and deterministic.
 */
export function onsetEventTimes(analysis: AudioAnalysis): Float32Array {
  const cached = onsetCache.get(analysis);
  if (cached) return cached;
  const track = analysis.tracks.onset;
  const times: number[] = [];
  let lastTime = -Infinity;
  for (let i = 1; i < track.length - 1; i++) {
    const v = track[i] as number;
    if (v < ONSET_THRESHOLD) continue;
    if (v < (track[i - 1] as number) || v < (track[i + 1] as number)) continue;
    const t = i * analysis.hopSec;
    if (t - lastTime < ONSET_MIN_SEPARATION_SEC) continue;
    times.push(t);
    lastTime = t;
  }
  const result = Float32Array.from(times);
  onsetCache.set(analysis, result);
  return result;
}

// ---- event queries ----

/** Sorted event times of a source in the half-open interval (t0, t1]. */
export function eventTimesBetween(
  source: string,
  t0: number,
  t1: number,
  ctx: TriggerContext,
): number[] {
  if (t1 <= t0) return [];
  const unit = gridUnitSec(source, ctx);
  if (unit !== null) {
    const out: number[] = [];
    const first = Math.floor((t0 - ctx.beatOffsetSec) / unit) + 1;
    for (let k = first; ctx.beatOffsetSec + k * unit <= t1; k++) {
      const t = ctx.beatOffsetSec + k * unit;
      if (t > t0) out.push(t);
    }
    return out;
  }
  if (source === 'onset') {
    if (!ctx.analysis) return [];
    const all = onsetEventTimes(ctx.analysis);
    const out: number[] = [];
    for (let i = 0; i < all.length; i++) {
      const t = all[i] as number;
      if (t > t0 && t <= t1) out.push(t);
      if (t > t1) break;
    }
    return out;
  }
  if (source.startsWith('marker:')) {
    const id = source.slice(7);
    return ctx.markers
      .filter((m) => m.id === id && m.timeSec > t0 && m.timeSec <= t1)
      .map((m) => m.timeSec)
      .sort((a, b) => a - b);
  }
  // 'manual' / 'key:*' / 'midi:*' have no schedulable times.
  return [];
}

/**
 * Event times in [t - windowSec, t], newest last — the pulse evaluator's
 * query. Cooldown filtering must see events from before the window so a
 * long-cooldown mapping doesn't re-arm at the window edge; callers pass an
 * extended lookback via `windowSec` when cooldown > window.
 */
export function eventTimesInWindow(
  source: string,
  t: number,
  windowSec: number,
  ctx: TriggerContext,
): number[] {
  return eventTimesBetween(source, t - windowSec - 1e-9, t + 1e-9, ctx);
}

/**
 * Apply a per-mapping cooldown to a sorted event list: an event is accepted
 * only if it is at least `cooldownSec` after the previously ACCEPTED one.
 * Sequential over the deterministic event list → still deterministic.
 */
export function applyCooldown(times: number[], cooldownSec: number): number[] {
  if (cooldownSec <= 0 || times.length === 0) return times;
  const out: number[] = [];
  let lastAccepted = -Infinity;
  for (const t of times) {
    if (t - lastAccepted >= cooldownSec) {
      out.push(t);
      lastAccepted = t;
    }
  }
  return out;
}

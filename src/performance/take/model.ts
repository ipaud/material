import type { PerformanceTake, TakeEvent, TakeLane } from '@shared/schemas/project';

/**
 * v0.7 — the pure half of Performance Capture.
 *
 * Everything here is a function of its arguments: no stores, no clock, no
 * engine. That is what lets preview, seek and export share ONE interpretation
 * of a Take instead of three that agree until they do not.
 */

// ---- Control targets ------------------------------------------------------

export type ControlTarget =
  | { kind: 'layerOpacity'; layerId: string }
  | { kind: 'macro'; macroId: string }
  | { kind: 'param'; layerId: string; paramId: string };

export function layerOpacityTarget(layerId: string): string {
  return `layer:${layerId}:opacity`;
}

export function macroTarget(macroId: string): string {
  return `macro:${macroId}`;
}

export function paramTarget(layerId: string, paramId: string): string {
  return `param:${layerId}:${paramId}`;
}

/**
 * Parse a stored target id. Returns null for anything unrecognised, which is
 * how a Take written by a newer build degrades: that lane goes unresolved and
 * inert (§27/§131) rather than taking the project down with it.
 */
export function parseControlTarget(target: string): ControlTarget | null {
  const parts = target.split(':');
  if (parts[0] === 'macro' && parts.length === 2 && parts[1]) {
    return { kind: 'macro', macroId: parts[1] };
  }
  if (parts[0] === 'layer' && parts.length === 3 && parts[1] && parts[2] === 'opacity') {
    return { kind: 'layerOpacity', layerId: parts[1] };
  }
  // A param id may itself contain ':' from a shader pack namespace, so the
  // layer id is the second field and everything after it is the param.
  if (parts[0] === 'param' && parts.length >= 3 && parts[1]) {
    return { kind: 'param', layerId: parts[1], paramId: parts.slice(2).join(':') };
  }
  return null;
}

// ---- Continuous lanes -----------------------------------------------------

/**
 * The lane's value at Take-relative time `t`, linearly interpolated.
 *
 * HELD at both ends. Before the first sample that is not an approximation:
 * the recorder writes the pre-gesture value as the lane's first sample the
 * instant a control is first touched, so holding it backwards reproduces
 * exactly the value the performer was looking at. After the last sample it is
 * the only honest answer — the performer let go and left it there.
 *
 * Binary search rather than a scan: a ten-minute Take is a real target
 * (§138), and this is called once per lane per frame in preview, per lane per
 * frame in export, and again for every preroll frame.
 */
export function laneValueAt(lane: TakeLane, t: number): number | null {
  const s = lane.samples;
  if (s.length === 0) return null;
  const first = s[0] as { t: number; v: number };
  if (t <= first.t) return first.v;
  const last = s[s.length - 1] as { t: number; v: number };
  if (t >= last.t) return last.v;

  let lo = 0;
  let hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((s[mid] as { t: number }).t <= t) lo = mid;
    else hi = mid;
  }
  const a = s[lo] as { t: number; v: number };
  const b = s[hi] as { t: number; v: number };
  const span = b.t - a.t;
  if (span <= 0) return b.v;
  if (lane.interp === 'hold') return a.v;
  const x = (t - a.t) / span;
  const k = lane.interp === 'smooth' ? x * x * (3 - 2 * x) : x;
  return a.v + k * (b.v - a.v);
}

/**
 * Ramer–Douglas–Peucker over the (t, v) polyline, with the tolerance in the
 * VALUE domain and time carried along.
 *
 * A 60 Hz hand produces ~600 samples in ten seconds, nearly all of them on a
 * straight line between two the performer would recognise. Endpoints are
 * always kept, so trim boundaries and the final resting value survive.
 */
export function simplifyLane(
  samples: readonly { t: number; v: number }[],
  epsilon: number,
): { t: number; v: number }[] {
  if (samples.length <= 2 || epsilon <= 0) return samples.map((s) => ({ ...s }));
  const keep = new Uint8Array(samples.length);
  keep[0] = 1;
  keep[samples.length - 1] = 1;

  // Iterative, because a pathological 36 000-sample lane would blow a
  // recursive stack and a ten-minute Take is an explicit target.
  const stack: [number, number][] = [[0, samples.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop() as [number, number];
    if (hi - lo < 2) continue;
    const a = samples[lo] as { t: number; v: number };
    const b = samples[hi] as { t: number; v: number };
    const dt = b.t - a.t;
    let worst = -1;
    let worstIndex = -1;
    for (let i = lo + 1; i < hi; i++) {
      const p = samples[i] as { t: number; v: number };
      // Vertical distance to the chord: the error a replay would actually
      // show, which perpendicular distance is not (it mixes seconds into the
      // value domain and makes the tolerance depend on gesture speed).
      const chord = dt === 0 ? a.v : a.v + ((p.t - a.t) / dt) * (b.v - a.v);
      const d = Math.abs(p.v - chord);
      if (d > worst) {
        worst = d;
        worstIndex = i;
      }
    }
    if (worst > epsilon && worstIndex > 0) {
      keep[worstIndex] = 1;
      stack.push([lo, worstIndex], [worstIndex, hi]);
    }
  }
  const out: { t: number; v: number }[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (keep[i]) out.push({ ...(samples[i] as { t: number; v: number }) });
  }
  return out;
}

/**
 * Stored precision for a lane point.
 *
 * A raw composition time is a full double — `123.45678901234567` — and so is a
 * value that came off a fader. Serialised, that is 47 bytes a point, and a
 * ten-minute six-handed performance is 1.7 MB of digits nobody can perceive.
 *
 * Four decimals on each halves it. The time error is 0.05 ms against a 16.7 ms
 * frame; the value error is 0.00005 against a simplification tolerance of
 * 0.004 that the gesture has already been through — eighty times larger. The
 * rounding is absolute rather than relative, so a parameter that runs 0..4096
 * keeps every digit that could matter and a 0..1 fader keeps four it does not.
 */
export const STORED_DECIMALS = 4;

export function quantiseSamples(
  samples: readonly { t: number; v: number }[],
): { t: number; v: number }[] {
  return samples.map((s) => ({
    t: Number(s.t.toFixed(STORED_DECIMALS)),
    v: Number(s.v.toFixed(STORED_DECIMALS)),
  }));
}

/** Largest value error simplification introduced, in the lane's own domain. */
export function laneError(
  original: readonly { t: number; v: number }[],
  simplified: readonly { t: number; v: number }[],
): number {
  if (simplified.length === 0) return 0;
  const lane: TakeLane = { target: '', samples: simplified as { t: number; v: number }[] };
  let worst = 0;
  for (const s of original) {
    const v = laneValueAt(lane, s.t);
    if (v === null) continue;
    worst = Math.max(worst, Math.abs(v - s.v));
  }
  return worst;
}

// ---- Discrete events ------------------------------------------------------

/**
 * Deterministic replay order: time first, then the monotonic sequence number
 * the recorder stamped. Two events at the same `t` are common — a Look recall
 * and the Freeze the same hand hit in the same frame — and JS sort stability
 * across engines is not a contract worth staking determinism on.
 */
export function compareEvents(a: TakeEvent, b: TakeEvent): number {
  return a.t === b.t ? a.order - b.order : a.t - b.t;
}

export function sortedEvents(take: PerformanceTake): TakeEvent[] {
  return [...take.events].sort(compareEvents);
}

/** Events at or before `t`, in replay order. */
export function eventsUpTo(events: readonly TakeEvent[], t: number): TakeEvent[] {
  return events.filter((e) => e.t <= t + 1e-9);
}

/** Events in (t0, t1] — the live crossing set for one advanced frame. */
export function eventsBetween(
  events: readonly TakeEvent[],
  t0: number,
  t1: number,
): TakeEvent[] {
  return events.filter((e) => e.t > t0 + 1e-9 && e.t <= t1 + 1e-9);
}

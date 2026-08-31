import type { PerformanceTake, TakeBaseline, TakeEvent, TakeLane } from '@shared/schemas/project';
import { compareEvents, laneValueAt, simplifyLane, sortedEvents } from './model';

/**
 * v0.7C — minimal Take editing.
 *
 * Practical cleanup, not a timeline editor. Every operation here is a pure
 * `Take → Take`, which is what lets the store wrap them in one undo entry and
 * what lets the replay evaluator stay untouched: an edited Take is just
 * another Take.
 *
 * What is deliberately absent, and stays absent (§62, §161): media tracks,
 * clips, waveforms, nested takes, Bézier handles, per-property lanes for
 * hidden runtime state, and any notion of placing a Take on a project
 * timeline.
 *
 * Continuous points are addressed by INDEX inside their lane, unlike events,
 * which carry stable ids. That asymmetry is deliberate: an event is a thing
 * the performer did and may want to move or delete years later, while a point
 * is one sample of a gesture — it has no identity worth persisting, and giving
 * every one of thirty-six thousand samples a string id would triple a Take's
 * size for nothing.
 */

function withLane(take: PerformanceTake, target: string, next: TakeLane | null): PerformanceTake {
  const lanes = take.lanes
    .map((l) => (l.target === target ? next : l))
    .filter((l): l is TakeLane => l !== null && l.samples.length > 0);
  return { ...take, lanes };
}

function laneOf(take: PerformanceTake, target: string): TakeLane | undefined {
  return take.lanes.find((l) => l.target === target);
}

/** Re-sorted, so a moved point never leaves a lane non-monotonic. */
function normalise(samples: readonly { t: number; v: number }[]): { t: number; v: number }[] {
  const sorted = [...samples].map((s) => ({ ...s })).sort((a, b) => a.t - b.t);
  // Two points at one instant make interpolation ambiguous; the later one wins,
  // matching how the recorder collapses a gesture made with a parked transport.
  const out: { t: number; v: number }[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.t - s.t) < 1e-9) last.v = s.v;
    else out.push(s);
  }
  return out;
}

// ---- Discrete events ------------------------------------------------------

export function deleteEvent(take: PerformanceTake, eventId: string): PerformanceTake {
  return { ...take, events: take.events.filter((e) => e.id !== eventId) };
}

/** Move one event in time. `order` is untouched — it is identity, not position. */
export function moveEvent(take: PerformanceTake, eventId: string, t: number): PerformanceTake {
  const clamped = Math.min(Math.max(t, 0), take.durationSec);
  return {
    ...take,
    events: take.events.map((e) => (e.id === eventId ? { ...e, t: clamped } : e)),
  };
}

// ---- Continuous points ----------------------------------------------------

export function movePoint(
  take: PerformanceTake,
  target: string,
  index: number,
  t: number,
  v: number,
): PerformanceTake {
  const lane = laneOf(take, target);
  if (!lane || index < 0 || index >= lane.samples.length) return take;
  const samples = lane.samples.map((s, i) =>
    i === index ? { t: Math.min(Math.max(t, 0), take.durationSec), v } : { ...s },
  );
  return withLane(take, target, { ...lane, samples: normalise(samples) });
}

export function addPoint(
  take: PerformanceTake,
  target: string,
  t: number,
  v?: number,
): PerformanceTake {
  const lane = laneOf(take, target);
  if (!lane) return take;
  const clamped = Math.min(Math.max(t, 0), take.durationSec);
  // Adding a point without a value means "give me a handle here", so it takes
  // the value the lane already has: dropping it in must not move the gesture.
  const value = v ?? laneValueAt(lane, clamped) ?? 0;
  return withLane(take, target, {
    ...lane,
    samples: normalise([...lane.samples, { t: clamped, v: value }]),
  });
}

export function deletePoint(take: PerformanceTake, target: string, index: number): PerformanceTake {
  const lane = laneOf(take, target);
  if (!lane || index < 0 || index >= lane.samples.length) return take;
  return withLane(take, target, {
    ...lane,
    samples: lane.samples.filter((_, i) => i !== index).map((s) => ({ ...s })),
  });
}

/**
 * Delete a stretch of a gesture.
 *
 * The lane keeps a point at each edge of the hole, holding the value it had
 * there, so the removed stretch becomes a straight line between what came
 * before and what came after rather than a discontinuity that snaps.
 */
export function deleteRange(
  take: PerformanceTake,
  target: string,
  from: number,
  to: number,
): PerformanceTake {
  const lane = laneOf(take, target);
  if (!lane || to <= from) return take;
  const before = laneValueAt(lane, from);
  const after = laneValueAt(lane, to);
  const kept = lane.samples.filter((s) => s.t < from || s.t > to).map((s) => ({ ...s }));
  const edges: { t: number; v: number }[] = [];
  if (before !== null) edges.push({ t: from, v: before });
  if (after !== null) edges.push({ t: to, v: after });
  return withLane(take, target, { ...lane, samples: normalise([...kept, ...edges]) });
}

export function deleteLane(take: PerformanceTake, target: string): PerformanceTake {
  return { ...take, lanes: take.lanes.filter((l) => l.target !== target) };
}

/** Re-simplify one lane, or every lane, at a chosen tolerance. */
export function simplifyTake(take: PerformanceTake, epsilon: number, target?: string): PerformanceTake {
  return {
    ...take,
    lanes: take.lanes
      .map((l) =>
        target && l.target !== target ? l : { ...l, samples: simplifyLane(l.samples, epsilon) },
      )
      .filter((l) => l.samples.length > 0),
  };
}

// ---- Trim ----------------------------------------------------------------

/**
 * The state-carrying events that were trimmed off the front, folded back in.
 *
 * A Take trimmed to start at 5s whose Freeze happened at 2s still has to
 * REPLAY frozen — the performance was frozen when the kept stretch began. So
 * the last dropped event of each identity is re-emitted at the new origin.
 *
 * A morph is re-emitted as a recall of its TARGET Look, including one whose
 * window straddled the new start: the transition itself was trimmed away, and
 * its end state is what the kept stretch inherits. Recorded order is preserved
 * through `order`, so two folded events still land in the sequence they were
 * played in.
 */
function foldDroppedEvents(dropped: readonly TakeEvent[]): TakeEvent[] {
  const latest = new Map<string, TakeEvent>();
  for (const event of dropped) {
    const key =
      event.kind === 'layer.enable'
        ? `enable:${event.layerId ?? ''}`
        : event.kind === 'freeze.set'
          ? 'freeze'
          : 'look'; // look.recall and morph.start both settle the same thing
    const folded: TakeEvent =
      event.kind === 'morph.start'
        ? { ...event, kind: 'look.recall', morph: null }
        : { ...event };
    latest.set(key, { ...folded, t: 0 });
  }
  return [...latest.values()].sort(compareEvents);
}

/** Trim to `[from, to]` in Take-relative seconds. */
export function trimTake(take: PerformanceTake, from: number, to: number): PerformanceTake {
  const start = Math.max(from, 0);
  const end = Math.min(to, take.durationSec);
  if (end <= start) return take;

  const lanes: TakeLane[] = [];
  for (const lane of take.lanes) {
    // A sample AT each new boundary, or replay would begin at whatever the
    // nearest surviving point happened to be instead of the value the gesture
    // actually had there (§70).
    const atStart = laneValueAt(lane, start);
    const atEnd = laneValueAt(lane, end);
    const inside = lane.samples.filter((s) => s.t > start && s.t < end);
    const samples = normalise([
      ...(atStart === null ? [] : [{ t: start, v: atStart }]),
      ...inside.map((s) => ({ ...s })),
      ...(atEnd === null ? [] : [{ t: end, v: atEnd }]),
    ]).map((s) => ({ t: Number((s.t - start).toFixed(6)), v: s.v }));
    if (samples.length > 0) lanes.push({ ...lane, samples });
  }

  const all = sortedEvents(take);
  const dropped = all.filter((e) => e.t < start);
  const kept = all
    .filter((e) => e.t >= start && e.t <= end)
    .map((e) => ({ ...e, t: Number((e.t - start).toFixed(6)) }));

  const baseline: TakeBaseline = {
    ...take.baseline,
    lanes: { ...take.baseline.lanes },
    layerEnabled: { ...take.baseline.layerEnabled },
    frozen: { ...take.baseline.frozen },
  };
  for (const lane of lanes) {
    baseline.lanes[lane.target] = (lane.samples[0] as { v: number }).v;
  }

  return {
    ...take,
    startSec: Number((take.startSec + start).toFixed(6)),
    durationSec: Number((end - start).toFixed(6)),
    lanes,
    events: [...foldDroppedEvents(dropped), ...kept].sort(compareEvents),
    baseline,
  };
}

// ---- Reporting -----------------------------------------------------------

export interface TakeStats {
  lanes: number;
  samples: number;
  events: number;
  /** Serialised size of just this Take, in bytes. */
  bytes: number;
  eventsPerMinute: number;
  bytesPerMinute: number;
}

export function takeStats(take: PerformanceTake): TakeStats {
  const samples = take.lanes.reduce((n, l) => n + l.samples.length, 0);
  const bytes = new TextEncoder().encode(JSON.stringify(take)).length;
  const minutes = Math.max(take.durationSec / 60, 1e-6);
  return {
    lanes: take.lanes.length,
    samples,
    events: take.events.length,
    bytes,
    eventsPerMinute: take.events.length / minutes,
    bytesPerMinute: bytes / minutes,
  };
}

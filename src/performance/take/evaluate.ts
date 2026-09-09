import type {
  MorphCurve,
  PerformanceTake,
  Project,
  TakeBaseline,
  TakeEvent,
} from '@shared/schemas/project';
import {
  eventsBetween,
  eventsUpTo,
  laneValueAt,
  parseControlTarget,
  sortedEvents,
} from './model';

/**
 * v0.7 — THE canonical Take evaluator (§99).
 *
 * Preview, seek and export all come through here. Nothing else is allowed to
 * interpret a Take: three implementations of "what does this Take mean at
 * time t" agree right up until a seek, and then disagree silently.
 *
 * Split in two on purpose:
 *
 *   resolveTakeAt()      pure — continuous lanes → values. No side effects,
 *                        no history, safe at any t in any order, which is
 *                        what makes seek and subrange export possible.
 *   replayDiscreteUpTo() effectful — discrete intent dispatched into a
 *                        TakePerformer. Order matters, so this reconstructs
 *                        from the Take origin rather than sampling.
 */

/** One frame's worth of Take-controlled continuous state. */
export interface ResolvedTake {
  /** layer id → opacity 0..1 */
  opacity: Map<string, number>;
  /** macro id → value 0..1 */
  macros: Map<string, number>;
  /** layer id → param id → value, in the parameter's own domain */
  params: Map<string, Record<string, number>>;
}

export function emptyResolvedTake(): ResolvedTake {
  return { opacity: new Map(), macros: new Map(), params: new Map() };
}

/**
 * Composition time → Take-relative time, or null when the playhead has not
 * reached the Take.
 *
 * Past the recorded end the Take keeps holding its last values instead of
 * releasing: the performer stopped with the faders where they were, and
 * snapping back to the document would put a visible jolt at the end of every
 * export. Before the start it contributes nothing at all — that stretch is
 * the project's own state, and it is what a baseline restores to.
 */
export function takeRelativeTime(take: PerformanceTake, compositionSec: number): number | null {
  const rel = compositionSec - take.startSec;
  return rel < 0 ? null : rel;
}

/** Pure: the Take's continuous state at a composition time. */
export function resolveTakeAt(take: PerformanceTake, compositionSec: number): ResolvedTake {
  const out = emptyResolvedTake();
  const rel = takeRelativeTime(take, compositionSec);
  if (rel === null) return out;
  for (const lane of take.lanes) {
    const target = parseControlTarget(lane.target);
    if (!target) continue; // unresolved lane — inert, never a crash (§131)
    const v = laneValueAt(lane, rel);
    if (v === null) continue;
    if (target.kind === 'layerOpacity') {
      out.opacity.set(target.layerId, Math.min(Math.max(v, 0), 1));
    } else if (target.kind === 'macro') {
      out.macros.set(target.macroId, Math.min(Math.max(v, 0), 1));
    } else {
      const bucket = out.params.get(target.layerId) ?? {};
      bucket[target.paramId] = v;
      out.params.set(target.layerId, bucket);
    }
  }
  return out;
}

// ---- Discrete intent ------------------------------------------------------

export interface TakeMorphSpec {
  durationMode: 'seconds' | 'beats' | 'bars';
  durationValue: number;
  curve: MorphCurve;
}

/**
 * What a Take needs to be able to DO. Deliberately not `ActionTarget`: that
 * vocabulary is the trigger engine's and addresses Looks by SLOT, while a
 * Take addresses them by stable id — a slot is a keyboard shortcut the
 * performer can reassign, and a Take that followed slot 3 around would recall
 * a different Look after any reshuffle (§28).
 *
 * Two implementations, exactly as ActionTarget has two: the live one writes
 * the store, the export one writes the frame evaluator's working copy.
 */
export interface TakePerformer {
  restoreBaseline(baseline: TakeBaseline): void;
  /**
   * Carry time-based state forward to a composition time.
   *
   * Reconstruction dispatches events in order but does not, on its own, let
   * TIME pass between them — and a morph is a thing that finishes by time
   * passing. A morph started at 42.9s over two bars is over by 47.9s, but a
   * seek to 66s left it armed at progress 1 forever: its overlay then covered
   * the Look the Take recalled at 60.7s, and the next transport tick committed
   * the morph target into the document, destroying that recall. Reconstruction
   * has to retire what it re-creates.
   *
   * Live playback ticks the morph runtime every frame anyway, so this is
   * belt-and-braces there. Export needs nothing: its virtual morphs retire
   * themselves through their own `applied` flag.
   */
  advanceTo(compositionSec: number): void;
  recallLook(lookId: string): void;
  /** `atComposition` is absolute — a morph's schedule is timeline state. */
  startMorph(lookId: string, atComposition: number, spec: TakeMorphSpec): void;
  setFreeze(on: boolean): void;
  setLayerEnabled(layerId: string, on: boolean): void;
}

function dispatch(
  event: TakeEvent,
  take: PerformanceTake,
  performer: TakePerformer,
): void {
  switch (event.kind) {
    case 'look.recall':
      if (event.lookId) performer.recallLook(event.lookId);
      return;
    case 'morph.start':
      if (event.lookId && event.morph) {
        performer.startMorph(event.lookId, take.startSec + event.t, event.morph);
      }
      return;
    case 'freeze.set':
      if (event.on !== null) performer.setFreeze(event.on);
      return;
    case 'layer.enable':
      if (event.layerId && event.on !== null) performer.setLayerEnabled(event.layerId, event.on);
      return;
  }
}

/**
 * Reconstruct Take-controlled discrete state at a composition time.
 *
 * Baseline first, then EVERY event from the Take origin up to `t`, in order.
 * Not "the last event of each kind": a Look recall at 2s followed by a Morph
 * at 6s means the morph interpolates FROM that Look, and sampling the final
 * state of each kind independently loses which came first. Event counts are
 * small — a performance has tens of button presses, not thousands — so
 * replaying them is cheaper than any scheme clever enough to avoid it (§50).
 */
export function replayDiscreteUpTo(
  take: PerformanceTake,
  compositionSec: number,
  performer: TakePerformer,
): void {
  performer.restoreBaseline(take.baseline);
  const rel = takeRelativeTime(take, compositionSec);
  if (rel === null) return;
  for (const event of eventsUpTo(sortedEvents(take), rel)) {
    // Let time reach this event before it fires, so anything the previous
    // events started has finished by the moment it actually finished.
    performer.advanceTo(take.startSec + event.t);
    dispatch(event, take, performer);
  }
  performer.advanceTo(compositionSec);
}

/**
 * Live playback: dispatch only what the playhead crossed since the last
 * frame. `fromComposition` is exclusive, `toComposition` inclusive.
 *
 * Distinct from the reconstruction above, and the distinction is the whole
 * design (§45). Crossing is what a moving playhead needs — a Look recall must
 * fire once, not once per frame. Reconstruction is what a SEEK needs, because
 * there is no previous frame to have crossed anything.
 */
export function replayDiscreteBetween(
  take: PerformanceTake,
  fromComposition: number,
  toComposition: number,
  performer: TakePerformer,
): void {
  const t0 = fromComposition - take.startSec;
  const t1 = toComposition - take.startSec;
  if (t1 < 0) return;
  // Half-open (t0, t1] everywhere EXCEPT the Take origin, which is inclusive
  // because nothing precedes it. Without that, an event the performer played
  // in the very frame they hit record was crossed by no interval at all and
  // vanished from live playback — while a seek, which reconstructs from the
  // origin, still had it. The two paths disagreeing at exactly one instant is
  // the failure mode the seek-equals-walk gate exists to catch.
  const events = sortedEvents(take);
  const crossed = t0 <= 0 ? eventsUpTo(events, t1) : eventsBetween(events, t0, t1);
  for (const event of crossed) {
    performer.advanceTo(take.startSec + event.t);
    dispatch(event, take, performer);
  }
}

// ---- Diagnostics ----------------------------------------------------------

export interface TakeResolution {
  unresolvedLanes: string[];
  unresolvedEvents: string[];
}

/**
 * Which of a Take's targets no longer exist. A deleted layer or Look does not
 * invalidate a performance — the event goes inert and the panel says so, so
 * the recording survives long enough for the target to come back (§27/§131).
 */
export function resolveAgainstProject(
  take: PerformanceTake,
  project: Project,
): TakeResolution {
  const layerIds = new Set(project.layers.map((l) => l.id));
  const macroIds = new Set(project.macros.map((m) => m.id));
  const lookIds = new Set(project.pinnedLooks.map((l) => l.id));
  const unresolvedLanes: string[] = [];
  for (const lane of take.lanes) {
    const target = parseControlTarget(lane.target);
    if (!target) {
      unresolvedLanes.push(lane.target);
      continue;
    }
    const ok =
      target.kind === 'macro' ? macroIds.has(target.macroId) : layerIds.has(target.layerId);
    if (!ok) unresolvedLanes.push(lane.target);
  }
  const unresolvedEvents: string[] = [];
  for (const event of take.events) {
    const ok =
      event.kind === 'layer.enable'
        ? event.layerId !== null && layerIds.has(event.layerId)
        : event.kind === 'freeze.set'
          ? true
          : event.lookId !== null && lookIds.has(event.lookId);
    if (!ok) unresolvedEvents.push(event.id);
  }
  return { unresolvedLanes, unresolvedEvents };
}

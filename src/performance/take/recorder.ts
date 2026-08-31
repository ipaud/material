import type {
  LookCore,
  PerformanceTake,
  TakeBaseline,
  TakeEvent,
  TakeLane,
} from '@shared/schemas/project';
import { simplifyLane } from './model';
import { uid } from '@/utils/id';

/**
 * v0.7B — the recorder.
 *
 * It observes; it never applies. Every gesture reaches state through the
 * action it always did, and passes a copy through here on the way. That is
 * what keeps recording from changing what MATERIAL does when it is off.
 *
 * Anti-recursion is STRUCTURAL, not a filter (§35/§36). Nothing on the replay
 * path imports this module: `gestures.ts` — the human-facing wrappers the UI,
 * keyboard and MIDI call — records and applies, while `livePerformer.ts`
 * applies only, through the primitives underneath. A replayed Look recall
 * therefore cannot record itself, because the function that would record it is
 * not in its call graph. An `origin` enum checked at runtime would have
 * relied on every future call site remembering to pass the right one.
 */

/** Maximum stored samples per second, per lane (§21). */
export const SAMPLE_HZ = 60;
const MIN_SAMPLE_DT = 1 / SAMPLE_HZ;

/** Value change below which a sample is redundant, in a 0..1 control domain. */
export const CONTROL_EPSILON = 0.002;

/** Post-recording simplification tolerance, same domain (§65). */
export const SIMPLIFY_EPSILON = 0.004;

export type RecorderState = 'idle' | 'armed' | 'recording';

interface LaneBuffer {
  /** Accepted samples, strictly increasing in t. */
  samples: { t: number; v: number }[];
  /** Latest value seen but not yet accepted — flushed on stop (§23). */
  pending: { t: number; v: number } | null;
  /** Domain span, so epsilon means the same thing for a 0..1 fader and a
   * parameter that runs 0..4096. */
  span: number;
}

export interface RecorderSnapshot {
  state: RecorderState;
  startSec: number;
  elapsedSec: number;
  eventCount: number;
  laneCount: number;
  sampleCount: number;
}

class TakeRecorder {
  private state: RecorderState = 'idle';
  private startSec = 0;
  private nowSec = 0;
  private order = 0;
  private lanes = new Map<string, LaneBuffer>();
  private events: TakeEvent[] = [];
  private baseline: TakeBaseline = { lanes: {}, layerEnabled: {}, frozen: {}, lookCore: null, activeLookId: null };

  get recording(): boolean {
    return this.state === 'recording';
  }

  get armed(): boolean {
    return this.state === 'armed';
  }

  snapshot(): RecorderSnapshot {
    let sampleCount = 0;
    for (const lane of this.lanes.values()) sampleCount += lane.samples.length;
    return {
      state: this.state,
      startSec: this.startSec,
      elapsedSec: this.state === 'recording' ? Math.max(this.nowSec - this.startSec, 0) : 0,
      eventCount: this.events.length,
      laneCount: this.lanes.size,
      sampleCount,
    };
  }

  arm(): void {
    if (this.state === 'idle') this.state = 'armed';
  }

  disarm(): void {
    if (this.state === 'armed') this.state = 'idle';
  }

  /**
   * Begin recording at a composition time, with the state the performance
   * starts from. Called when an armed transport starts, or immediately when
   * REC is pressed on a transport already running.
   */
  begin(compositionSec: number, baseline: TakeBaseline): void {
    this.state = 'recording';
    this.startSec = compositionSec;
    this.nowSec = compositionSec;
    this.order = 0;
    this.lanes.clear();
    this.events = [];
    this.baseline = {
      lanes: { ...baseline.lanes },
      layerEnabled: { ...baseline.layerEnabled },
      frozen: { ...baseline.frozen },
      lookCore: baseline.lookCore,
      activeLookId: baseline.activeLookId,
    };
  }

  /** The transport tick, so a Take that ends in silence still records it. */
  tick(compositionSec: number): void {
    if (this.state === 'recording' && compositionSec > this.nowSec) {
      this.nowSec = compositionSec;
    }
  }

  /**
   * A continuous control moved.
   *
   * `restingValue` is where the control sat BEFORE this gesture: it seeds both
   * the baseline and the lane's first sample, so replaying backwards past the
   * gesture shows exactly what the performer was looking at rather than the
   * first value they happened to drag through.
   */
  control(
    target: string,
    value: number,
    compositionSec: number,
    restingValue: number,
    span = 1,
  ): void {
    if (this.state !== 'recording') return;
    const t = Math.max(compositionSec - this.startSec, 0);
    this.nowSec = Math.max(this.nowSec, compositionSec);
    let lane = this.lanes.get(target);
    if (!lane) {
      // The resting sample sits ONE SAMPLE PERIOD before the touch, not at it.
      // Two samples cannot share a timestamp in a lane that has to stay
      // strictly increasing, and putting both at `t` meant the first movement
      // overwrote the resting value — so the whole stretch before a gesture
      // replayed at the value the performer dragged TO, not the one they
      // started from. Backdating by 1/60s is not a fabrication: the recorder
      // was running, nothing had moved, and 1/60s is its own resolution.
      const seedT = Math.max(t - MIN_SAMPLE_DT, 0);
      lane = { samples: [{ t: seedT, v: restingValue }], pending: null, span: Math.max(span, 1e-9) };
      this.lanes.set(target, lane);
      if (this.baseline.lanes[target] === undefined) {
        this.baseline.lanes[target] = restingValue;
      }
    }
    const last = lane.samples[lane.samples.length - 1] as { t: number; v: number };
    const epsilon = CONTROL_EPSILON * lane.span;

    // A parked transport still records: composition time is not advancing, so
    // the gesture collapses onto the single instant it happened at, latest
    // value winning. Appending would break the lane's strict monotonicity and
    // make interpolation ambiguous at that t (§38).
    if (t <= last.t) {
      last.v = value;
      lane.pending = null;
      return;
    }
    if (t - last.t < MIN_SAMPLE_DT || Math.abs(value - last.v) < epsilon) {
      lane.pending = { t, v: value };
      return;
    }
    lane.samples.push({ t, v: value });
    lane.pending = null;
  }

  /**
   * Snapshot the creative state a Look recall is about to replace.
   *
   * Lazy and once, exactly like a continuous lane's resting value: the state
   * that matters is the one immediately before the first recall, and a Take
   * that never recalls anything pays nothing.
   */
  captureLookBaseline(core: LookCore, activeLookId: string | null): void {
    if (this.state !== 'recording' || this.baseline.lookCore !== null) return;
    this.baseline = { ...this.baseline, lookCore: core, activeLookId };
  }

  /** A discrete gesture happened. */
  event(patch: Omit<TakeEvent, 'id' | 't' | 'order'>, compositionSec: number): void {
    if (this.state !== 'recording') return;
    const t = Math.max(compositionSec - this.startSec, 0);
    this.nowSec = Math.max(this.nowSec, compositionSec);
    this.events.push({ ...patch, id: uid('tev'), t, order: this.order++ });
  }

  /**
   * Finish. Returns null when nothing was played — an empty Take is not worth
   * a slot in the project (§129).
   *
   * `simplify` is off for the tests that assert raw sampling; the product
   * path always simplifies.
   */
  stop(compositionSec: number, name: string, simplify = true): PerformanceTake | null {
    if (this.state !== 'recording') return null;
    const end = Math.max(compositionSec, this.nowSec);
    const durationSec = Math.max(end - this.startSec, 0);
    const lanes: TakeLane[] = [];
    for (const [target, buffer] of this.lanes) {
      // The endpoint the rate limiter was holding back. Without this a
      // gesture that ends inside the last 1/60s replays to the wrong resting
      // value — and the resting value is the one that stays on screen.
      const last = buffer.samples[buffer.samples.length - 1] as { t: number; v: number };
      if (buffer.pending && buffer.pending.v !== last.v) {
        if (buffer.pending.t > last.t) buffer.samples.push(buffer.pending);
        else last.v = buffer.pending.v;
      }
      const samples = simplify
        ? simplifyLane(buffer.samples, SIMPLIFY_EPSILON * buffer.span)
        : buffer.samples;
      if (samples.length > 0) lanes.push({ target, samples });
    }
    const events = [...this.events];
    this.state = 'idle';
    this.lanes.clear();
    this.events = [];
    if (lanes.length === 0 && events.length === 0) return null;
    return {
      id: uid('take'),
      name,
      createdAt: new Date().toISOString(),
      startSec: this.startSec,
      durationSec,
      lanes,
      events,
      baseline: this.baseline,
    };
  }

  /** Throw away an in-progress recording (project switch, cancel). */
  abort(): void {
    this.state = 'idle';
    this.lanes.clear();
    this.events = [];
  }
}

export const takeRecorder = new TakeRecorder();

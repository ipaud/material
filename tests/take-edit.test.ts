import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseProject, type PerformanceTake } from '@shared/schemas/project';
import {
  addPoint,
  deleteEvent,
  deleteLane,
  deletePoint,
  deleteRange,
  moveEvent,
  movePoint,
  simplifyTake,
  takeStats,
  trimTake,
} from '@/performance/take/edit';
import { laneValueAt, simplifyLane, laneError, sortedEvents } from '@/performance/take/model';
import { resolveTakeAt, replayDiscreteUpTo, type TakePerformer } from '@/performance/take/evaluate';

const FIXTURE = resolve(process.cwd(), 'tests/fixtures/v07-signature.material');
const signature = (): PerformanceTake =>
  parseProject(JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>).takes[0]!;

const OPACITY = 'layer:sig_l2:opacity';

function log(take: PerformanceTake, at: number): string[] {
  const out: string[] = [];
  const performer: TakePerformer = {
    restoreBaseline: (b) =>
      out.push(
        `baseline:${JSON.stringify(b.layerEnabled)}:${Object.keys(b.lanes).sort().join(',')}`,
      ),
    advanceTo: () => undefined,
    recallLook: (id) => out.push(`look:${id}`),
    startMorph: (id, t) => out.push(`morph:${id}@${t}`),
    setFreeze: (on) => out.push(`freeze:${String(on)}`),
    setLayerEnabled: (id, on) => out.push(`enable:${id}:${String(on)}`),
  };
  replayDiscreteUpTo(take, take.startSec + at, performer);
  return out;
}

describe('event edits', () => {
  it('deletes one event and leaves the rest untouched', () => {
    const t = deleteEvent(signature(), 'sig_e2');
    expect(t.events.map((e) => e.id)).toEqual(['sig_e0', 'sig_e1', 'sig_e3', 'sig_e4']);
    expect(log(t, 12)).not.toContain('freeze:true');
  });

  it('moves an event in time without renumbering anything', () => {
    const t = moveEvent(signature(), 'sig_e2', 3);
    const moved = t.events.find((e) => e.id === 'sig_e2')!;
    expect(moved.t).toBe(3);
    expect(moved.order).toBe(2); // identity, not position
    expect(log(t, 4)).toContain('freeze:true');
    expect(log(signature(), 4)).not.toContain('freeze:true');
  });

  it('clamps a move to the Take, so nothing lands outside its own duration', () => {
    expect(moveEvent(signature(), 'sig_e2', -5).events.find((e) => e.id === 'sig_e2')!.t).toBe(0);
    expect(moveEvent(signature(), 'sig_e2', 99).events.find((e) => e.id === 'sig_e2')!.t).toBe(12);
  });
});

describe('continuous point edits', () => {
  it('moves a point and keeps the lane monotonic', () => {
    const t = movePoint(signature(), OPACITY, 3, 0.5, 0.9);
    const lane = t.lanes.find((l) => l.target === OPACITY)!;
    for (let i = 1; i < lane.samples.length; i++) {
      expect(lane.samples[i]!.t).toBeGreaterThan(lane.samples[i - 1]!.t);
    }
    expect(laneValueAt(lane, 0.5)).toBeCloseTo(0.9, 6);
  });

  it('adding a point without a value does not move the gesture', () => {
    const before = signature();
    const after = addPoint(before, OPACITY, 2.6);
    for (const at of [0, 1, 2.3, 2.6, 3.1, 4, 9]) {
      // 4dp, because that is the precision a lane point is stored at.
      expect(resolveTakeAt(after, at).opacity.get('sig_l2')).toBeCloseTo(
        resolveTakeAt(before, at).opacity.get('sig_l2') as number,
        4,
      );
    }
    expect(after.lanes.find((l) => l.target === OPACITY)!.samples.length).toBe(
      before.lanes.find((l) => l.target === OPACITY)!.samples.length + 1,
    );
  });

  it('deletes a point', () => {
    const before = signature();
    const after = deletePoint(before, OPACITY, 2);
    expect(after.lanes.find((l) => l.target === OPACITY)!.samples.length).toBe(
      before.lanes.find((l) => l.target === OPACITY)!.samples.length - 1,
    );
  });

  it('deleting a range leaves a straight line, not a discontinuity', () => {
    const before = signature();
    const after = deleteRange(before, OPACITY, 2.5, 3.5);
    const lane = after.lanes.find((l) => l.target === OPACITY)!;
    const a = laneValueAt(lane, 2.5) as number;
    const b = laneValueAt(lane, 3.5) as number;
    // The edges hold what the gesture had there…
    expect(a).toBeCloseTo(laneValueAt(before.lanes.find((l) => l.target === OPACITY)!, 2.5)!, 6);
    expect(b).toBeCloseTo(laneValueAt(before.lanes.find((l) => l.target === OPACITY)!, 3.5)!, 6);
    // …and the middle is exactly the chord between them.
    expect(laneValueAt(lane, 3)).toBeCloseTo((a + b) / 2, 6);
    // No sample survives inside the hole.
    expect(lane.samples.filter((s) => s.t > 2.5 && s.t < 3.5)).toHaveLength(0);
  });

  it('deleting a lane removes it entirely', () => {
    const t = deleteLane(signature(), OPACITY);
    expect(t.lanes.map((l) => l.target)).not.toContain(OPACITY);
    expect(resolveTakeAt(t, 3).opacity.has('sig_l2')).toBe(false);
  });

  it('an emptied lane does not linger as a lane with no samples', () => {
    let t = signature();
    const count = t.lanes.find((l) => l.target === OPACITY)!.samples.length;
    for (let i = count - 1; i >= 0; i--) t = deletePoint(t, OPACITY, i);
    expect(t.lanes.map((l) => l.target)).not.toContain(OPACITY);
  });
});

describe('simplification is bounded, and reported', () => {
  it('holds the error under the tolerance on a real gesture', () => {
    // 20 seconds of a hand at 60Hz: two sweeps, a hold, and tremor.
    const samples = Array.from({ length: 1200 }, (_, i) => {
      const t = i / 60;
      const shape =
        t < 6 ? t / 6 : t < 10 ? 1 : t < 14 ? 1 - (t - 10) / 8 : 0.5 + Math.sin(t * 2) * 0.2;
      return { t, v: shape + Math.sin(i * 2.3) * 0.003 };
    });
    for (const eps of [0.002, 0.004, 0.01, 0.03]) {
      const out = simplifyLane(samples, eps);
      expect(laneError(samples, out), `eps ${eps}`).toBeLessThanOrEqual(eps);
    }
  });

  it('cuts a ten-second slider move to a fraction of its samples', () => {
    const samples = Array.from({ length: 600 }, (_, i) => {
      const t = i / 60;
      return { t, v: t < 5 ? t / 5 : 1 - (t - 5) / 5 };
    });
    const out = simplifyLane(samples, 0.004);
    // A straight-line-in, straight-line-out gesture is three points.
    expect(out.length).toBeLessThanOrEqual(8);
    expect(laneError(samples, out)).toBeLessThanOrEqual(0.004);
  });

  it('simplifying a Take can target one lane', () => {
    const before = signature();
    const after = simplifyTake(before, 0.2, OPACITY);
    const other = 'macro:sig_macro';
    expect(after.lanes.find((l) => l.target === OPACITY)!.samples.length).toBeLessThan(
      before.lanes.find((l) => l.target === OPACITY)!.samples.length,
    );
    expect(after.lanes.find((l) => l.target === other)!.samples).toEqual(
      before.lanes.find((l) => l.target === other)!.samples,
    );
  });

  it('reports size in terms a performer can act on', () => {
    const stats = takeStats(signature());
    expect(stats.lanes).toBe(4);
    expect(stats.samples).toBeGreaterThan(30);
    expect(stats.events).toBe(5);
    expect(stats.bytes).toBeGreaterThan(0);
    expect(stats.eventsPerMinute).toBeCloseTo(25, 0);
  });
});

describe('trim', () => {
  it('shifts the Take onto the timeline instead of moving its content', () => {
    const t = trimTake(signature(), 5, 10);
    expect(t.startSec).toBe(5);
    expect(t.durationSec).toBe(5);
    // Composition time 7 meant the same thing before and after the trim.
    expect(resolveTakeAt(t, 7).macros.get('sig_macro')).toBeCloseTo(
      resolveTakeAt(signature(), 7).macros.get('sig_macro') as number,
      6,
    );
  });

  it('plants a sample at the new boundary, so replay starts at the right value', () => {
    const before = signature();
    const expected = laneValueAt(before.lanes.find((l) => l.target === OPACITY)!, 3) as number;
    const t = trimTake(before, 3, 9);
    const lane = t.lanes.find((l) => l.target === OPACITY)!;
    expect(lane.samples[0]!.t).toBe(0);
    expect(lane.samples[0]!.v).toBeCloseTo(expected, 9);
    expect(t.baseline.lanes[OPACITY]).toBeCloseTo(expected, 9);
  });

  it('folds a trimmed-off Freeze back in, so the kept stretch still starts frozen', () => {
    // Freeze at 8, unfreeze at 8.5. Trimming to start at 8.25 keeps neither
    // the freeze nor its own history — but the performance WAS frozen there.
    const t = trimTake(signature(), 8.25, 12);
    expect(log(t, 0)).toContain('freeze:true');
    expect(t.events.filter((e) => e.kind === 'freeze.set' && e.t === 0)).toHaveLength(1);
    // …and the unfreeze that survived still lands, a quarter second in.
    expect(log(t, 0.5)).toEqual(expect.arrayContaining(['freeze:true', 'freeze:false']));
  });

  it('folds a trimmed-off morph in as a recall of its target', () => {
    // The morph runs 6 → 8. Trimming to start at 9 drops it, but the kept
    // stretch inherits its END state, which is Look B.
    const t = trimTake(signature(), 9, 12);
    const folded = t.events.filter((e) => e.t === 0);
    expect(folded.some((e) => e.kind === 'look.recall' && e.lookId === 'sig_look_b')).toBe(true);
    expect(folded.some((e) => e.kind === 'morph.start')).toBe(false);
  });

  it('folds only the LAST of each identity, in recorded order', () => {
    const t = trimTake(signature(), 11.5, 12);
    const folded = t.events.filter((e) => e.t === 0);
    // freeze (the 8.5s one, not the 8s one), the look (Look B), the layer mute.
    expect(folded.map((e) => e.kind)).toEqual(['look.recall', 'freeze.set', 'layer.enable']);
    expect(folded.find((e) => e.kind === 'freeze.set')!.on).toBe(false);
    expect(folded.find((e) => e.kind === 'layer.enable')!.on).toBe(false);
    expect(sortedEvents(t).map((e) => e.order)).toEqual([1, 3, 4]);
  });

  it('a trim that keeps everything changes nothing observable', () => {
    const before = signature();
    const after = trimTake(before, 0, before.durationSec);
    for (const at of [0, 1, 3.3, 6, 8.25, 11, 12]) {
      const a = resolveTakeAt(after, at);
      const b = resolveTakeAt(before, at);
      for (const [k, v] of b.opacity) expect(a.opacity.get(k)).toBeCloseTo(v, 4);
      for (const [k, v] of b.macros) expect(a.macros.get(k)).toBeCloseTo(v, 4);
      expect([...a.params.keys()]).toEqual([...b.params.keys()]);
      expect(log(after, at)).toEqual(log(before, at));
    }
  });

  it('refuses an inverted or empty range instead of producing a broken Take', () => {
    const before = signature();
    expect(trimTake(before, 8, 3)).toBe(before);
    expect(trimTake(before, 5, 5)).toBe(before);
  });
});

describe('an edited Take replays deterministically', () => {
  it('the same edits from the same source give the same Take', () => {
    const build = () => {
      let t = signature();
      t = moveEvent(t, 'sig_e2', 3.25);
      t = deleteRange(t, OPACITY, 2.4, 3.1);
      t = addPoint(t, 'macro:sig_macro', 5.5, 0.42);
      t = simplifyTake(t, 0.01);
      return trimTake(t, 1, 11);
    };
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  it('order independence survives editing', () => {
    let t = signature();
    t = trimTake(t, 2, 10);
    t = movePoint(t, OPACITY, 1, 1.2, 0.33);
    const walked = [0, 1, 2, 3, 4].map((x) => resolveTakeAt(t, t.startSec + x));
    const jumped = [4, 0, 3, 1, 2].map((x) => resolveTakeAt(t, t.startSec + x));
    expect(jumped).toEqual([walked[4], walked[0], walked[3], walked[1], walked[2]]);
  });
});

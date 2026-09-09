import { describe, expect, it } from 'vitest';
import {
  compareEvents,
  eventsBetween,
  eventsUpTo,
  laneError,
  laneValueAt,
  layerOpacityTarget,
  macroTarget,
  paramTarget,
  parseControlTarget,
  simplifyLane,
  sortedEvents,
} from '@/performance/take/model';
import {
  replayDiscreteBetween,
  replayDiscreteUpTo,
  resolveAgainstProject,
  resolveTakeAt,
  takeRelativeTime,
  type TakeMorphSpec,
  type TakePerformer,
} from '@/performance/take/evaluate';
import {
  createEmptyProject,
  performanceTakeSchema,
  type PerformanceTake,
  type TakeBaseline,
  type TakeEvent,
} from '@shared/schemas/project';

function take(patch: Partial<PerformanceTake> = {}): PerformanceTake {
  return performanceTakeSchema.parse({
    id: 'take_1',
    name: 'TAKE 01',
    createdAt: '2026-08-31T00:00:00.000Z',
    startSec: 0,
    durationSec: 10,
    lanes: [],
    events: [],
    baseline: { lanes: {}, layerEnabled: {}, frozen: {} },
    ...patch,
  });
}

function event(patch: Partial<TakeEvent> & Pick<TakeEvent, 'kind' | 't'>): TakeEvent {
  return {
    id: `e_${patch.t}_${patch.order ?? 0}`,
    order: 0,
    lookId: null,
    morph: null,
    on: null,
    layerId: null,
    origin: 'user',
    ...patch,
  };
}

describe('control target scoping', () => {
  it('round-trips every target kind', () => {
    expect(parseControlTarget(layerOpacityTarget('layer_1'))).toEqual({
      kind: 'layerOpacity',
      layerId: 'layer_1',
    });
    expect(parseControlTarget(macroTarget('macro_3'))).toEqual({
      kind: 'macro',
      macroId: 'macro_3',
    });
    expect(parseControlTarget(paramTarget('layer_2', 'scale'))).toEqual({
      kind: 'param',
      layerId: 'layer_2',
      paramId: 'scale',
    });
  });

  it('keeps a namespaced param id whole', () => {
    expect(parseControlTarget(paramTarget('layer_2', 'pack:iridescence:hue'))).toEqual({
      kind: 'param',
      layerId: 'layer_2',
      paramId: 'pack:iridescence:hue',
    });
  });

  it('rejects an unknown target instead of guessing', () => {
    expect(parseControlTarget('blend:layer_1')).toBeNull();
    expect(parseControlTarget('layer_1')).toBeNull();
    expect(parseControlTarget('')).toBeNull();
  });

  it('never stores a layer INDEX', () => {
    // A reorder must not repoint a lane. The proof is structural: the target
    // string carries the id, and parsing an index yields nothing usable.
    expect(parseControlTarget('layer:0:opacity')).toEqual({
      kind: 'layerOpacity',
      layerId: '0',
    });
    // …and the id the recorder writes is never a number.
    expect(layerOpacityTarget('layer_ab12')).toBe('layer:layer_ab12:opacity');
  });
});

describe('continuous lane evaluation', () => {
  const lane = { target: 'macro:m1', samples: [
    { t: 1, v: 0 },
    { t: 3, v: 1 },
    { t: 4, v: 0.5 },
  ] };

  it('interpolates linearly between samples', () => {
    expect(laneValueAt(lane, 2)).toBeCloseTo(0.5, 12);
    expect(laneValueAt(lane, 3.5)).toBeCloseTo(0.75, 12);
  });

  it('holds at both ends', () => {
    expect(laneValueAt(lane, 0)).toBe(0);
    expect(laneValueAt(lane, -5)).toBe(0);
    expect(laneValueAt(lane, 4)).toBe(0.5);
    expect(laneValueAt(lane, 999)).toBe(0.5);
  });

  it('is exact at sample times', () => {
    for (const s of lane.samples) expect(laneValueAt(lane, s.t)).toBe(s.v);
  });

  it('returns null for an empty lane rather than a neutral 0', () => {
    // 0 is a real opacity. Absence has to be distinguishable from silence.
    expect(laneValueAt({ target: 'macro:m1', samples: [] }, 1)).toBeNull();
  });

  it('agrees with a linear scan on a long lane (binary search sanity)', () => {
    const samples = Array.from({ length: 5000 }, (_, i) => ({ t: i / 60, v: Math.sin(i / 30) }));
    const long = { target: 'macro:m1', samples };
    const scan = (t: number) => {
      let a = samples[0]!;
      let b = samples[samples.length - 1]!;
      for (let i = 0; i < samples.length - 1; i++) {
        if (samples[i]!.t <= t && t <= samples[i + 1]!.t) {
          a = samples[i]!;
          b = samples[i + 1]!;
          break;
        }
      }
      return a.v + ((t - a.t) / (b.t - a.t)) * (b.v - a.v);
    };
    for (const t of [0.017, 5.5, 20.001, 41.6, 83.3]) {
      expect(laneValueAt(long, t)).toBeCloseTo(scan(t), 10);
    }
  });
});

describe('frame-rate independence', () => {
  // §13/§115: the same Take, sampled by a 24, 30, 60 or 120 fps loop, must
  // return identical values at identical composition times. It does because
  // evaluation is a function of t alone — this test is what fails if anyone
  // ever makes it depend on the previous call.
  const t0 = take({
    lanes: [{ target: layerOpacityTarget('l1'), samples: [
      { t: 0, v: 0 },
      { t: 8, v: 1 },
    ] }],
  });

  it('gives the same value at the same time under any stepping', () => {
    const at = (fps: number, seconds: number) => {
      let last = 0;
      for (let i = 0; i <= Math.round(seconds * fps); i++) {
        last = resolveTakeAt(t0, i / fps).opacity.get('l1') as number;
      }
      return last;
    };
    const golden = at(60, 4);
    for (const fps of [24, 25, 30, 48, 120]) {
      expect(at(fps, 4)).toBeCloseTo(golden, 12);
    }
  });

  it('is order-independent — a seek is as good as a walk', () => {
    const walked = [0.1, 0.25, 0.5, 1, 2, 3.75].map(
      (t) => resolveTakeAt(t0, t).opacity.get('l1') as number,
    );
    const jumped = [3.75, 0.5, 2, 0.1, 1, 0.25].map(
      (t) => resolveTakeAt(t0, t).opacity.get('l1') as number,
    );
    expect(jumped).toEqual([walked[5], walked[2], walked[4], walked[0], walked[3], walked[1]]);
  });

  it('holds the last value past the recorded end, and nothing before the start', () => {
    const placed = take({ startSec: 5, durationSec: 8, lanes: t0.lanes });
    expect(takeRelativeTime(placed, 4.9)).toBeNull();
    expect(resolveTakeAt(placed, 4.9).opacity.size).toBe(0);
    expect(resolveTakeAt(placed, 9).opacity.get('l1')).toBeCloseTo(0.5, 12);
    expect(resolveTakeAt(placed, 60).opacity.get('l1')).toBe(1);
  });
});

describe('deterministic event ordering', () => {
  it('breaks a timestamp tie by sequence, not by array position', () => {
    const t = take({
      events: [
        event({ kind: 'freeze.set', t: 2, order: 7, on: true }),
        event({ kind: 'look.recall', t: 2, order: 3, lookId: 'look_a' }),
        event({ kind: 'layer.enable', t: 1, order: 9, layerId: 'l1', on: false }),
      ],
    });
    expect(sortedEvents(t).map((e) => e.order)).toEqual([9, 3, 7]);
  });

  it('sorts identically however the array is shuffled', () => {
    const events = [
      event({ kind: 'freeze.set', t: 2, order: 2, on: true }),
      event({ kind: 'freeze.set', t: 2, order: 1, on: false }),
      event({ kind: 'freeze.set', t: 2, order: 0, on: true }),
    ];
    const a = [...events].sort(compareEvents).map((e) => e.order);
    const b = [...events].reverse().sort(compareEvents).map((e) => e.order);
    expect(a).toEqual([0, 1, 2]);
    expect(b).toEqual([0, 1, 2]);
  });

  it('separates "crossed since" from "state at"', () => {
    const events = sortedEvents(
      take({
        events: [
          event({ kind: 'freeze.set', t: 1, on: true }),
          event({ kind: 'freeze.set', t: 5, on: false }),
        ],
      }),
    );
    expect(eventsUpTo(events, 6)).toHaveLength(2);
    expect(eventsBetween(events, 4, 6)).toHaveLength(1);
    expect(eventsBetween(events, 6, 8)).toHaveLength(0);
    // An event exactly at the boundary belongs to the interval that CLOSES on
    // it, so a frame boundary can never fire it twice or drop it.
    expect(eventsBetween(events, 0, 1)).toHaveLength(1);
    expect(eventsBetween(events, 1, 2)).toHaveLength(0);
  });
});

describe('discrete reconstruction', () => {
  function recorder() {
    const log: string[] = [];
    const performer: TakePerformer = {
      restoreBaseline: (b: TakeBaseline) => log.push(`baseline:${Object.keys(b.lanes).length}`),
      advanceTo: () => undefined,
      recallLook: (id) => log.push(`look:${id}`),
      startMorph: (id, at, spec: TakeMorphSpec) =>
        log.push(`morph:${id}@${at}:${spec.durationValue}${spec.durationMode}`),
      setFreeze: (on) => log.push(`freeze:${String(on)}`),
      setLayerEnabled: (id, on) => log.push(`enable:${id}:${String(on)}`),
    };
    return { log, performer };
  }

  const signature = take({
    startSec: 2,
    durationSec: 12,
    events: [
      event({ kind: 'look.recall', t: 0, order: 0, lookId: 'look_a' }),
      event({
        kind: 'morph.start',
        t: 6,
        order: 1,
        lookId: 'look_b',
        morph: { durationMode: 'bars', durationValue: 1, curve: 'easeInOut' },
      }),
      event({ kind: 'freeze.set', t: 8, order: 2, on: true }),
      event({ kind: 'freeze.set', t: 8.5, order: 3, on: false }),
    ],
  });

  it('always restores the baseline first', () => {
    const { log, performer } = recorder();
    replayDiscreteUpTo(signature, 100, performer);
    expect(log[0]).toMatch(/^baseline:/);
  });

  it('replays every event from the origin, in order', () => {
    const { log, performer } = recorder();
    replayDiscreteUpTo(signature, 2 + 9, performer);
    expect(log.slice(1)).toEqual([
      'look:look_a',
      'morph:look_b@8:1bars',
      'freeze:true',
      'freeze:false',
    ]);
  });

  it('a seek reconstructs exactly what a walk produced', () => {
    const walk = recorder();
    // A frame-by-frame walk of the crossings.
    walk.performer.restoreBaseline(signature.baseline);
    for (let f = 0; f < 12 * 30; f++) {
      replayDiscreteBetween(signature, 2 + f / 30, 2 + (f + 1) / 30, walk.performer);
    }
    const seek = recorder();
    replayDiscreteUpTo(signature, 2 + 12, seek.performer);
    expect(seek.log).toEqual(walk.log);
  });

  it('stops at the seek target — a later event has not happened yet', () => {
    const { log, performer } = recorder();
    replayDiscreteUpTo(signature, 2 + 7, performer);
    expect(log.slice(1)).toEqual(['look:look_a', 'morph:look_b@8:1bars']);
  });

  it('dispatches nothing before the Take starts', () => {
    const { log, performer } = recorder();
    replayDiscreteUpTo(signature, 1, performer);
    expect(log).toEqual(['baseline:0']);
  });

  it('places a morph at ABSOLUTE composition time', () => {
    const { log, performer } = recorder();
    replayDiscreteUpTo(signature, 100, performer);
    // Take starts at 2s, event at +6s → the morph schedules at 8s, which is
    // where a recorded morphEvent would sit.
    expect(log).toContain('morph:look_b@8:1bars');
  });
});

describe('explicit state, never a toggle', () => {
  it('reaches the same freeze state from either starting point', () => {
    const t = take({ events: [event({ kind: 'freeze.set', t: 1, on: true })] });
    const seen: boolean[] = [];
    const performer: TakePerformer = {
      restoreBaseline: () => undefined,
      advanceTo: () => undefined,
      recallLook: () => undefined,
      startMorph: () => undefined,
      setFreeze: (on) => seen.push(on),
      setLayerEnabled: () => undefined,
    };
    replayDiscreteUpTo(t, 5, performer);
    replayDiscreteUpTo(t, 5, performer);
    expect(seen).toEqual([true, true]);
  });
});

describe('simplification', () => {
  it('collapses a straight line to its endpoints', () => {
    const samples = Array.from({ length: 600 }, (_, i) => ({ t: i / 60, v: i / 599 }));
    const out = simplifyLane(samples, 0.002);
    expect(out).toHaveLength(2);
    expect(laneError(samples, out)).toBeLessThan(1e-9);
  });

  it('keeps the shape of a real gesture within tolerance', () => {
    // 10s of a hand: a sweep up, a hold, a snap down, plus jitter.
    const samples = Array.from({ length: 600 }, (_, i) => {
      const t = i / 60;
      const base = t < 4 ? t / 4 : t < 7 ? 1 : Math.max(0, 1 - (t - 7));
      return { t, v: base + Math.sin(i * 1.7) * 0.004 };
    });
    const eps = 0.01;
    const out = simplifyLane(samples, eps);
    expect(laneError(samples, out)).toBeLessThanOrEqual(eps);
    expect(out.length).toBeLessThan(samples.length / 4);
  });

  it('always keeps the endpoints — trim and the final resting value depend on it', () => {
    const samples = Array.from({ length: 100 }, (_, i) => ({ t: i / 60, v: i === 99 ? 0.7 : 0.1 }));
    const out = simplifyLane(samples, 0.5);
    expect(out[0]).toEqual({ t: 0, v: 0.1 });
    expect(out[out.length - 1]).toEqual({ t: 99 / 60, v: 0.7 });
  });

  it('is a no-op below three samples', () => {
    expect(simplifyLane([{ t: 0, v: 0 }], 1)).toHaveLength(1);
    expect(simplifyLane([{ t: 0, v: 0 }, { t: 1, v: 1 }], 1)).toHaveLength(2);
  });

  it('survives a lane long enough to blow a recursive stack', () => {
    // Ten minutes at 60Hz where EVERY sample reverses direction: the deepest
    // recursion RDP can be given, and nothing a hand produces. Measured at
    // ~7s once, at record stop; a real ten-minute gesture across six lanes
    // simplifies in well under a second (docs/V07_PROGRESS.md).
    const samples = Array.from({ length: 36_000 }, (_, i) => ({
      t: i / 60,
      v: i % 2 === 0 ? 0 : 1,
    }));
    expect(() => simplifyLane(samples, 0.001)).not.toThrow();
  }, 30_000);
});

describe('missing targets', () => {
  it('reports them instead of retargeting or crashing', () => {
    const project = createEmptyProject();
    const layerId = project.layers[0]!.id;
    const t = take({
      lanes: [
        { target: layerOpacityTarget(layerId), samples: [{ t: 0, v: 1 }] },
        { target: layerOpacityTarget('layer_gone'), samples: [{ t: 0, v: 1 }] },
        { target: macroTarget('macro_gone'), samples: [{ t: 0, v: 1 }] },
      ],
      events: [
        event({ kind: 'look.recall', t: 1, lookId: 'look_gone' }),
        event({ kind: 'freeze.set', t: 2, on: true }),
      ],
    });
    const res = resolveAgainstProject(t, project);
    expect(res.unresolvedLanes).toEqual([
      layerOpacityTarget('layer_gone'),
      macroTarget('macro_gone'),
    ]);
    expect(res.unresolvedEvents).toHaveLength(1);
    // …and evaluating it anyway is safe and simply omits them.
    const resolved = resolveTakeAt(t, 1);
    expect(resolved.opacity.get(layerId)).toBe(1);
    expect(resolved.opacity.has('layer_gone')).toBe(true); // parses, just absent from the project
  });

  it('drops a lane whose target string cannot be parsed at all', () => {
    const t = take({ lanes: [{ target: 'from-the-future', samples: [{ t: 0, v: 1 }] }] });
    expect(resolveTakeAt(t, 1).opacity.size).toBe(0);
    expect(resolveAgainstProject(t, createEmptyProject()).unresolvedLanes).toEqual([
      'from-the-future',
    ]);
  });
});

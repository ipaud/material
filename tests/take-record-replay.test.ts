import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProject, type PinnedLook, type Project } from '@shared/schemas/project';
import { useProjectStore } from '@/state/projectStore';
import { playback } from '@/playback/PlaybackController';
import { takeRecorder, CONTROL_EPSILON, SAMPLE_HZ } from '@/performance/take/recorder';
import { takePlayer } from '@/performance/take/player';
import { laneValueAt, layerOpacityTarget, macroTarget, paramTarget } from '@/performance/take/model';
import {
  performFreeze,
  performLayerEnabled,
  performLayerOpacity,
  performLookRecall,
  performMacroValue,
  performSelectedParam,
} from '@/performance/take/gestures';
import { captureBaseline, stopRecording } from '@/performance/take/takeActions';
import { modulationRuntime } from '@/modulation/runtime';

const src = (...p: string[]) => readFileSync(resolve(process.cwd(), 'src', ...p), 'utf8');

let clock = 0;
beforeEach(() => {
  clock = 0;
  vi.spyOn(playback, 'getTime').mockImplementation(() => clock);
  takeRecorder.abort();
  takePlayer.reset();
  useProjectStore.setState({
    project: seedProject(),
    past: [],
    future: [],
    dirty: false,
    transientBase: null,
    silent: false,
  });
});

function seedProject(): Project {
  const base = createEmptyProject();
  const layerId = base.layers[0]!.id;
  const look: PinnedLook = {
    id: 'look_a',
    createdAt: '2026-08-31T00:00:00.000Z',
    label: 'LOOK A',
    note: '',
    slot: 1,
    seed: 1,
    thumbnail: null,
    techniques: [],
    layers: [],
    selectedLayerId: layerId,
    material: base.layers[0]!.material,
    modulations: [],
    triggers: [],
  };
  return {
    ...base,
    selectedLayerId: layerId,
    layers: [
      {
        ...base.layers[0]!,
        technique: { id: 'tech_1', techniqueId: 'mosaic', enabled: true, params: { scale: 1 } },
      },
    ],
    macros: [{ id: 'macro_1', name: 'M1', value: 0.25, mappings: [] }],
    pinnedLooks: [look],
  };
}

const layerId = () => useProjectStore.getState().project.layers[0]!.id;

/** Drive a gesture as a hand would: many samples over composition time. */
function sweep(from: number, to: number, seconds: number, hz: number, apply: (v: number) => void) {
  const steps = Math.round(seconds * hz);
  for (let i = 1; i <= steps; i++) {
    clock += 1 / hz;
    apply(from + ((to - from) * i) / steps);
  }
}

describe('recorder: sampling policy', () => {
  it('records nothing at all when it is not recording', () => {
    performLayerOpacity(layerId(), 0.3);
    expect(takeRecorder.snapshot().laneCount).toBe(0);
    // …and the gesture still did its job.
    expect(useProjectStore.getState().project.layers[0]!.opacity).toBeCloseTo(0.3, 6);
  });

  it('seeds the lane with the value the control was resting at', () => {
    takeRecorder.begin(0, captureBaseline());
    clock = 2;
    performLayerOpacity(layerId(), 0.4);
    const take = takeRecorder.stop(3, 'T', false)!;
    const lane = take.lanes.find((l) => l.target === layerOpacityTarget(layerId()))!;
    // The resting value is backdated one sample period, so the step from 1 to
    // 0.4 is expressible at all — two samples cannot share a timestamp.
    expect(lane.samples[0]!.v).toBe(1);
    expect(lane.samples[0]!.t).toBeCloseTo(2 - 1 / 60, 9);
    expect(lane.samples[1]).toEqual({ t: 2, v: 0.4 });
    // …so the whole stretch before the gesture replays as the resting value.
    expect(laneValueAt(lane, 0)).toBe(1);
    expect(laneValueAt(lane, 3)).toBeCloseTo(0.4, 6);
    expect(take.baseline.lanes[layerOpacityTarget(layerId())]).toBe(1);
  });

  it('caps the stored rate well under a 120Hz hand', () => {
    takeRecorder.begin(0, captureBaseline());
    sweep(1, 0, 4, 120, (v) => performLayerOpacity(layerId(), v));
    const take = takeRecorder.stop(clock, 'T', false)!;
    const lane = take.lanes[0]!;
    // 480 gesture events in 4s; at most 60/s may be stored, plus the seed.
    expect(lane.samples.length).toBeLessThanOrEqual(4 * SAMPLE_HZ + 2);
    expect(lane.samples.length).toBeGreaterThan(4 * 20);
  });

  it('suppresses movement below epsilon but never loses accumulated drift', () => {
    takeRecorder.begin(0, captureBaseline());
    // Ten seconds of drift at a tenth of epsilon per step.
    let v = 0.5;
    for (let i = 0; i < 600; i++) {
      clock += 1 / 60;
      v += CONTROL_EPSILON / 10;
      performLayerOpacity(layerId(), v);
    }
    const take = takeRecorder.stop(clock, 'T', false)!;
    const lane = take.lanes[0]!;
    expect(lane.samples.length).toBeLessThan(120);
    // The endpoint is right even though almost every step was suppressed.
    expect(laneValueAt(lane, 10)).toBeCloseTo(v, 3);
  });

  it('keeps the final resting value even when the gesture ends inside the rate window', () => {
    takeRecorder.begin(0, captureBaseline());
    clock = 1;
    performLayerOpacity(layerId(), 0.8);
    clock = 1 + 1 / 500; // far inside 1/60s
    performLayerOpacity(layerId(), 0.0);
    const take = takeRecorder.stop(2, 'T', false)!;
    // The rate limiter held the last move back; stop() must flush it, because
    // the resting value is the one left on screen.
    expect(laneValueAt(take.lanes[0]!, 2)).toBe(0);
  });

  it('collapses a gesture made with the transport parked onto one instant', () => {
    takeRecorder.begin(5, captureBaseline());
    clock = 5; // parked
    for (const v of [0.9, 0.6, 0.3, 0.15]) performLayerOpacity(layerId(), v);
    const take = takeRecorder.stop(5, 'T', false)!;
    const lane = take.lanes[0]!;
    // One sample, carrying the latest value. The resting sample would sit one
    // period earlier, but this gesture happened at the Take ORIGIN and nothing
    // precedes the origin — so it clamps onto it and collapses. "At
    // composition time 5 the fader is at 0.15" is the honest statement, and a
    // lane must stay strictly increasing in t.
    expect(lane.samples).toEqual([{ t: 0, v: 0.15 }]);
  });

  it('discards a Take in which nothing was played', () => {
    takeRecorder.begin(0, captureBaseline());
    expect(takeRecorder.stop(10, 'T')).toBeNull();
  });

  it('records the trailing silence a performer deliberately left', () => {
    takeRecorder.begin(0, captureBaseline());
    clock = 1;
    performLayerOpacity(layerId(), 0.2);
    const take = takeRecorder.stop(30, 'T')!;
    expect(take.durationSec).toBe(30);
  });
});

describe('the vertical slice: record, replay, seek', () => {
  function recordSlice() {
    takeRecorder.begin(0, captureBaseline());
    clock = 0.5;
    performLookRecall('look_a');
    clock = 1;
    sweep(1, 0.2, 2, 60, (v) => performLayerOpacity(layerId(), v)); // → 3s
    sweep(0.25, 0.9, 1, 60, (v) => performMacroValue('macro_1', v)); // → 4s
    sweep(1, 4, 1, 60, (v) => performSelectedParam('scale', v)); // → 5s
    clock = 6;
    performFreeze(true);
    clock = 6.5;
    performFreeze(false);
    clock = 7;
    performLayerEnabled(layerId(), false);
    return takeRecorder.stop(10, 'TAKE 01')!;
  }

  it('captures every control class in one pass', () => {
    const take = recordSlice();
    expect(take.lanes.map((l) => l.target).sort()).toEqual(
      [layerOpacityTarget(layerId()), macroTarget('macro_1'), paramTarget(layerId(), 'scale')].sort(),
    );
    expect(take.events.map((e) => e.kind)).toEqual([
      'look.recall',
      'freeze.set',
      'freeze.set',
      'layer.enable',
    ]);
    expect(take.durationSec).toBe(10);
  });

  it('replays the gesture it recorded, within the simplification tolerance', () => {
    const take = recordSlice();
    const opacity = take.lanes.find((l) => l.target === layerOpacityTarget(layerId()))!;
    // The 1s→3s ramp from 1 to 0.2, sampled at three points.
    expect(laneValueAt(opacity, 1)).toBeCloseTo(1, 2);
    expect(laneValueAt(opacity, 2)).toBeCloseTo(0.6, 2);
    expect(laneValueAt(opacity, 3)).toBeCloseTo(0.2, 2);
    const scale = take.lanes.find((l) => l.target === paramTarget(layerId(), 'scale'))!;
    // A parameter lane holds the parameter's OWN value, not a 0..1 position.
    expect(laneValueAt(scale, 5)).toBeCloseTo(4, 2);
  });

  it('seeking into the middle reconstructs the state at that instant', () => {
    const take = recordSlice();
    useProjectStore.getState().apply((p) => ({ ...p, takes: [take], activeTakeId: take.id }));

    takePlayer.start(take, 6.2); // between freeze-on and freeze-off
    expect(useProjectStore.getState().project.layers[0]!.enabled).toBe(true);
    takePlayer.seek(7.5); // after the layer was switched off
    expect(useProjectStore.getState().project.layers[0]!.enabled).toBe(false);
    takePlayer.seek(2); // back before it — reconstruction, not a rewind
    expect(useProjectStore.getState().project.layers[0]!.enabled).toBe(true);
  });

  it('replaying does not dirty the project or fill the undo stack', () => {
    const take = recordSlice();
    useProjectStore.getState().apply((p) => ({ ...p, takes: [take], activeTakeId: take.id }));
    useProjectStore.setState({ dirty: false, past: [] });

    takePlayer.start(take, 0);
    for (let f = 0; f <= 10 * 30; f++) takePlayer.tick(f / 30);
    takePlayer.seek(4);
    takePlayer.seek(8);

    expect(useProjectStore.getState().dirty).toBe(false);
    expect(useProjectStore.getState().past).toHaveLength(0);
  });

  it('a discrete event fires exactly once as the playhead crosses it', () => {
    const take = recordSlice();
    // The recording pass already left the Look applied; replay has to put it
    // back, so clear it first or there is nothing to observe.
    useProjectStore.getState().apply((p) => ({ ...p, activeLookId: null }));
    let transitions = 0;
    let previous = useProjectStore.getState().project.activeLookId;
    const unsub = useProjectStore.subscribe((s) => {
      if (s.project.activeLookId !== previous) {
        previous = s.project.activeLookId;
        transitions++;
      }
    });
    takePlayer.start(take, 0);
    for (let f = 0; f <= 3 * 30; f++) takePlayer.tick(f / 30);
    unsub();
    // The Look landed once as the playhead crossed 0.5s, and did not re-land
    // on each of the ninety frames after it.
    expect(useProjectStore.getState().project.activeLookId).toBe('look_a');
    expect(transitions).toBe(1);
  });

  it('drives the modulation runtime as the BASE, so Signals still ride on top', () => {
    const take = recordSlice();
    takePlayer.start(take, 2);
    // The runtime received the Take's continuous state for this instant.
    expect(modulationRuntime.takeOpacity(layerId())).toBeCloseTo(0.6, 2);
    takePlayer.stop();
    expect(modulationRuntime.takeOpacity(layerId())).toBeNull();
  });

  it('a stopped Take leaves the picture where the playhead left it', () => {
    const take = recordSlice();
    takePlayer.start(take, 8);
    expect(useProjectStore.getState().project.layers[0]!.enabled).toBe(false);
    takePlayer.stop();
    // STOP is not a rewind (§117): the performer stopped to take over here.
    expect(useProjectStore.getState().project.layers[0]!.enabled).toBe(false);
  });

  it('starting from the beginning restores the baseline', () => {
    const take = recordSlice();
    // Leave the composition in the state the Take ended in.
    takePlayer.start(take, 10);
    expect(useProjectStore.getState().project.layers[0]!.enabled).toBe(false);
    takePlayer.start(take, 0);
    expect(useProjectStore.getState().project.layers[0]!.enabled).toBe(true);
  });

  it('commits as ONE undo entry, not one per sample', () => {
    takeRecorder.begin(0, captureBaseline());
    clock = 1;
    sweep(1, 0, 2, 60, (v) => performLayerOpacity(layerId(), v));
    useProjectStore.setState({ past: [], dirty: false });
    const before = 0;
    clock = 5;
    const take = stopRecording();
    expect(take).not.toBeNull();
    expect(useProjectStore.getState().past.length).toBe(before + 1);
  });
});

describe('anti-recursion is structural, not conditional', () => {
  it('the replay path cannot reach the recorder', () => {
    for (const file of ['livePerformer.ts', 'player.ts', 'evaluate.ts', 'model.ts']) {
      const text = src('performance', 'take', file);
      expect(text, `${file} must not import the recorder`).not.toMatch(/from '\.\/recorder'/);
      expect(text, `${file} must not import the capture seam`).not.toMatch(/from '\.\/gestures'/);
    }
  });

  it('the export scheduler is constructed without a capture hook', () => {
    const runner = src('export', 'exportRunner.ts');
    expect(runner).toMatch(/new TriggerScheduler\(virtualTarget\)/);
    expect(runner).not.toMatch(/take\/(recorder|gestures)/);
  });

  it('generated control never reaches the capture seam', () => {
    // Signals, Audio and Pattern move parameters through the evaluator. If any
    // of them ever imported a gesture, a Take would start recording its own
    // Signals — the exact thing the whole class policy exists to prevent.
    for (const file of [
      ['modulation', 'evaluator.ts'],
      ['modulation', 'sources.ts'],
      ['modulation', 'runtime.ts'],
      ['signals', 'pulseEngine.ts'],
      ['pattern', 'patternSourceRuntime.ts'],
    ] as const) {
      expect(src(...file), `${file.join('/')} must not import a gesture`).not.toMatch(
        /take\/gestures/,
      );
    }
  });

  it('a replayed Look recall does not land in the Take being recorded', () => {
    const inner = createEmptyProject();
    useProjectStore.setState({ project: { ...seedProject(), ...{} } });
    takeRecorder.begin(0, captureBaseline());
    clock = 1;
    // Exactly what the player does on a crossing.
    void inner;
    takePlayer.start(
      {
        id: 'take_x',
        name: 'X',
        createdAt: '',
        startSec: 0,
        durationSec: 2,
        lanes: [],
        events: [
          {
            id: 'e1',
            t: 0.5,
            order: 0,
            kind: 'look.recall',
            lookId: 'look_a',
            morph: null,
            on: null,
            layerId: null,
            origin: 'user',
          },
        ],
        baseline: { lanes: {}, layerEnabled: {}, frozen: {} },
      },
      0,
    );
    takePlayer.tick(1);
    expect(useProjectStore.getState().project.activeLookId).toBe('look_a');
    expect(takeRecorder.snapshot().eventCount).toBe(0);
  });
});

describe('structural edits stay out of the Take', () => {
  it('the capture seam offers no way to record one', () => {
    const text = src('performance', 'take', 'gestures.ts');
    for (const forbidden of [
      'addLayer',
      'deleteLayer',
      'duplicateLayer',
      'moveLayer',
      'setLayerBlend',
      'addMapping',
      'deleteMapping',
      'setSource',
      'setTechnique',
    ]) {
      expect(text, `${forbidden} is a composition edit, not a gesture`).not.toContain(forbidden);
    }
  });

  it('the event vocabulary itself admits only four kinds', () => {
    const schema = readFileSync(resolve(process.cwd(), 'shared/schemas/project.ts'), 'utf8');
    const block = schema.slice(schema.indexOf('export const takeEventKindSchema'));
    const kinds = block.slice(0, block.indexOf(']')).match(/'[a-z.]+'/g) ?? [];
    expect(kinds).toEqual(["'look.recall'", "'morph.start'", "'freeze.set'", "'layer.enable'"]);
  });
});

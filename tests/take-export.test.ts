import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyProject, type PerformanceTake, type PinnedLook, type Project } from '@shared/schemas/project';
import { useProjectStore } from '@/state/projectStore';
import { createFrameEvaluator, createSecondaryLayerEvaluator } from '@/export/exportRunner';
import { layerOpacityTarget, macroTarget, paramTarget } from '@/performance/take/model';

/**
 * v0.7 — the Take as an export program.
 *
 * These run against the real `createFrameEvaluator`, not a re-implementation
 * of it, because the whole point of a canonical evaluator is that there is
 * only one interpretation to test.
 */

const LAYER = 'layer_1';
const LAYER_B = 'layer_2';

function take(patch: Partial<PerformanceTake> = {}): PerformanceTake {
  return {
    id: 'take_1',
    name: 'TAKE 01',
    createdAt: '2026-08-31T00:00:00.000Z',
    startSec: 0,
    durationSec: 20,
    lanes: [],
    events: [],
    baseline: { lanes: {}, layerEnabled: {}, frozen: {} },
    ...patch,
  };
}

function look(id: string, scale: number): PinnedLook {
  const base = createEmptyProject();
  return {
    id,
    createdAt: '',
    label: id,
    note: '',
    slot: null,
    seed: 1,
    thumbnail: null,
    techniques: [
      { id: `t_${id}`, techniqueId: 'mosaic', enabled: true, params: { scale } },
    ],
    layers: [],
    selectedLayerId: LAYER,
    material: base.layers[0]!.material,
    modulations: [],
    triggers: [],
  };
}

function seed(t: PerformanceTake | null): Project {
  const base = createEmptyProject();
  const layer = {
    ...base.layers[0]!,
    id: LAYER,
    technique: { id: 'tech_1', techniqueId: 'mosaic', enabled: true, params: { scale: 1 } },
  };
  const second = {
    ...base.layers[0]!,
    id: LAYER_B,
    opacity: 1,
    technique: { id: 'tech_2', techniqueId: 'mosaic', enabled: true, params: { scale: 2 } },
  };
  return {
    ...base,
    layers: [layer, second],
    selectedLayerId: LAYER,
    macros: [{ id: 'macro_1', name: 'M1', value: 0, mappings: [] }],
    pinnedLooks: [look('look_a', 7), look('look_b', 9)],
    takes: t ? [t] : [],
    activeTakeId: t ? t.id : null,
  };
}

function install(t: PerformanceTake | null): void {
  useProjectStore.setState({ project: seed(t), past: [], future: [], dirty: false, silent: false });
}

/**
 * Walk a whole export, returning the primary layer's params per global frame.
 *
 * Mirrors `runAnimationExport` exactly, including the part that matters: the
 * evaluator is constructed at startSec ZERO and indexed by the GLOBAL frame
 * number (the CE1H rule — a global frame must be the same float in every
 * export that contains it), then the runner walks every frame from zero
 * before a subrange begins. That walk is what carries a Take's automation
 * history forward.
 */
function run(startSec: number, fps: number, frames: number): Record<string, unknown>[] {
  const evaluate = createFrameEvaluator(0, fps);
  const startFrame = Math.round(startSec * fps);
  const out: Record<string, unknown>[] = [];
  for (let f = 0; f < startFrame; f++) evaluate(f);
  for (let i = 0; i < frames; i++) out.push({ ...evaluate(startFrame + i).params });
  return out;
}

const RAMP = take({
  lanes: [{ target: paramTarget(LAYER, 'scale'), samples: [
    { t: 0, v: 1 },
    { t: 16, v: 5 },
  ] }],
});

beforeEach(() => install(null));

describe('a Take drives the export', () => {
  it('ANTI-NOOP: the same export without the Take differs', () => {
    install(RAMP);
    const withTake = run(0, 30, 60);
    // Same project, Take deselected. A perfectly deterministic export that
    // ignores the Take has to FAIL here (§112).
    useProjectStore.setState({ project: { ...seed(RAMP), activeTakeId: null } });
    const without = run(0, 30, 60);
    expect(withTake).not.toEqual(without);
    // …and the difference is the automation, not noise.
    expect(withTake[59]!.scale).not.toBe(without[59]!.scale);
    expect(without[0]!.scale).toBe(without[59]!.scale);
  });

  it('TIME-LIVENESS: an early frame differs from a late one', () => {
    install(RAMP);
    const frames = run(0, 30, 300);
    expect(frames[0]!.scale).not.toBe(frames[299]!.scale);
    expect(frames[0]!.scale).toBeCloseTo(1, 6);
    expect(frames[299]!.scale as number).toBeGreaterThan(3);
  });

  it('EVENT-LIVENESS: removing the discrete event changes the render', () => {
    const withEvent = take({
      events: [
        {
          id: 'e1',
          t: 1,
          order: 0,
          kind: 'look.recall',
          lookId: 'look_a',
          morph: null,
          on: null,
          layerId: null,
          origin: 'user',
        },
      ],
    });
    install(withEvent);
    const a = run(0, 30, 90);
    install(take({ events: [] }));
    const b = run(0, 30, 90);
    expect(a[0]!.scale).toBe(b[0]!.scale); // before the event they agree
    expect(a[89]!.scale).toBe(7); // Look A's scale
    expect(b[89]!.scale).toBe(1); // …and without the event, the document's
  });

  it('REPEAT: twelve runs of the same range are identical', () => {
    install(RAMP);
    const golden = JSON.stringify(run(2, 30, 40));
    for (let i = 0; i < 11; i++) expect(JSON.stringify(run(2, 30, 40))).toBe(golden);
  });

  it('FULL vs SUBRANGE: the same global frame resolves identically', () => {
    install(RAMP);
    const full = run(0, 30, 600);
    const sub = run(8, 30, 120);
    for (let i = 0; i < 120; i++) {
      expect(sub[i], `global frame ${8 * 30 + i}`).toEqual(full[8 * 30 + i]);
    }
  });

  it('CROSS-FPS: the same composition time resolves to the same value', () => {
    install(RAMP);
    const at = (fps: number, seconds: number) => run(0, fps, Math.round(seconds * fps) + 1).pop()!;
    const golden = at(30, 8).scale as number;
    for (const fps of [24, 25, 60]) {
      expect(at(fps, 8).scale as number).toBeCloseTo(golden, 9);
    }
  });
});

describe('stateful preroll carries automation HISTORY, not a final value', () => {
  it('a subrange sees the same evaluated path a full export saw', () => {
    // The claim §106 makes concrete: an automation change at t=2 must be
    // applied over the whole 0→8 preroll, not collapsed into "the value at
    // t=8 for all of history". The evaluator's smoothing state is the
    // observable proxy — it is the thing that carries history.
    const stepped = take({
      lanes: [{ target: paramTarget(LAYER, 'scale'), samples: [
        { t: 0, v: 1 },
        { t: 1.99, v: 1 },
        { t: 2, v: 6 },
        { t: 20, v: 6 },
      ] }],
    });
    install(stepped);
    const full = run(0, 30, 400);
    const sub = run(8, 30, 60);
    for (let i = 0; i < 60; i++) expect(sub[i]).toEqual(full[8 * 30 + i]);
    // …and the step really did happen inside the prerolled stretch.
    expect(full[30]!.scale).toBe(1);
    expect(full[70]!.scale).toBe(6);
  });

  it('a Take that starts mid-timeline contributes nothing before its start', () => {
    const late = take({
      startSec: 5,
      lanes: [{ target: paramTarget(LAYER, 'scale'), samples: [
        { t: 0, v: 3 },
        { t: 5, v: 3 },
      ] }],
    });
    install(late);
    const frames = run(0, 30, 300);
    expect(frames[0]!.scale).toBe(1); // the document's value
    expect(frames[299]!.scale).toBe(3); // the Take's, once it starts
  });
});

describe('macros and secondary layers', () => {
  it('a macro lane replays as macro INTENT, fanned out through current mappings', () => {
    const t = take({ lanes: [{ target: macroTarget('macro_1'), samples: [
      { t: 0, v: 0 },
      { t: 10, v: 1 },
    ] }] });
    const project = seed(t);
    useProjectStore.setState({
      project: {
        ...project,
        // The mapping is edited AFTER the recording — the replay must use the
        // new fan-out, because a Take stores the hand, not the twelve
        // parameters the hand moved (§83).
        macros: [
          {
            id: 'macro_1',
            name: 'M1',
            value: 0,
            mappings: [
              {
                targetParam: 'scale',
                amount: 1,
                min: 0,
                max: 1,
                invert: false,
                curve: 'linear',
                enabled: true,
              },
            ],
          },
        ],
      },
      past: [],
      future: [],
      dirty: false,
    });
    const frames = run(0, 30, 300);
    expect(frames[0]!.scale).toBe(1);
    expect(frames[299]!.scale as number).toBeGreaterThan(1);
  });

  it('a layer opacity lane reaches the secondary evaluator', () => {
    const t = take({ lanes: [{ target: layerOpacityTarget(LAYER_B), samples: [
      { t: 0, v: 1 },
      { t: 4, v: 0 },
    ] }] });
    install(t);
    const evaluator = createSecondaryLayerEvaluator(
      useProjectStore.getState().project,
      LAYER,
      30,
      () => ({}),
      t,
    );
    expect(evaluator.opacityAt(0).get(LAYER_B)).toBe(1);
    expect(evaluator.opacityAt(2).get(LAYER_B)).toBeCloseTo(0.5, 6);
    expect(evaluator.opacityAt(9).get(LAYER_B)).toBe(0);
    // …and without a Take it is the stored value, unchanged.
    const bare = createSecondaryLayerEvaluator(
      useProjectStore.getState().project,
      LAYER,
      30,
      () => ({}),
    );
    expect(bare.opacityAt(9).get(LAYER_B)).toBe(1);
  });
});

describe('layer visibility is its own authority channel', () => {
  it('a layer.enable event is reported to the export loop', () => {
    const t = take({
      baseline: { lanes: {}, layerEnabled: { [LAYER_B]: true }, frozen: {} },
      events: [
        {
          id: 'e1',
          t: 3,
          order: 0,
          kind: 'layer.enable',
          layerId: LAYER_B,
          on: false,
          lookId: null,
          morph: null,
          origin: 'user',
        },
      ],
    });
    install(t);
    const evaluate = createFrameEvaluator(0, 30);
    evaluate(0);
    expect(evaluate.layerEnabled().get(LAYER_B)).toBe(true);
    for (let f = 1; f <= 4 * 30; f++) evaluate(f);
    expect(evaluate.layerEnabled().get(LAYER_B)).toBe(false);
  });

  it('it is NOT folded into opacity — a muted branch stops, an invisible one does not', () => {
    // LayerHost deliberately keeps drawing at opacity 0 so a stateful branch
    // keeps its accumulation. Expressing a mute as opacity would silently
    // change what a replayed feedback layer contains.
    const host = readFileSync('src/rendering/layers/LayerHost.ts', 'utf8');
    expect(host).toMatch(/setAuthorityEnabled/);
    expect(host).toMatch(/authorityEnabled\?\.get\(state\.id\) \?\? state\.enabled/);
  });
});

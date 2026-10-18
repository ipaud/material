import { beforeEach, describe, expect, it } from 'vitest';
import { createSecondaryLayerEvaluator } from '@/export/exportRunner';
import { addLane, addPoint, setLaneInterp } from '@/performance/take/edit';
import { laneValueAt } from '@/performance/take/model';
import {
  addLaneToTake,
  createManualTake,
  keyframeTargets,
} from '@/performance/take/takeActions';
import { useProjectStore } from '@/state/projectStore';
import { emptyLayer, type PerformanceTake, type TakeLane } from '@shared/schemas/project';

const lane = (interp?: TakeLane['interp']): TakeLane => ({
  target: 'layer:l2:opacity',
  ...(interp ? { interp } : {}),
  samples: [
    { t: 0, v: 0 },
    { t: 10, v: 1 },
    { t: 20, v: 0.2 },
  ],
});

describe('lane interpolation', () => {
  it('linear is the default and does not change', () => {
    expect(laneValueAt(lane(), 5)).toBeCloseTo(0.5, 6);
    expect(laneValueAt(lane('linear'), 15)).toBeCloseTo(0.6, 6);
  });

  it('hold keeps the previous key until the next one', () => {
    expect(laneValueAt(lane('hold'), 9.99)).toBe(0);
    expect(laneValueAt(lane('hold'), 10)).toBe(1);
    expect(laneValueAt(lane('hold'), 19)).toBe(1);
  });

  it('smooth eases between keys, exact at the keys and the midpoint', () => {
    expect(laneValueAt(lane('smooth'), 0)).toBe(0);
    expect(laneValueAt(lane('smooth'), 10)).toBe(1);
    expect(laneValueAt(lane('smooth'), 5)).toBeCloseTo(0.5, 6);
    expect(laneValueAt(lane('smooth'), 2.5)).toBeLessThan(0.25); // slower than linear near a key
  });
});

describe('authoring a lane by hand', () => {
  const take = (): PerformanceTake => useProjectStore.getState().project.takes[0]!;

  beforeEach(() => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().apply((p) => ({
      ...p,
      layers: [
        { ...p.layers[0]!, id: 'l1', name: 'Base' },
        {
          ...emptyLayer('l2', 'Grit'),
          opacity: 0.4,
          technique: { id: 't', techniqueId: 'flow-displace', enabled: true, params: { amount: 2 } },
        },
      ],
    }));
  });

  it('creates an empty Take that is selected and undoable', () => {
    const id = createManualTake(30);
    expect(take()).toMatchObject({ id, durationSec: 30, startSec: 0, lanes: [], events: [] });
    expect(useProjectStore.getState().project.activeTakeId).toBe(id);
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.takes).toHaveLength(0);
  });

  it('lists the targets: every layer opacity and its modulatable parameters', () => {
    const targets = keyframeTargets(useProjectStore.getState().project).map((t) => t.target);
    expect(targets).toContain('layer:l1:opacity');
    expect(targets).toContain('layer:l2:opacity');
    expect(targets).toContain('param:l2:amount');
  });

  it('a new lane starts flat at the control\'s current value', () => {
    const id = createManualTake(30);
    addLaneToTake(id, 'layer:l2:opacity');
    addLaneToTake(id, 'param:l2:amount');
    expect(take().lanes.find((l) => l.target === 'layer:l2:opacity')!.samples).toEqual([
      { t: 0, v: 0.4 },
      { t: 30, v: 0.4 },
    ]);
    expect(take().lanes.find((l) => l.target === 'param:l2:amount')!.samples[0]!.v).toBe(2);
    addLaneToTake(id, 'layer:l2:opacity'); // idempotent
    expect(take().lanes).toHaveLength(2);
  });

  it('pure edits: add a key without moving the curve, set the interpolation', () => {
    const base: PerformanceTake = { ...take0(), lanes: [] };
    const withLane = addLane(base, 'layer:l2:opacity', 0, 1);
    const mid = addPoint(withLane, 'layer:l2:opacity', 15);
    expect(mid.lanes[0]!.samples).toEqual([
      { t: 0, v: 0 },
      { t: 15, v: 0.5 },
      { t: 30, v: 1 },
    ]);
    expect(setLaneInterp(mid, 'layer:l2:opacity', 'hold').lanes[0]!.interp).toBe('hold');
    expect(setLaneInterp(mid, 'layer:l2:opacity', 'linear').lanes[0]!.interp).toBeUndefined();
  });

  it('the export evaluator plays a hand-authored opacity lane (and the window gates it)', () => {
    const id = createManualTake(30);
    addLaneToTake(id, 'layer:l2:opacity');
    useProjectStore.getState().apply((p) => ({
      ...p,
      takes: p.takes.map((t) =>
        t.id === id
          ? {
              ...t,
              lanes: [
                {
                  target: 'layer:l2:opacity',
                  samples: [
                    { t: 0, v: 0 },
                    { t: 10, v: 1 },
                  ],
                },
              ],
            }
          : t,
      ),
      layers: p.layers.map((l) =>
        l.id === 'l2' ? { ...l, activity: { start: 5, end: null, fadeIn: 0, fadeOut: 0 } } : l,
      ),
    }));
    const project = useProjectStore.getState().project;
    const { opacityAt } = createSecondaryLayerEvaluator(project, 'l1', 25, () => ({}), take());
    expect(opacityAt(4).get('l2')).toBe(0); // lane says 0.4, window is closed
    expect(opacityAt(7.5).get('l2')).toBeCloseTo(0.75, 6);
    expect(opacityAt(12).get('l2')).toBe(1);
  });
});

function take0(): PerformanceTake {
  useProjectStore.getState().newProject();
  const id = createManualTake(30);
  return useProjectStore.getState().project.takes.find((t) => t.id === id)!;
}

import { beforeEach, describe, expect, it } from 'vitest';
import { createFrameEvaluator, createSecondaryLayerEvaluator } from '@/export/exportRunner';
import { triggersForLayer } from '@/signals/pulseEngine';
import { useProjectStore } from '@/state/projectStore';
import {
  createEmptyProject,
  emptyLayer,
  triggerMappingSchema,
  type Project,
  type TriggerMapping,
} from '@shared/schemas/project';

const AMOUNT = 1.2; // flow-displace default

function trigger(id: string, over: Partial<TriggerMapping> = {}): TriggerMapping {
  return {
    ...triggerMappingSchema.parse({ id, enabled: true, source: 'marker:m1', action: 'pulse' }),
    targetParam: 'amount',
    amount: 0.5,
    attackSec: 0,
    holdSec: 1,
    decaySec: 1,
    ...over,
  };
}

function twoLayers(triggers: TriggerMapping[]): Project {
  const base = createEmptyProject('t');
  const tech = (id: string) => ({
    id,
    techniqueId: 'flow-displace',
    enabled: true,
    params: { amount: AMOUNT },
  });
  const l1 = { ...base.layers[0]!, id: 'l1', technique: tech('t1') };
  const l2 = { ...emptyLayer('l2'), technique: tech('t2') };
  return {
    ...base,
    layers: [l1, l2],
    selectedLayerId: 'l1',
    triggers,
    timeline: { ...base.timeline, markers: [{ id: 'm1', timeSec: 1, label: 'kick' }] },
  };
}

const secondary = (p: Project, t: number) =>
  createSecondaryLayerEvaluator(p, 'l1', 25, () => ({})).paramsAt(t).get('l2')!.amount as number;

function primary(p: Project, t: number): number {
  useProjectStore.getState().loadProject('/x/t.material', p);
  const evaluate = createFrameEvaluator(0, 25);
  let last = 0;
  for (let f = 0; f <= Math.round(t * 25); f++) last = evaluate(f).params.amount as number;
  return last;
}

beforeEach(() => useProjectStore.getState().newProject());

describe('triggersForLayer', () => {
  it('untargeted triggers go to the primary layer only; targeted ones to their layer', () => {
    const t = [trigger('a'), trigger('b', { targetLayerId: 'l2' })];
    expect(triggersForLayer(t, 'l1', 'l1').map((x) => x.id)).toEqual(['a']);
    expect(triggersForLayer(t, 'l2', 'l1').map((x) => x.id)).toEqual(['b']);
  });
});

describe('a trigger aimed at one layer', () => {
  it('pulses that layer in the export and leaves the other alone', () => {
    const project = twoLayers([trigger('k', { targetLayerId: 'l2' })]);
    expect(secondary(project, 0.5)).toBeCloseTo(AMOUNT, 6); // before the marker
    expect(secondary(project, 1.1)).toBeGreaterThan(AMOUNT + 0.1); // on the hit
    expect(primary(project, 1.1)).toBeCloseTo(AMOUNT, 6); // l1 never reacts
  });

  it('aimed at the primary layer, the secondary stays still', () => {
    const project = twoLayers([trigger('k', { targetLayerId: 'l1' })]);
    expect(secondary(project, 1.1)).toBeCloseTo(AMOUNT, 6);
    expect(primary(project, 1.1)).toBeGreaterThan(AMOUNT + 0.1);
  });

  it('untargeted keeps its old meaning: primary layer only', () => {
    const project = twoLayers([trigger('k')]);
    expect(primary(project, 1.1)).toBeGreaterThan(AMOUNT + 0.1);
    expect(secondary(project, 1.1)).toBeCloseTo(AMOUNT, 6);
  });
});

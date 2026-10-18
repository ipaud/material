import { describe, expect, it } from 'vitest';
import { activityAt } from '@shared/activity';
import {
  createEmptyProject,
  layerSchema,
  parseProject,
  type Layer,
} from '@shared/schemas/project';
import { createSecondaryLayerEvaluator } from '@/export/exportRunner';

const WINDOW = { start: 10, end: 20, fadeIn: 2, fadeOut: 2 };

describe('activityAt', () => {
  it('no window means always fully active', () => {
    expect(activityAt(null, 0)).toBe(1);
    expect(activityAt(undefined, 999)).toBe(1);
  });

  it('is exactly 0 outside the window and exactly 1 in the plateau', () => {
    expect(activityAt(WINDOW, 5)).toBe(0);
    expect(activityAt(WINDOW, 9.999)).toBe(0);
    expect(activityAt(WINDOW, 15)).toBe(1);
    expect(activityAt(WINDOW, 20.001)).toBe(0);
    expect(activityAt(WINDOW, 100)).toBe(0);
  });

  it('fades in over fadeIn and out over fadeOut, symmetrically', () => {
    expect(activityAt(WINDOW, 10)).toBe(0);
    expect(activityAt(WINDOW, 11)).toBeCloseTo(0.5, 6);
    expect(activityAt(WINDOW, 12)).toBe(1);
    expect(activityAt(WINDOW, 18)).toBe(1);
    expect(activityAt(WINDOW, 19)).toBeCloseTo(0.5, 6);
    expect(activityAt(WINDOW, 20)).toBe(0);
  });

  it('rises monotonically through the fade', () => {
    let last = -1;
    for (let t = 10; t <= 12; t += 0.05) {
      const v = activityAt(WINDOW, t);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });

  it('zero fades give a hard edge; end null means open-ended', () => {
    const hard = { start: 4, end: 8, fadeIn: 0, fadeOut: 0 };
    expect(activityAt(hard, 3.99)).toBe(0);
    expect(activityAt(hard, 4)).toBe(1);
    expect(activityAt(hard, 8)).toBe(1);
    expect(activityAt(hard, 8.01)).toBe(0);
    const open = { start: 54, end: null, fadeIn: 1, fadeOut: 0 };
    expect(activityAt(open, 53)).toBe(0);
    expect(activityAt(open, 1000)).toBe(1);
  });

  it('overlapping fades never exceed the plateau (short window)', () => {
    const tiny = { start: 0, end: 2, fadeIn: 2, fadeOut: 2 };
    for (let t = 0; t <= 2; t += 0.1) {
      const v = activityAt(tiny, t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('layer.activity in the project format', () => {
  it('is optional: an existing layer parses to "always active"', () => {
    const layer = layerSchema.parse({
      id: 'l1',
      material: { materialId: 'square', colorMode: 'source', params: {}, assetPath: null },
    });
    expect(layer.activity).toBeNull();
  });

  it('round-trips and rejects an end before the start', () => {
    const project = createEmptyProject('w');
    const layers: Layer[] = project.layers.map((l) => ({ ...l, activity: WINDOW }));
    const back = parseProject(JSON.parse(JSON.stringify({ ...project, layers })));
    expect(back.layers[0]!.activity).toEqual(WINDOW);
    expect(() =>
      layerSchema.parse({ ...project.layers[0], activity: { ...WINDOW, start: 30 } }),
    ).toThrow();
  });
});

describe('export applies the window to the layer opacity', () => {
  it('multiplies stored opacity by the envelope at the frame time', () => {
    const base = createEmptyProject('x');
    const second: Layer = {
      ...base.layers[0]!,
      id: 'l2',
      opacity: 0.8,
      technique: { id: 't', techniqueId: 'echo', enabled: true, params: {} },
      activity: WINDOW,
    };
    const project = { ...base, layers: [base.layers[0]!, second] };
    const { opacityAt } = createSecondaryLayerEvaluator(project, base.layers[0]!.id, 25, () => ({}));
    expect(opacityAt(5).get('l2')).toBe(0);
    expect(opacityAt(15).get('l2')).toBeCloseTo(0.8, 6);
    expect(opacityAt(11).get('l2')).toBeCloseTo(0.4, 6);
    // a layer with no window is untouched
    expect(opacityAt(5).get(base.layers[0]!.id)).toBe(1);
  });
});

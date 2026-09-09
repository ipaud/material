import { describe, expect, it } from 'vitest';
import { createEmptyProject, type Project } from '@shared/schemas/project';
import { laneDomain } from '@/performance/ui/TakeStrip';
import { layerOpacityTarget, macroTarget, paramTarget } from '@/performance/take/model';
import { getTechnique } from '@/techniques/registry';
import { allParams } from '@/techniques/types';

/**
 * v0.7.1 — a lane is drawn against its CONTROL'S domain, not against the range
 * the gesture happened to cover.
 *
 * Auto-scaling per lane made a lane that moved 0.4 to 0.5 look exactly as
 * dramatic as one that swept 0 to 1, so two lanes could not be compared by
 * eye. Found by looking at a real 71-second performance, where a four-point
 * BLOOM lane read as emphatically as an eighteen-point SMEAR one.
 */

const LAYER = 'layer_1';

function project(): Project {
  const base = createEmptyProject();
  return {
    ...base,
    layers: [
      {
        ...base.layers[0]!,
        id: LAYER,
        technique: { id: 't1', techniqueId: 'time-field', enabled: true, params: {} },
      },
    ],
    selectedLayerId: LAYER,
    macros: [{ id: 'm1', name: 'OPEN', value: 0, mappings: [] }],
  };
}

const small = [{ v: 0.4 }, { v: 0.5 }];

describe('lane drawing domain', () => {
  it('draws layer opacity against 0..1, however little the gesture moved', () => {
    expect(laneDomain(layerOpacityTarget(LAYER), project(), small)).toEqual([0, 1]);
  });

  it('draws a macro against 0..1', () => {
    expect(laneDomain(macroTarget('m1'), project(), small)).toEqual([0, 1]);
  });

  it("draws a parameter against its definition's own range", () => {
    const definition = getTechnique('time-field')!;
    const scale = allParams(definition).find((d) => d.id === 'scale')!;
    expect(scale.type).toBe('number');
    const expected = scale.type === 'number' ? [scale.min, scale.max] : null;
    expect(laneDomain(paramTarget(LAYER, 'scale'), project(), small)).toEqual(expected);
  });

  it('two lanes of the same domain are comparable by eye', () => {
    // The actual complaint: a lane that swept 0→0.85 and one that swept 0→0.7
    // must be drawn against the same range, so the second looks shorter.
    const a = laneDomain(layerOpacityTarget(LAYER), project(), [{ v: 0 }, { v: 0.85 }]);
    const b = laneDomain(layerOpacityTarget(LAYER), project(), [{ v: 0 }, { v: 0.7 }]);
    expect(a).toEqual(b);
  });

  it('falls back to the content range when the parameter cannot be found', () => {
    // A lane from a deleted layer, or a parameter a shader pack no longer
    // declares. A flat line with no explanation is worse than a rescaled one.
    expect(laneDomain(paramTarget('gone', 'whatever'), project(), small)).toEqual([0.4, 0.5]);
    expect(laneDomain(paramTarget(LAYER, 'notAParam'), project(), small)).toEqual([0.4, 0.5]);
  });

  it('gives a constant lane a range rather than dividing by zero', () => {
    const [lo, hi] = laneDomain(paramTarget('gone', 'x'), project(), [{ v: 2 }, { v: 2 }]);
    expect(hi).toBeGreaterThan(lo);
    expect((lo + hi) / 2).toBe(2);
  });

  it('an unparseable target still yields a usable range', () => {
    const [lo, hi] = laneDomain('from-the-future', project(), small);
    expect(hi).toBeGreaterThan(lo);
  });
});

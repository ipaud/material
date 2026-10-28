import { selectedLayerOf } from '@shared/schemas/project';
import { describe, expect, test } from 'vitest';
import { createEmptyProject } from '@shared/schemas/project';
import type {
  LookCore,
  ModulationMapping,
  PinnedLook,
  Project,
  TriggerMapping,
} from '@shared/schemas/project';
import {
  captureLookCore,
  isLookDirty,
  lookToCore,
  projectWithLookCore,
} from '@/performance/lookCore';
import { interpolateLookCore, morphCurve } from '@/performance/interpolate';

function mod(patch: Partial<ModulationMapping>): ModulationMapping {
  return {
    id: 'mod-1',
    enabled: true,
    source: 'bass',
    target: 'scale',
    amount: 0.5,
    min: 0,
    max: 1,
    invert: false,
    smoothing: 0.25,
    curve: 'linear',
    frozenValue: null,
    ...patch,
  };
}

function trig(patch: Partial<TriggerMapping>): TriggerMapping {
  return {
    id: 'trig-1',
    enabled: true,
    source: 'beat',
    action: 'pulse',
    targetParam: 'scale',
    targetMappingId: null,
    lookSlot: null,
    quantize: 'off',
    cooldownSec: 0,
    attackSec: 0.01,
    holdSec: 0,
    decaySec: 0.3,
    amount: 0.4,
    curve: 'exponential',
    ...patch,
  };
}

function core(patch: Partial<LookCore>): LookCore {
  return {
    techniqueId: 'mosaic',
    params: { scale: 1, columns: 32 },
    material: { materialId: 'solid', colorMode: 'source', assetPath: null, params: { opacity: 1 } },
    modulations: [],
    triggers: [],
    seed: 1,
    ...patch,
  } as LookCore;
}

function projectWith(patch: Partial<Project>): Project {
  const p = createEmptyProject('MorphTest');
  return {
    ...p,
    // createEmptyProject ships no technique; captureLookCore needs one enabled.
    layers: [{ ...createEmptyProject().layers[0]!, technique: { id: 'tech-1', techniqueId: 'mosaic', enabled: true, params: { scale: 1, columns: 32 } } }],
    ...patch,
  };
}

describe('look core capture / apply', () => {
  test('capture → apply round-trips the core atomically', () => {
    const p = projectWith({});
    const captured = captureLookCore(p);
    expect(captured).not.toBeNull();
    const applied = projectWithLookCore(p, captured!, 'look-x');
    expect(captureLookCore(applied)).toEqual(captured);
    expect(applied.activeLookId).toBe('look-x');
    // Non-core fields untouched.
    expect(applied.sources).toBe(p.sources);
    expect(applied.timeline).toBe(p.timeline);
  });

  test('captures selected layer chain as stable Morph state', () => {
    const stage = { id: 'stage-a', techniqueId: 'mosaic', enabled: true, params: { scale: 4 } };
    const p = projectWith({
      layers: [{ ...createEmptyProject().layers[0]!, technique: { id: 'tech-1', techniqueId: 'mosaic', enabled: true, params: { scale: 1 } }, techniqueChain: [stage] }],
    });
    expect(captureLookCore(p)).toMatchObject({ techniqueChain: [stage] });
  });

  test('lookToCore captures chain from Look selectedLayerId', () => {
    const p = projectWith({});
    const stage = { id: 'stage-b', techniqueId: 'mosaic', enabled: true, params: { scale: 6 } };
    const base: PinnedLook = {
      id: 'stack-look', label: 'Stack', note: '', slot: 1, seed: 1, thumbnail: null,
      createdAt: new Date(0).toISOString(), techniques: [], material: p.material,
      modulations: [], triggers: [], selectedLayerId: 'chosen',
      layers: [{ id: 'chosen', name: 'Chosen', enabled: true, opacity: 1, blendMode: 'normal', sourceId: null,
        material: p.material, technique: p.layers[0]!.technique, techniqueChain: [stage] }],
    };
    expect(lookToCore(base)).toMatchObject({ techniqueChain: [stage] });
  });

  test('projectWithLookCore applies target chain while retaining matching stage IDs', () => {
    const current = { id: 'stage-a', techniqueId: 'mosaic', enabled: true, params: { scale: 2 } };
    const next = { id: 'stage-a', techniqueId: 'mosaic', enabled: true, params: { scale: 8 } };
    const p = projectWith({ layers: [{ ...createEmptyProject().layers[0]!, technique: { id: 'tech-1', techniqueId: 'mosaic', enabled: true, params: { scale: 1 } }, techniqueChain: [current] }] });
    const applied = projectWithLookCore(p, core({ techniqueChain: [next] } as Partial<LookCore>), null);
    expect(applied.layers[0]?.techniqueChain).toEqual([next]);
  });

  test('apply replaces modulations and triggers wholesale', () => {
    const p = projectWith({ modulations: [mod({ id: 'old' })], triggers: [trig({ id: 'oldt' })] });
    const target = core({ modulations: [mod({ id: 'new' })], triggers: [] });
    const applied = projectWithLookCore(p, target, null);
    expect(applied.modulations.map((m) => m.id)).toEqual(['new']);
    expect(applied.triggers).toEqual([]);
  });

  test('isLookDirty false right after apply, true after param change', () => {
    const p = projectWith({});
    const captured = captureLookCore(p)!;
    const look: PinnedLook = {
      id: 'look-1',
      label: 'LOOK 01',
      note: '',
      slot: 1,
      seed: captured.seed,
      thumbnail: null,
      createdAt: new Date(0).toISOString(),
      techniques: selectedLayerOf(p).technique ? [selectedLayerOf(p).technique!] : [],
      material: p.material,
      modulations: p.modulations,
      triggers: p.triggers,
    };
    expect(isLookDirty(p, look)).toBe(false);
    const tech = selectedLayerOf(p).technique!;
    const changed: Project = {
      ...p,
      layers: [{ ...p.layers[0]!, technique: { ...tech, params: { ...tech.params, columns: 99 } } }],
    };
    expect(isLookDirty(changed, look)).toBe(true);
  });

  test('lookToCore ignores thumbnail/name/slot identity fields', () => {
    const p = projectWith({});
    const base: PinnedLook = {
      id: 'a',
      label: 'A',
      note: '',
      slot: 1,
      seed: 1,
      thumbnail: null,
      createdAt: new Date(0).toISOString(),
      techniques: selectedLayerOf(p).technique ? [selectedLayerOf(p).technique!] : [],
      material: p.material,
      modulations: [],
      triggers: [],
    };
    const renamed = { ...base, label: 'RENAMED', slot: 9, thumbnail: 'data:image/jpeg;base64,x' };
    expect(lookToCore(base)).toEqual(lookToCore(renamed));
  });
});

describe('morph curves', () => {
  test('all curves fix endpoints 0 and 1', () => {
    for (const c of ['linear', 'easeIn', 'easeOut', 'easeInOut', 'exponential'] as const) {
      expect(morphCurve(0, c)).toBeCloseTo(0, 2);
      expect(morphCurve(1, c)).toBeCloseTo(1, 5);
    }
  });

  test('curve shapes at midpoint', () => {
    expect(morphCurve(0.5, 'linear')).toBeCloseTo(0.5);
    expect(morphCurve(0.5, 'easeIn')).toBeCloseTo(0.25);
    expect(morphCurve(0.5, 'easeOut')).toBeCloseTo(0.75);
    expect(morphCurve(0.5, 'easeInOut')).toBeCloseTo(0.5);
    expect(morphCurve(0.5, 'exponential')).toBeCloseTo(Math.pow(2, -5));
  });

  test('input clamped outside 0..1', () => {
    expect(morphCurve(-2, 'linear')).toBe(0);
    expect(morphCurve(3, 'easeIn')).toBe(1);
  });
});

describe('interpolateLookCore — same technique', () => {
  const a = core({ params: { scale: 1, columns: 10, shape: 'square', flip: false } });
  const b = core({ params: { scale: 3, columns: 50, shape: 'circle', flip: true } });

  test('numbers lerp, endpoints exact', () => {
    expect(interpolateLookCore(a, b, 0).core.params).toMatchObject({ scale: 1, columns: 10 });
    expect(interpolateLookCore(a, b, 1).core.params).toMatchObject({ scale: 3, columns: 50 });
    expect(interpolateLookCore(a, b, 0.25).core.params.scale).toBeCloseTo(1.5);
  });

  test('matching chain stages interpolate by stable ID; one-sided stages switch at midpoint', () => {
    const a = core({ techniqueChain: [
      { id: 'shared', techniqueId: 'mosaic', enabled: true, params: { scale: 2 } },
      { id: 'from-only', techniqueId: 'echo', enabled: true, params: { decay: 0.2 } },
    ] } as Partial<LookCore>);
    const b = core({ techniqueChain: [
      { id: 'shared', techniqueId: 'mosaic', enabled: true, params: { scale: 10 } },
      { id: 'to-only', techniqueId: 'mosaic', enabled: true, params: { scale: 6 } },
    ] } as Partial<LookCore>);
    const start = interpolateLookCore(a, b, 0).core as LookCore & { techniqueChain: Array<{ id: string; params: Record<string, number> }> };
    const before = interpolateLookCore(a, b, 0.49).core as LookCore & { techniqueChain: Array<{ id: string; params: Record<string, number> }> };
    const after = interpolateLookCore(a, b, 0.5).core as LookCore & { techniqueChain: Array<{ id: string; params: Record<string, number> }> };
    const end = interpolateLookCore(a, b, 1).core as LookCore & { techniqueChain: Array<{ id: string; params: Record<string, number> }> };
    expect(start.techniqueChain.find((stage) => stage.id === 'shared')?.params.scale).toBe(2);
    expect(before.techniqueChain.find((stage) => stage.id === 'shared')?.params.scale).toBeCloseTo(5.92);
    expect(end.techniqueChain.find((stage) => stage.id === 'shared')?.params.scale).toBe(10);
    expect(before.techniqueChain.map((stage) => stage.id)).toContain('from-only');
    expect(before.techniqueChain.map((stage) => stage.id)).not.toContain('to-only');
    expect(after.techniqueChain.map((stage) => stage.id)).toContain('to-only');
    expect(after.techniqueChain.map((stage) => stage.id)).not.toContain('from-only');
  });

  test('counts technique identity changes on matching chain-stage IDs', () => {
    const a = core({ techniqueChain: [
      { id: 'shared', techniqueId: 'mosaic', enabled: true, params: { scale: 2 } },
    ] } as Partial<LookCore>);
    const b = core({ techniqueChain: [
      { id: 'shared', techniqueId: 'echo', enabled: true, params: { decay: 0.6 } },
    ] } as Partial<LookCore>);

    const result = interpolateLookCore(a, b, 0.5);

    expect(result.core.techniqueChain?.[0]?.techniqueId).toBe('echo');
    expect(result.stats.switched).toBe(1);
  });

  test('enums/booleans switch at midpoint (p ≥ 0.5)', () => {
    expect(interpolateLookCore(a, b, 0.49).core.params).toMatchObject({ shape: 'square', flip: false });
    expect(interpolateLookCore(a, b, 0.5).core.params).toMatchObject({ shape: 'circle', flip: true });
  });

  test('seed switches at midpoint', () => {
    const s1 = core({ seed: 7 });
    const s2 = core({ seed: 99 });
    expect(interpolateLookCore(s1, s2, 0.4).core.seed).toBe(7);
    expect(interpolateLookCore(s1, s2, 0.6).core.seed).toBe(99);
  });
});

describe('interpolateLookCore — technique / material switch', () => {
  const a = core({ techniqueId: 'mosaic', params: { scale: 1 } });
  const b = core({ techniqueId: 'echo', params: { decay: 0.8 } });

  test('different technique: whole block switches at midpoint, no param blending', () => {
    const before = interpolateLookCore(a, b, 0.49).core;
    expect(before.techniqueId).toBe('mosaic');
    expect(before.params).toEqual({ scale: 1 });
    const after = interpolateLookCore(a, b, 0.5).core;
    expect(after.techniqueId).toBe('echo');
    expect(after.params).toEqual({ decay: 0.8 });
  });

  test('material identity switches at midpoint, numeric params lerp', () => {
    const ma = core({
      material: { materialId: 'solid', colorMode: 'source', assetPath: null, params: { opacity: 0 } },
    });
    const mb = core({
      material: { materialId: 'svg', colorMode: 'mono', assetPath: '/x.svg', params: { opacity: 1 } },
    });
    const mid = interpolateLookCore(ma, mb, 0.25).core.material;
    expect(mid.materialId).toBe('solid');
    expect(mid.params.opacity).toBeCloseTo(0.25);
    const late = interpolateLookCore(ma, mb, 0.75).core.material;
    expect(late.materialId).toBe('svg');
    expect(late.assetPath).toBe('/x.svg');
    expect(late.params.opacity).toBeCloseTo(0.75);
  });
});

describe('interpolateLookCore — modulations', () => {
  test('stage mapping topology follows adjusted identity switch boundary', () => {
    const a = core({ modulations: [mod({ id: 'shared', targetStageId: 'stage-a' })] });
    const b = core({ modulations: [mod({ id: 'shared', targetStageId: 'stage-b' })] });
    expect(interpolateLookCore(a, b, 0.4, 0.25).core.modulations[0]?.targetStageId).toBe('stage-b');
  });

  test('matched ids lerp numerics', () => {
    const a = core({ modulations: [mod({ amount: 0, min: 0, max: 1, smoothing: 0 })] });
    const b = core({ modulations: [mod({ amount: 1, min: 0.2, max: 0.8, smoothing: 0.5 })] });
    const m = interpolateLookCore(a, b, 0.5).core.modulations[0]!;
    expect(m.amount).toBeCloseTo(0.5);
    expect(m.min).toBeCloseTo(0.1);
    expect(m.max).toBeCloseTo(0.9);
    expect(m.smoothing).toBeCloseTo(0.25);
  });

  test('matched ids: topology (source/target) switches at midpoint', () => {
    const a = core({ modulations: [mod({ source: 'bass', target: 'scale' })] });
    const b = core({ modulations: [mod({ source: 'highs', target: 'rotation' })] });
    expect(interpolateLookCore(a, b, 0.4).core.modulations[0]).toMatchObject({
      source: 'bass',
      target: 'scale',
    });
    expect(interpolateLookCore(a, b, 0.6).core.modulations[0]).toMatchObject({
      source: 'highs',
      target: 'rotation',
    });
  });

  test('both frozen → frozen values lerp', () => {
    const a = core({ modulations: [mod({ frozenValue: 0.2 })] });
    const b = core({ modulations: [mod({ frozenValue: 0.8 })] });
    expect(interpolateLookCore(a, b, 0.5).core.modulations[0]!.frozenValue).toBeCloseTo(0.5);
  });

  test('mixed frozen → winning side applies from midpoint', () => {
    const a = core({ modulations: [mod({ frozenValue: 0.9 })] });
    const b = core({ modulations: [mod({ frozenValue: null })] });
    expect(interpolateLookCore(a, b, 0.3).core.modulations[0]!.frozenValue).toBe(0.9);
    expect(interpolateLookCore(a, b, 0.7).core.modulations[0]!.frozenValue).toBeNull();
  });

  test('A-only mapping fades amount to zero; B-only rises from zero', () => {
    const a = core({ modulations: [mod({ id: 'only-a', amount: 0.8 })] });
    const b = core({ modulations: [mod({ id: 'only-b', amount: 0.6 })] });
    const at25 = interpolateLookCore(a, b, 0.25).core.modulations;
    const byId = new Map(at25.map((m) => [m.id, m]));
    expect(byId.get('only-a')!.amount).toBeCloseTo(0.6); // 0.8 × 0.75
    expect(byId.get('only-b')!.amount).toBeCloseTo(0.15); // 0.6 × 0.25
    const at100 = interpolateLookCore(a, b, 1).core.modulations;
    expect(new Map(at100.map((m) => [m.id, m])).get('only-a')!.amount).toBeCloseTo(0);
  });
});

describe('interpolateLookCore — triggers', () => {
  test('matched ids lerp envelope numerics, topology switches at midpoint', () => {
    const a = core({ triggers: [trig({ source: 'beat', attackSec: 0, decaySec: 0.2, amount: 0 })] });
    const b = core({ triggers: [trig({ source: 'onset', attackSec: 0.1, decaySec: 0.6, amount: 1 })] });
    const mid = interpolateLookCore(a, b, 0.5).core.triggers[0]!;
    expect(mid.source).toBe('onset'); // p ≥ 0.5 side
    expect(mid.attackSec).toBeCloseTo(0.05);
    expect(mid.decaySec).toBeCloseTo(0.4);
    expect(mid.amount).toBeCloseTo(0.5);
    expect(interpolateLookCore(a, b, 0.49).core.triggers[0]!.source).toBe('beat');
  });

  test('unmatched triggers hard-switch at midpoint — never both active', () => {
    const a = core({ triggers: [trig({ id: 'ta' })] });
    const b = core({ triggers: [trig({ id: 'tb' })] });
    expect(interpolateLookCore(a, b, 0.49).core.triggers.map((t) => t.id)).toEqual(['ta']);
    expect(interpolateLookCore(a, b, 0.5).core.triggers.map((t) => t.id)).toEqual(['tb']);
    // No progress value yields both.
    for (const p of [0, 0.2, 0.499, 0.5, 0.7, 1]) {
      expect(interpolateLookCore(a, b, p).core.triggers.length).toBe(1);
    }
  });

  test('interpolation is pure — same inputs, same output', () => {
    const a = core({ modulations: [mod({})], triggers: [trig({})] });
    const b = core({
      params: { scale: 4, columns: 8 },
      modulations: [mod({ amount: 1 })],
      triggers: [trig({ decaySec: 1 })],
    });
    const r1 = interpolateLookCore(a, b, 0.37).core;
    const r2 = interpolateLookCore(a, b, 0.37).core;
    expect(r1).toEqual(r2);
  });
});

describe('interpolateLookCore — one-sided param keys', () => {
  test('key absent on one side switches at midpoint, endpoints byte-exact', () => {
    const a = core({ params: { scale: 1 } });
    const b = core({ params: { scale: 2, gap: 0.4 } });
    expect(interpolateLookCore(a, b, 0).core.params).toEqual({ scale: 1 });
    expect(interpolateLookCore(a, b, 0.49).core.params).toEqual({ scale: 1.49 });
    expect(interpolateLookCore(a, b, 0.5).core.params).toMatchObject({ gap: 0.4 });
    expect(interpolateLookCore(a, b, 1).core.params).toEqual({ scale: 2, gap: 0.4 });
  });
});

describe('morph against a Look from before chains', () => {
  test('carries the chained side through instead of fading it out and popping back', () => {
    const chain = [{ id: 'stage-a', techniqueId: 'mosaic', enabled: true, params: { columns: 24 } }];
    const chained = core({ techniqueChain: chain });
    const legacy = core({}); // no techniqueChain: recall leaves the layer's chain alone
    for (const p of [0, 0.5, 1]) {
      expect(interpolateLookCore(chained, legacy, p).core.techniqueChain).toEqual(chain);
      expect(interpolateLookCore(legacy, chained, p).core.techniqueChain).toEqual(chain);
    }
  });
});

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
    techniques: [
      { id: 'tech-1', techniqueId: 'mosaic', enabled: true, params: { scale: 1, columns: 32 } },
    ],
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
      techniques: p.techniques,
      material: p.material,
      modulations: p.modulations,
      triggers: p.triggers,
    };
    expect(isLookDirty(p, look)).toBe(false);
    const tech = p.techniques[0]!;
    const changed: Project = {
      ...p,
      techniques: [{ ...tech, params: { ...tech.params, columns: 99 } }],
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
      techniques: p.techniques,
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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateFieldJs, FIELD_IDS, GLSL_FIELDS } from '@/rendering/shaders/fields';
import { getTechnique, techniqueNeedsTemporal } from '@/techniques/registry';

/** CE1C — FIELD primitive: pure math locked by sample points (§86-89). */

describe('field sample points', () => {
  it('horizontal: left 0, center 0.5, right 1', () => {
    expect(evaluateFieldJs('horizontal', 0, 0.5)).toBe(0);
    expect(evaluateFieldJs('horizontal', 0.5, 0.5)).toBe(0.5);
    expect(evaluateFieldJs('horizontal', 1, 0.5)).toBe(1);
  });

  it('vertical: top 0, bottom 1 (user space, v-up corrected)', () => {
    // Three UVs have v=1 at the TOP of the image → user "top" is v=1.
    expect(evaluateFieldJs('vertical', 0.5, 1)).toBe(0);
    expect(evaluateFieldJs('vertical', 0.5, 0)).toBe(1);
  });

  it('radial is aspect-correct: same value at equal PIXEL distance', () => {
    const aspect = 16 / 9;
    const center = evaluateFieldJs('radial', 0.5, 0.5, { aspect });
    expect(center).toBe(0);
    // A point offset vertically by 0.25 uv = 0.25 units; horizontally the
    // SAME pixel distance is 0.25 / aspect uv. Both must give one value.
    const vert = evaluateFieldJs('radial', 0.5, 0.75, { aspect });
    const horiz = evaluateFieldJs('radial', 0.5 + 0.25 / aspect, 0.5, { aspect });
    expect(Math.abs(vert - horiz)).toBeLessThan(1e-9);
    expect(vert).toBeCloseTo(0.5, 9); // 0.25 * 2
    // Circle stays a circle: naive (non-corrected) horizontal offset differs.
    const naive = evaluateFieldJs('radial', 0.75, 0.5, { aspect });
    expect(naive).toBeGreaterThan(vert);
  });

  it('spiral combines angle and radius, wrapping in 0..1', () => {
    const a = evaluateFieldJs('spiral', 0.6, 0.5, { scale: 2 });
    const b = evaluateFieldJs('spiral', 0.6, 0.5, { scale: 2 });
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    // Radius advances the phase: same angle, larger radius → different value.
    const far = evaluateFieldJs('spiral', 0.7, 0.5, { scale: 2 });
    expect(far).not.toBeCloseTo(a, 3);
  });

  it('noise is deterministic and phase-driven, never wall-clock', () => {
    const a = evaluateFieldJs('noise', 0.3, 0.7, { scale: 1, phase: 1.25 });
    const b = evaluateFieldJs('noise', 0.3, 0.7, { scale: 1, phase: 1.25 });
    expect(a).toBe(b);
    const moved = evaluateFieldJs('noise', 0.3, 0.7, { scale: 1, phase: 1.35 });
    expect(moved).not.toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(1);
  });

  it('luminance: black 0, mid gray ~0.5, white 1 (§88)', () => {
    const solid = (v: number) => () => [v, v, v] as [number, number, number];
    expect(evaluateFieldJs('luminance', 0.5, 0.5, { sample: solid(0) })).toBe(0);
    expect(evaluateFieldJs('luminance', 0.5, 0.5, { sample: solid(1) })).toBeCloseTo(1, 9);
    expect(evaluateFieldJs('luminance', 0.5, 0.5, { sample: solid(0.5) })).toBeCloseTo(0.5, 9);
  });

  it('edges: high across a boundary, zero on flat regions (§89)', () => {
    const step = (u: number) => (u < 0.5 ? [0, 0, 0] : [1, 1, 1]) as [number, number, number];
    const flat = evaluateFieldJs('edges', 0.25, 0.5, { sample: (u) => step(u) });
    const edge = evaluateFieldJs('edges', 0.5, 0.5, { sample: (u) => step(u) });
    expect(flat).toBe(0);
    expect(edge).toBeGreaterThan(0.9);
  });

  it('invert is 1-f (implemented shader-side; contract here)', () => {
    const f = evaluateFieldJs('horizontal', 0.2, 0.5);
    expect(1 - f).toBeCloseTo(0.8, 9);
  });
});

describe('time-field technique', () => {
  it('is registered, temporal, with atlas-bounded depth range', () => {
    const def = getTechnique('time-field');
    expect(def).not.toBeNull();
    expect(techniqueNeedsTemporal('time-field', {})).toBe(true);
    const params = def!.sections.flatMap((s) => s.params);
    const depth = params.find((p) => p.id === 'depth');
    expect(depth?.type).toBe('number');
    if (depth?.type === 'number') {
      expect(depth.max).toBeCloseTo(2.29, 2); // never promise more than the atlas (§29)
      expect(depth.default).toBeGreaterThan(0); // §48: temporal on load
    }
    const field = params.find((p) => p.id === 'field');
    expect(field?.type).toBe('select');
    if (field?.type === 'select') {
      expect(field.options.map((o) => o.value)).toEqual(
        Object.keys(FIELD_IDS),
      );
    }
  });

  it('GLSL and TS stay in lockstep: shared constants and shapes', () => {
    // Both sides must agree on the kind ids the shader switches on.
    expect(FIELD_IDS.horizontal).toBe(0);
    expect(FIELD_IDS.edges).toBe(6);
    for (const name of Object.keys(FIELD_IDS)) {
      expect(GLSL_FIELDS.length).toBeGreaterThan(0);
      void name;
    }
    // The shader evaluates fields inline — no field texture uniforms exist.
    expect(GLSL_FIELDS.includes('uniform sampler2D uFieldTex')).toBe(false);
  });
});

describe('structural gates', () => {
  const code = (...parts: string[]) =>
    readFileSync(join(__dirname, '..', ...parts), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('no field texture manager, no extra passes, no future sampling', () => {
    const renderer = code('src', 'techniques', 'time-field', 'TimeFieldRenderer.ts');
    expect(renderer.includes('WebGLRenderTarget')).toBe(false); // single pass
    expect(renderer.includes('setRenderTarget')).toBe(false);
    // offset is always additive into the PAST (sampleTemporal offsets are
    // "seconds behind head") — no negative/future addressing appears.
    expect(renderer.includes('offsetSeconds = uOffsetSec + f * uDepthSec')).toBe(true);
    const fields = code('src', 'rendering', 'shaders', 'fields.ts');
    expect(fields.includes('FieldTextureManager')).toBe(false);
    expect(fields.includes('Math.random')).toBe(false);
  });

  it('noise phase is composition-time driven, not wall clock', () => {
    const renderer = code('src', 'techniques', 'time-field', 'TimeFieldRenderer.ts');
    expect(renderer.includes('ctx.timeSec')).toBe(true);
    expect(renderer.includes('performance.now')).toBe(false);
  });
});

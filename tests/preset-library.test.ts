import { describe, expect, it } from 'vitest';
import { BUILTIN_PRESETS } from '@/projects/presetActions';
import { presetSchema } from '@shared/schemas/preset';
import { getTechnique } from '@/techniques/registry';
import { BUILTIN_MATERIALS } from '@/materials/builtins';
import { MOD_SOURCES } from '@/modulation/sources';

/**
 * CE1A — the preset library is DATA, so the whole catalog is validated
 * mechanically: every parameter against its technique definition, every
 * modulation against the real source/target vocabulary. A preset that
 * drifts out of range can never ship silently.
 */

const CATEGORIES = [
  'Minimal',
  'Temporal',
  'Optical',
  'Geometry',
  'Analog',
  'Digital Damage',
  'Studies',
  'Live',
  'Performance',
];

const SOURCE_IDS = new Set(MOD_SOURCES.map((s) => s.id));
const MATERIAL_IDS = new Set(BUILTIN_MATERIALS.map((m) => m.id));

describe('CE1A preset library', () => {
  it('has 40–60 curated presets with unique ids and names', () => {
    expect(BUILTIN_PRESETS.length).toBeGreaterThanOrEqual(40);
    expect(BUILTIN_PRESETS.length).toBeLessThanOrEqual(60);
    const ids = new Set(BUILTIN_PRESETS.map((p) => p.id));
    const names = new Set(BUILTIN_PRESETS.map((p) => p.name));
    expect(ids.size).toBe(BUILTIN_PRESETS.length);
    expect(names.size).toBe(BUILTIN_PRESETS.length);
  });

  it('every preset parses against the preset schema', () => {
    for (const preset of BUILTIN_PRESETS) {
      expect(() => presetSchema.parse(preset), preset.name).not.toThrow();
    }
  });

  it('every preset belongs to a canonical category and carries a description', () => {
    for (const p of BUILTIN_PRESETS) {
      expect(CATEGORIES, `${p.name}: category '${p.category}'`).toContain(p.category);
      expect(p.description.length, `${p.name} needs a description`).toBeGreaterThan(10);
    }
    // Every category is actually used — no dead groups in the dropdown.
    for (const cat of CATEGORIES) {
      expect(
        BUILTIN_PRESETS.some((p) => p.category === cat),
        `category ${cat} is empty`,
      ).toBe(true);
    }
  });

  it('every parameter exists in its technique definition and sits inside its range', () => {
    for (const preset of BUILTIN_PRESETS) {
      const def = getTechnique(preset.techniqueId);
      expect(def, `${preset.name}: unknown technique ${preset.techniqueId}`).not.toBeNull();
      const params = new Map(def!.sections.flatMap((g) => g.params.map((p) => [p.id, p] as const)));
      for (const [key, value] of Object.entries(preset.params)) {
        const paramDef = params.get(key);
        expect(paramDef, `${preset.name}: unknown param '${key}'`).toBeDefined();
        if (paramDef!.type === 'number') {
          expect(typeof value, `${preset.name}.${key}`).toBe('number');
          expect(value as number, `${preset.name}.${key} below min`).toBeGreaterThanOrEqual(
            paramDef!.min,
          );
          expect(value as number, `${preset.name}.${key} above max`).toBeLessThanOrEqual(
            paramDef!.max,
          );
        } else if (paramDef!.type === 'select') {
          const allowed = paramDef!.options.map((o) => o.value);
          expect(allowed, `${preset.name}.${key}='${String(value)}'`).toContain(value);
        } else if (paramDef!.type === 'boolean') {
          expect(typeof value, `${preset.name}.${key}`).toBe('boolean');
        }
      }
    }
  });

  it('every modulation uses a real signal source and a real modulatable target', () => {
    for (const preset of BUILTIN_PRESETS) {
      const def = getTechnique(preset.techniqueId)!;
      const params = new Map(def.sections.flatMap((g) => g.params.map((p) => [p.id, p] as const)));
      for (const m of preset.modulations) {
        expect(SOURCE_IDS.has(m.source), `${preset.name}: source '${m.source}'`).toBe(true);
        const target = params.get(m.target);
        expect(target, `${preset.name}: target '${m.target}'`).toBeDefined();
        expect(target!.type, `${preset.name}: target '${m.target}' must be numeric`).toBe(
          'number',
        );
        expect(Math.abs(m.amount)).toBeLessThanOrEqual(1);
        expect(m.frozenValue).toBeNull();
      }
    }
  });

  it('every material reference is a real builtin material', () => {
    for (const p of BUILTIN_PRESETS) {
      expect(MATERIAL_IDS.has(p.material.materialId), `${p.name}: ${p.material.materialId}`).toBe(
        true,
      );
      expect(p.material.assetPath).toBeNull(); // builtins never reference user files
    }
  });

  it('no two presets on the same technique are near-identical parameter twins', () => {
    const byTech = new Map<string, (typeof BUILTIN_PRESETS)[number][]>();
    for (const p of BUILTIN_PRESETS) {
      byTech.set(p.techniqueId, [...(byTech.get(p.techniqueId) ?? []), p]);
    }
    for (const [, group] of byTech) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i]!;
          const b = group[j]!;
          const keys = new Set([...Object.keys(a.params), ...Object.keys(b.params)]);
          let differing = 0;
          for (const k of keys) {
            if (JSON.stringify(a.params[k]) !== JSON.stringify(b.params[k])) differing++;
          }
          const distinctMaterial = a.material.materialId !== b.material.materialId;
          const distinctMods =
            JSON.stringify(a.modulations.map((m) => [m.source, m.target])) !==
            JSON.stringify(b.modulations.map((m) => [m.source, m.target]));
          expect(
            differing >= 2 || distinctMaterial || distinctMods,
            `${a.name} vs ${b.name}: slider-variation twins`,
          ).toBe(true);
        }
      }
    }
  });

  it('all builtins are flagged builtin and keep stable ids', () => {
    for (const p of BUILTIN_PRESETS) {
      expect(p.builtin).toBe(true);
      expect(p.id.startsWith('builtin-'), p.id).toBe(true);
    }
  });
});

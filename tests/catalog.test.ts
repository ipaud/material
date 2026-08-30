import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listTechniques } from '@/techniques/registry';
import { allParams, type ParamDef, type TechniqueDefinition } from '@/techniques/types';
import { GENERATORS } from '@/sources/generators/definitions';
import { BUILTIN_PRESETS } from '@/projects/presetActions';
import { TRANSITION_STYLES } from '@/rendering/transition/TransitionCompositor';

/**
 * CE1H — the CATALOG gate.
 *
 * Creative Expansion 01 added enough public surface that "it registered
 * fine" stopped being a useful statement. This file is the mechanical
 * contract for the inventory: ids and names unique, every preset points at
 * a real technique with real parameters in range, no reset-only parameter
 * advertised as modulatable, and — the important one — the committed
 * inventory cannot drift from the live registry without failing.
 *
 * Regenerate after an intentional catalog change:
 *   MATERIAL_WRITE_INVENTORY=1 npx vitest run tests/catalog.test.ts
 */

const INVENTORY_PATH = join(__dirname, '..', 'docs', 'inventory.json');

function paramSummary(p: ParamDef) {
  if (p.type === 'number')
    return {
      id: p.id,
      label: p.label,
      type: p.type,
      min: p.min,
      max: p.max,
      step: p.step,
      default: p.default,
      // Absent means modulatable; only an explicit false opts out.
      modulatable: p.modulatable !== false,
      randomizable: p.explore?.randomizable === true,
    };
  if (p.type === 'select')
    return {
      id: p.id,
      label: p.label,
      type: p.type,
      options: p.options.map((o) => o.value),
      default: p.default,
      modulatable: false,
      randomizable: p.explore?.randomizable === true,
    };
  return {
    id: p.id,
    label: p.label,
    type: p.type,
    default: p.default,
    modulatable: false,
    randomizable: p.explore?.randomizable === true,
  };
}

function techniqueSummary(t: TechniqueDefinition) {
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    sections: t.sections.map((s) => s.label),
    params: allParams(t).map(paramSummary),
  };
}

export function buildInventory() {
  return {
    techniques: listTechniques()
      .map(techniqueSummary)
      .sort((a, b) => a.id.localeCompare(b.id)),
    generators: GENERATORS.map((g) => ({
      id: g.id,
      name: g.name,
      mode: g.mode,
      params: g.params.map(paramSummary),
    })).sort((a, b) => a.id.localeCompare(b.id)),
    transitionStyles: [...TRANSITION_STYLES],
    presets: BUILTIN_PRESETS.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      techniqueId: p.techniqueId,
      paramKeys: Object.keys(p.params).sort(),
      modulationCount: p.modulations.length,
      triggerCount: p.triggers.length,
    })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

const inventory = buildInventory();

describe('inventory drift gate (§2-3)', () => {
  it('the committed inventory matches the live registry', () => {
    if (process.env.MATERIAL_WRITE_INVENTORY) {
      writeFileSync(INVENTORY_PATH, `${JSON.stringify(inventory, null, 2)}\n`);
    }
    expect(existsSync(INVENTORY_PATH)).toBe(true);
    const committed = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8'));
    // A silent catalog change is a release bug, not a detail.
    expect(committed).toEqual(inventory);
  });
});

describe('technique catalog (§3)', () => {
  const techniques = listTechniques();

  it('ids and names are unique', () => {
    const ids = techniques.map((t) => t.id);
    const names = techniques.map((t) => t.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every public technique declares parameters', () => {
    for (const t of techniques) {
      expect(t.sections.length, `${t.id} has no sections`).toBeGreaterThan(0);
      expect(allParams(t).length, `${t.id} has no params`).toBeGreaterThan(0);
    }
  });

  it('every parameter has a usable range and an in-range default', () => {
    for (const t of techniques) {
      for (const p of allParams(t)) {
        expect(p.id, `${t.id}: empty param id`).toBeTruthy();
        expect(p.label, `${t.id}.${p.id}: empty label`).toBeTruthy();
        if (p.type !== 'number') continue;
        expect(p.max, `${t.id}.${p.id}: max <= min`).toBeGreaterThan(p.min);
        expect(p.step, `${t.id}.${p.id}: step <= 0`).toBeGreaterThan(0);
        expect(p.default, `${t.id}.${p.id}: default < min`).toBeGreaterThanOrEqual(p.min);
        expect(p.default, `${t.id}.${p.id}: default > max`).toBeLessThanOrEqual(p.max);
      }
    }
  });

  it('parameter ids are unique within a technique', () => {
    for (const t of techniques) {
      const ids = allParams(t).map((p) => p.id);
      expect(new Set(ids).size, `${t.id} has duplicate param ids`).toBe(ids.length);
    }
  });

  it('an explore range stays inside the parameter range', () => {
    for (const t of techniques) {
      for (const p of allParams(t)) {
        if (p.type !== 'number' || !p.explore) continue;
        if (p.explore.min !== undefined)
          expect(p.explore.min, `${t.id}.${p.id}`).toBeGreaterThanOrEqual(p.min);
        if (p.explore.max !== undefined)
          expect(p.explore.max, `${t.id}.${p.id}`).toBeLessThanOrEqual(p.max);
      }
    }
  });
});

describe('generator catalog (§3)', () => {
  it('ids and names are unique', () => {
    const ids = GENERATORS.map((g) => g.id);
    const names = GENERATORS.map((g) => g.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every generator parameter has a usable range and in-range default', () => {
    for (const g of GENERATORS) {
      expect(g.params.length, `${g.id} has no params`).toBeGreaterThan(0);
      const ids = g.params.map((p) => p.id);
      expect(new Set(ids).size, `${g.id} duplicate param ids`).toBe(ids.length);
      for (const p of g.params) {
        if (p.type !== 'number') continue;
        expect(p.max, `${g.id}.${p.id}`).toBeGreaterThan(p.min);
        expect(p.step, `${g.id}.${p.id}`).toBeGreaterThan(0);
        expect(p.default, `${g.id}.${p.id}`).toBeGreaterThanOrEqual(p.min);
        expect(p.default, `${g.id}.${p.id}`).toBeLessThanOrEqual(p.max);
      }
    }
  });

  it('a seed-like reset-only parameter is never advertised as modulatable', () => {
    // Continuously modulating a seed restarts the system every frame.
    for (const g of GENERATORS) {
      for (const p of g.params) {
        if (p.type !== 'number') continue;
        if (/seed|density|grid/i.test(p.id) && p.modulatable === true) {
          throw new Error(`${g.id}.${p.id} is reset-only but modulatable`);
        }
      }
    }
  });
});

describe('preset catalog (§3, §6)', () => {
  it('ids and names are unique', () => {
    const ids = BUILTIN_PRESETS.map((p) => p.id);
    const names = BUILTIN_PRESETS.map((p) => p.name);
    expect(new Set(ids).size).toBe(ids.length);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes, `duplicate preset names: ${dupes.join(', ')}`).toEqual([]);
  });

  it('every preset points at a registered technique', () => {
    const known = new Set(listTechniques().map((t) => t.id));
    for (const p of BUILTIN_PRESETS) {
      expect(known.has(p.techniqueId), `${p.id} → unknown technique ${p.techniqueId}`).toBe(true);
    }
  });

  it('every preset parameter exists on its technique and is in range', () => {
    for (const p of BUILTIN_PRESETS) {
      const def = listTechniques().find((t) => t.id === p.techniqueId);
      if (!def) continue;
      const byId = new Map(allParams(def).map((d) => [d.id, d]));
      for (const [key, value] of Object.entries(p.params)) {
        const d = byId.get(key);
        expect(d, `${p.id}: param "${key}" does not exist on ${p.techniqueId}`).toBeDefined();
        if (!d || d.type !== 'number' || typeof value !== 'number') continue;
        expect(value, `${p.id}.${key} below min`).toBeGreaterThanOrEqual(d.min);
        expect(value, `${p.id}.${key} above max`).toBeLessThanOrEqual(d.max);
      }
    }
  });

  it('every preset modulation targets a real, modulatable parameter', () => {
    for (const p of BUILTIN_PRESETS) {
      const def = listTechniques().find((t) => t.id === p.techniqueId);
      if (!def) continue;
      const byId = new Map(allParams(def).map((d) => [d.id, d]));
      for (const m of p.modulations) {
        // target is "<techniqueInstanceId>.<paramId>"; generators use the
        // "source." namespace and are validated against GENERATORS instead.
        if (m.target.startsWith('source.')) continue;
        const paramId = m.target.slice(m.target.indexOf('.') + 1);
        const d = byId.get(paramId);
        expect(d, `${p.id}: modulation targets missing param ${m.target}`).toBeDefined();
        if (!d) continue;
        expect(d.type, `${p.id}: modulation targets non-numeric ${m.target}`).toBe('number');
        if (d.type === 'number') {
          expect(
            d.modulatable !== false,
            `${p.id}: modulation targets reset-only ${m.target}`,
          ).toBe(true);
        }
      }
    }
  });

  it('every preset is filed under a curated category', () => {
    const CATEGORIES = new Set([
      'Minimal',
      'Temporal',
      'Optical',
      'Geometry',
      'Analog',
      'Digital Damage',
      'Studies',
      'Live',
      'Performance',
      'Feedback',
      'Motion',
      'Simulation',
    ]);
    for (const p of BUILTIN_PRESETS) {
      expect(CATEGORIES.has(p.category), `${p.id}: category "${p.category}" is not curated`).toBe(
        true,
      );
    }
  });

  it('every registered technique is reachable from at least one preset', () => {
    // An unreachable technique is either undiscoverable or should be hidden.
    const used = new Set(BUILTIN_PRESETS.map((p) => p.techniqueId));
    const orphans = listTechniques()
      .map((t) => t.id)
      .filter((id) => !used.has(id));
    expect(orphans, `techniques with no preset: ${orphans.join(', ')}`).toEqual([]);
  });
});

/**
 * CE1H §4-7 — the CURATION pass, recorded.
 *
 * Every preset was rendered against four reference sources (graphic grid,
 * landscape waves, synthetic motion noise, and real dance footage) through
 * the EXPORT preparation path, then measured for flatness and for
 * near-duplication at full tile resolution.
 *
 * Two harness lessons are worth keeping, because both produced confident
 * wrong answers first:
 *  - A bare `renderStill` primes no history, feedback or flow, so every
 *    temporal preset rendered the same bare frame and the sheet reported
 *    292 "duplicates". The tiles have to go through the export path.
 *  - Comparing downscaled thumbnails averages out high-frequency texture:
 *    Coral and Worm Field looked identical at 32×18 and differ by 204 at
 *    full resolution. Duplicate checks are made on full tiles.
 *
 * Outcome — 108 presets in, 107 out:
 *   REMOVED  Single Line (slit-scan) — at strips 2 with interpolation it is
 *            mathematically Time Field horizontal, and rendered
 *            byte-identical to Deep Curtain on every source. Signal Tear
 *            already covers the low-strip territory, and the name described
 *            something the preset never did.
 *   RETUNED  Memory Leak — 36 additive copies at decay 0.985 saturated to
 *            pure white (mean 255, zero spatial variance) on every source.
 *   RETUNED  Field of Dots — dots too small against too much gap, mean 3-10.
 *   RETUNED  Chemical Bloom — feed/kill sat in the dying region: dark, and
 *            crowding Coral. Moved to unused low-feed/low-kill territory.
 *
 * After: zero flat-or-blown presets, zero full-resolution near-duplicate
 * pairs across all four sources.
 */
describe('curation outcome (§4-7)', () => {
  it('the removed preset stays removed', () => {
    expect(BUILTIN_PRESETS.find((p) => p.id === 'builtin-single-line')).toBeUndefined();
  });

  it('the retuned presets keep the values curation landed on', () => {
    const by = (id: string) => BUILTIN_PRESETS.find((p) => p.id === id)?.params ?? {};
    // Regressing any of these puts a blown, black or duplicate tile back in
    // the library, which the contact sheet would have to catch again.
    expect(by('builtin-memory-leak')).toMatchObject({ copies: 22, decay: 0.86, opacity: 0.2 });
    expect(by('builtin-field-of-dots')).toMatchObject({ scale: 1.25, spacing: 0.2 });
    expect(by('builtin-chemical-bloom')).toMatchObject({ feed: 0.022, kill: 0.0515 });
  });

  it('Reaction Diffusion presets occupy distinct feed/kill territory', () => {
    const rd = BUILTIN_PRESETS.filter((p) => p.techniqueId === 'reaction-diffusion');
    const seen = new Set<string>();
    for (const p of rd) {
      const key = `${p.params.feed}/${p.params.kill}`;
      expect(seen.has(key), `duplicate Gray-Scott regime ${key}`).toBe(false);
      seen.add(key);
    }
    expect(rd.length).toBeGreaterThan(3);
  });
});

/**
 * CE1H §11 — Inspector grouping.
 *
 * Techniques own their own sections; the conceptual table only decides which
 * heading a parameter appears under, and an unknown parameter falls back to
 * its technique's section label. That fallback is safe but silent, so every
 * CE1D/E/F parameter was landing in a per-technique heading while everything
 * older shared four conceptual ones. This asserts the vocabulary stays
 * complete without redesigning the Inspector.
 */
describe('inspector grouping covers the catalog (§11)', () => {
  it('every technique parameter has a conceptual group', () => {
    const source = readFileSync(
      join(__dirname, '..', 'src', 'inspector', 'paramGroups.ts'),
      'utf8',
    );
    const mapped = new Set([...source.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*): '/gm)].map((m) => m[1]));
    const unmapped = [
      ...new Set(listTechniques().flatMap((t) => allParams(t).map((p) => p.id))),
    ].filter((id) => !mapped.has(id));
    expect(unmapped, `ungrouped params: ${unmapped.join(', ')}`).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { SIGNAL_PRESETS } from '@/projects/signalPresets';
import { BUILTIN_PRESETS } from '@/projects/presetActions';
import { getTechnique } from '@/techniques/registry';
import { allParams } from '@/techniques/types';
import { VISUAL_SIGNAL_IDS, visualSignalDef } from '@/signals/visual/types';
import { replaceConflicts } from '@/modulation/evaluator';

/**
 * v0.4D — the curated Looks that exist to prove why image and motion signals
 * were built. These assertions are about CURATION, not arithmetic: ranges that
 * were actually chosen, targets that exist, and no two Looks that are the same
 * Look with a different name.
 */

const VISUAL = new Set<string>(VISUAL_SIGNAL_IDS);

describe('signal-driven Looks (§66-92)', () => {
  it('ships a curated handful, not a catalogue', () => {
    expect(SIGNAL_PRESETS.length).toBeGreaterThanOrEqual(12);
    expect(SIGNAL_PRESETS.length).toBeLessThanOrEqual(20);
  });

  it('every one is reachable from the built-in library and tagged reactive', () => {
    for (const p of SIGNAL_PRESETS) {
      expect(BUILTIN_PRESETS.some((b) => b.id === p.id), `${p.name} missing`).toBe(true);
      expect(p.tags).toContain('reactive');
      expect(p.category).toBe('Reactive');
      expect(p.description.length).toBeGreaterThan(12);
    }
  });

  it('every one is actually driven by a visual signal', () => {
    // The tag is a promise. A "reactive" Look with only audio mappings would
    // be a lie the catalogue tells the user.
    for (const p of SIGNAL_PRESETS) {
      const visual = p.modulations.filter((m) => VISUAL.has(m.source));
      expect(visual.length, `${p.name} has no visual mapping`).toBeGreaterThan(0);
    }
  });

  it('every mapping targets a real, modulatable parameter of its technique', () => {
    for (const p of SIGNAL_PRESETS) {
      const def = getTechnique(p.techniqueId);
      expect(def, `${p.name}: unknown technique ${p.techniqueId}`).not.toBeNull();
      const modulatable = new Set(
        allParams(def!)
          .filter((d) => d.type === 'number' && d.modulatable)
          .map((d) => d.id),
      );
      for (const m of p.modulations) {
        expect(modulatable.has(m.target), `${p.name}: ${m.target} is not modulatable`).toBe(true);
      }
    }
  });

  it('every base param the preset sets is inside that parameter range', () => {
    for (const p of SIGNAL_PRESETS) {
      const defs = new Map(allParams(getTechnique(p.techniqueId)!).map((d) => [d.id, d]));
      for (const [id, value] of Object.entries(p.params)) {
        const d = defs.get(id) as unknown as { type: string; min: number; max: number } | undefined;
        if (!d || d.type !== 'number' || typeof value !== 'number') continue;
        expect(value, `${p.name}: ${id}=${value} outside [${d.min}, ${d.max}]`).toBeGreaterThanOrEqual(d.min);
        expect(value).toBeLessThanOrEqual(d.max);
      }
    }
  });

  it('windows are HAND-CURATED, never the lazy full range', () => {
    // A 0..1 window on every mapping is the signature of nobody having looked
    // at the result. At least one mapping per Look must be narrowed.
    for (const p of SIGNAL_PRESETS) {
      const curated = p.modulations.filter(
        (m) => VISUAL.has(m.source) && !(m.min === 0 && m.max === 1),
      );
      expect(curated.length, `${p.name}: every window is the default 0..1`).toBeGreaterThan(0);
    }
  });

  it('positions map with Set, amplitudes stay free to be additive', () => {
    for (const p of SIGNAL_PRESETS) {
      for (const m of p.modulations) {
        const def = visualSignalDef(m.source);
        if (def?.domain === 'position') {
          expect(m.mode, `${p.name}: ${m.source} must position, not nudge`).toBe('replace');
        }
      }
    }
  });

  it('no Look claims a parameter twice with Set — no inert rows shipped', () => {
    for (const p of SIGNAL_PRESETS) {
      expect(replaceConflicts(p.modulations).size, `${p.name} ships an inert mapping`).toBe(0);
    }
  });

  it('no two Looks are the same Look with a different name', () => {
    // Compare the thing that determines behaviour: the technique plus the set
    // of (source → target, window, mode) triples.
    const seen = new Map<string, string>();
    for (const p of SIGNAL_PRESETS) {
      const key = [
        p.techniqueId,
        ...p.modulations
          .map((m) => `${m.source}>${m.target}:${m.min}:${m.max}:${m.mode ?? 'add'}:${m.invert}`)
          .sort(),
      ].join('|');
      expect(seen.has(key), `${p.name} duplicates ${seen.get(key)}`).toBe(false);
      seen.set(key, p.name);
    }
  });

  it('no Look depends on an asset, a pattern or a project global', () => {
    // Portability is the product promise: the same Look has to survive being
    // pointed at a different source.
    for (const p of SIGNAL_PRESETS) {
      expect(p.material.assetPath).toBeNull();
      for (const m of p.modulations) {
        expect(m.source.startsWith('pattern:'), `${p.name} depends on a pattern`).toBe(false);
      }
    }
  });

  it('the vocabulary is exercised — not six Looks on one signal', () => {
    const used = new Set(SIGNAL_PRESETS.flatMap((p) => p.modulations.map((m) => m.source)).filter((s) => VISUAL.has(s)));
    // Every retained signal has at least one Look that shows what it is for.
    for (const id of VISUAL_SIGNAL_IDS) {
      expect(used.has(id), `no Look uses ${id}`).toBe(true);
    }
  });

  it('smoothing is set deliberately on every visual mapping', () => {
    // An unsmoothed visual signal at 26 Hz reads as jitter on most targets.
    for (const p of SIGNAL_PRESETS) {
      for (const m of p.modulations) {
        if (!VISUAL.has(m.source)) continue;
        expect(m.smoothing, `${p.name}: ${m.source} has no smoothing`).toBeGreaterThan(0);
      }
    }
  });
});

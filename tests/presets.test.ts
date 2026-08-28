import { describe, expect, test } from 'vitest';
import {
  BUILTIN_PRESETS,
  presetRequirements,
  unmetRequirementNote,
} from '@/projects/presetActions';
import { presetSchema } from '@shared/schemas/preset';
import { getTechnique } from '@/techniques/registry';
import { allParams } from '@/techniques/types';

describe('system presets', () => {
  test('the four named system presets exist', () => {
    const names = BUILTIN_PRESETS.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['Echo Chamber', 'Pump', 'Time Fracture', 'Slow Burn']));
  });

  test('every builtin validates against the preset schema', () => {
    for (const preset of BUILTIN_PRESETS) {
      expect(() => presetSchema.parse(preset)).not.toThrow();
    }
  });

  test('every builtin targets a registered technique', () => {
    for (const preset of BUILTIN_PRESETS) {
      expect(getTechnique(preset.techniqueId), preset.name).not.toBeNull();
    }
  });

  test('preset params exist on their technique', () => {
    for (const preset of BUILTIN_PRESETS) {
      const definition = getTechnique(preset.techniqueId);
      if (!definition) continue;
      const known = new Set(allParams(definition).map((p) => p.id));
      for (const key of Object.keys(preset.params)) {
        expect(known.has(key), `${preset.name}.${key}`).toBe(true);
      }
    }
  });

  test('preset modulations target modulatable params', () => {
    for (const preset of BUILTIN_PRESETS) {
      const definition = getTechnique(preset.techniqueId);
      if (!definition) continue;
      const modulatable = new Set(
        allParams(definition)
          .filter((p) => p.type === 'number' && p.modulatable)
          .map((p) => p.id),
      );
      for (const mapping of preset.modulations) {
        expect(modulatable.has(mapping.target), `${preset.name} → ${mapping.target}`).toBe(true);
      }
    }
  });

  test('Echo Chamber is temporal and bass-driven', () => {
    const echo = BUILTIN_PRESETS.find((p) => p.id === 'builtin-echo-chamber');
    expect(echo?.params.tileMode).toBe('tile');
    expect(echo?.params.offsetMode).toBe('radial');
    expect(echo?.params.temporalDirection).toBe('outward');
    expect(echo?.modulations[0]).toMatchObject({ source: 'bass', target: 'maxOffsetSec' });
  });

  test('Pump is a beat-triggered scale pulse (Phase 12 replacement)', () => {
    const pump = BUILTIN_PRESETS.find((p) => p.id === 'builtin-pump');
    expect(pump?.modulations).toHaveLength(0);
    expect(pump?.triggers[0]).toMatchObject({
      source: 'beat',
      action: 'pulse',
      targetParam: 'scale',
      curve: 'exponential',
    });
  });
});

describe('preset requirements', () => {
  test('temporal presets require video', () => {
    const echo = BUILTIN_PRESETS.find((p) => p.id === 'builtin-echo-chamber');
    if (!echo) throw new Error('missing preset');
    expect(presetRequirements(echo).video).toBe(true);
  });

  test('audio-modulated presets require audio', () => {
    const burn = BUILTIN_PRESETS.find((p) => p.id === 'builtin-slow-burn');
    if (!burn) throw new Error('missing preset');
    expect(presetRequirements(burn).audio).toBe(true);
  });

  test('beat-driven presets require a BPM', () => {
    const pump = BUILTIN_PRESETS.find((p) => p.id === 'builtin-pump');
    if (!pump) throw new Error('missing preset');
    expect(presetRequirements(pump).bpm).toBe(true);
  });

  test('a plain preset requires nothing', () => {
    const clean = BUILTIN_PRESETS.find((p) => p.id === 'builtin-clean-mosaic');
    if (!clean) throw new Error('missing preset');
    expect(presetRequirements(clean)).toEqual({ video: false, audio: false, bpm: false });
    expect(unmetRequirementNote(clean, { hasVideo: false, hasAudio: false, hasBpm: false })).toBeNull();
  });

  test('unmet requirements are reported, met ones are silent', () => {
    const echo = BUILTIN_PRESETS.find((p) => p.id === 'builtin-echo-chamber');
    if (!echo) throw new Error('missing preset');
    expect(unmetRequirementNote(echo, { hasVideo: false, hasAudio: false, hasBpm: false })).toMatch(
      /video/,
    );
    expect(
      unmetRequirementNote(echo, { hasVideo: true, hasAudio: true, hasBpm: true }),
    ).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseProject } from '@shared/schemas/project';
import { SmoothingState, applyModulations } from '@/modulation/evaluator';
import { getTechnique } from '@/techniques/registry';

/**
 * v0.4E — the compatibility promise, stated as tests.
 *
 * v0.4 adds three optional mapping fields and nine source ids. Nothing about
 * the project format changed, so every project ever written must still open,
 * and every mapping in it must resolve to the number it always did.
 */

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')) as Record<string, unknown>;

describe('project compatibility (§136)', () => {
  it('every committed project fixture still opens', () => {
    const files = readdirSync(join(__dirname, 'fixtures')).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const parsed = parseProject(fixture(f));
      expect(parsed, `${f} failed to parse`).not.toBeNull();
      expect(parsed!.version).toBe(3);
    }
  });

  it('a pre-v0.4 mapping keeps its exact numeric behaviour', () => {
    const parsed = parseProject(fixture('project-v2-pattern.json'))!;
    const def = getTechnique('mosaic')!;
    // Build the same mapping twice: as stored, and with the v0.4C fields
    // spelled out at their neutral values. They must agree exactly.
    const stored = {
      id: 'legacy',
      enabled: true,
      source: 'bass',
      target: 'scale',
      amount: 0.7,
      min: 0.1,
      max: 0.9,
      invert: false,
      smoothing: 0,
      curve: 'linear' as const,
      frozenValue: null,
    };
    const explicit = { ...stored, mode: 'add' as const, inMin: 0, inMax: 1 };
    const a = applyModulations({ scale: 1 }, [stored], { bass: 0.6 }, def, new SmoothingState(), 1 / 60);
    const b = applyModulations({ scale: 1 }, [explicit], { bass: 0.6 }, def, new SmoothingState(), 1 / 60);
    expect(a.scale).toBe(b.scale);
    // And the closed form, so this cannot drift silently.
    const shaped = 0.1 + (0.9 - 0.1) * 0.6;
    expect(a.scale).toBeCloseTo(1 + 0.7 * shaped * 3, 10);
    expect(parsed.version).toBe(3);
  });

  it('a project carrying the new fields round-trips them', () => {
    const base = parseProject(fixture('project-v2-pattern.json'))!;
    const withNew = {
      ...base,
      modulations: [
        {
          id: 'm',
          enabled: true,
          source: 'motion.centroidX',
          target: 'centerX',
          amount: 1,
          min: 0.15,
          max: 0.85,
          invert: false,
          smoothing: 0.2,
          curve: 'linear',
          frozenValue: null,
          mode: 'replace',
          inMin: 0.05,
          inMax: 0.95,
        },
      ],
    };
    const reparsed = parseProject(JSON.parse(JSON.stringify(withNew)))!;
    expect(reparsed.modulations[0]!.mode).toBe('replace');
    expect(reparsed.modulations[0]!.inMin).toBe(0.05);
    expect(reparsed.modulations[0]!.source).toBe('motion.centroidX');
  });

  it('an unknown source id degrades to neutral rather than throwing', () => {
    // A project written by a LATER version, opened here. Absence is the
    // evaluator's neutral, so the mapping is skipped and nothing explodes.
    const def = getTechnique('mosaic')!;
    const out = applyModulations(
      { scale: 1 },
      [
        {
          id: 'future',
          enabled: true,
          source: 'image.somethingNew',
          target: 'scale',
          amount: 1,
          min: 0,
          max: 1,
          invert: false,
          smoothing: 0,
          curve: 'linear',
          frozenValue: null,
        },
      ],
      {},
      def,
      new SmoothingState(),
      1 / 60,
    );
    expect(out.scale).toBe(1);
  });
});

describe('security surface is unchanged (§137)', () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

  it('v0.4 added no preload API', () => {
    // Signals are computed and consumed inside the renderer. Nothing about
    // them needs main-process privilege, so nothing about them is exposed.
    for (const f of ['index.ts', 'output.ts']) {
      const preload = read('electron', 'preload', f).toLowerCase();
      for (const forbidden of ['visual', 'signal', 'analysis', 'reduction', 'calibration']) {
        expect(
          preload.includes(forbidden),
          `preload/${f} should not expose ${forbidden}`,
        ).toBe(false);
      }
    }
  });

  it('no frame data crosses any IPC boundary', () => {
    // The whole point of the GPU ladder is that pixels never leave the GPU
    // except as a 720-byte tile inside the renderer process.
    const channel = read('shared', 'outputChannel.ts');
    for (const forbidden of ['Float32Array', 'ImageData', 'pixels', 'readback']) {
      expect(channel.includes(forbidden), `channel must not carry ${forbidden}`).toBe(false);
    }
  });

  it('the analysis code loads no shader from disk or network', () => {
    for (const f of ['ImageStatsReducer.ts', 'reductionLadder.ts', 'statsDiagnostics.ts']) {
      const src = read('src', 'rendering', 'analysis', f);
      for (const forbidden of ['fetch(', 'readFile', 'import(', 'eval(', 'new Function']) {
        expect(src.includes(forbidden), `${f} must not use ${forbidden}`).toBe(false);
      }
    }
  });
});

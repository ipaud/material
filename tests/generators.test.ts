import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GENERATORS,
  generatorDefaults,
  getGenerator,
  isSourceTarget,
  sourceParamId,
  sourceTarget,
} from '@/sources/generators/definitions';
import {
  createEmptyProject,
  isFileSource,
  isGeneratorSource,
  isLiveSource,
  parseProject,
  projectSchema,
} from '@shared/schemas/project';
import { PROJECT_FORMAT_VERSION } from '@shared/constants/app';
import { applySourceModulations } from '@/modulation/evaluator';
import type { NumberParamDef } from '@/techniques/types';

/** CE1F — generators as first-class sources. */

describe('generator definitions', () => {
  it('ships the stateless family plus the two CE1E simulations', () => {
    const ids = GENERATORS.map((g) => g.id);
    expect(ids).toContain('noise');
    expect(ids).toContain('waves');
    expect(ids).toContain('voronoi');
    expect(ids).toContain('grid');
    expect(ids).toContain('chladni');
    expect(ids).toContain('reaction-diffusion');
    expect(ids).toContain('cellular');
    expect(GENERATORS.filter((g) => g.mode === 'stateless')).toHaveLength(5);
    expect(GENERATORS.filter((g) => g.mode === 'simulation')).toHaveLength(2);
  });

  it('defaults are complete and in range', () => {
    for (const g of GENERATORS) {
      const d = generatorDefaults(g.id);
      for (const p of g.params) {
        expect(d[p.id], `${g.id}.${p.id}`).toBeDefined();
        if (p.type === 'number') {
          expect(d[p.id] as number).toBeGreaterThanOrEqual(p.min);
          expect(d[p.id] as number).toBeLessThanOrEqual(p.max);
        }
      }
    }
  });

  it('reset-only params are non-modulatable (no world restart per frame)', () => {
    for (const id of ['reaction-diffusion', 'cellular']) {
      const g = getGenerator(id)!;
      for (const p of g.params) {
        if (['grid', 'density'].includes(p.id) && p.type === 'number') {
          expect(p.modulatable, `${id}.${p.id}`).toBe(false);
        }
      }
    }
  });
});

describe('source-parameter modulation namespace', () => {
  it('source targets are namespaced and never collide with technique params', () => {
    expect(sourceTarget('scale')).toBe('source.scale');
    expect(isSourceTarget('source.scale')).toBe(true);
    expect(isSourceTarget('scale')).toBe(false); // a technique's own scale
    expect(sourceParamId('source.scale')).toBe('scale');
  });

  it('applies mappings to generator params with clamping and neutrality', () => {
    const defs: NumberParamDef[] = [
      { type: 'number', id: 'scale', label: 'Scale', min: 1, max: 80, step: 1, default: 12, modulatable: true },
    ] as NumberParamDef[];
    const map = (amount: number, target = 'source.scale') => ({
      id: 'm', enabled: true, source: 'pattern:p', target, amount,
      min: 0, max: 1, invert: false, smoothing: 0, curve: 'linear' as const, frozenValue: null,
    });
    const state = { peek: () => undefined, step: (_id: string, v: number) => v } as never;
    const out = applySourceModulations({ scale: 12 }, [map(0.5)], { 'pattern:p': 1 }, defs, state, 1 / 60);
    expect(out.scale).toBeGreaterThan(12); // modulated upward
    expect(out.scale).toBeLessThanOrEqual(80); // clamped to the param range
    // A technique-namespaced target must be ignored by the source pass.
    const skipped = applySourceModulations({ scale: 12 }, [map(0.5, 'scale')], { 'pattern:p': 1 }, defs, state, 1 / 60);
    expect(skipped.scale).toBe(12);
    // Silent source = neutral (no contribution manufactured).
    const silent = applySourceModulations({ scale: 12 }, [map(0.5)], {}, defs, state, 1 / 60);
    expect(silent.scale).toBe(12);
  });
});

describe('schema: generator sources are additive inside v3', () => {
  it('does not bump the project format', () => {
    expect(PROJECT_FORMAT_VERSION).toBe(3);
  });

  it('generator refs round-trip with params and seed', () => {
    const p = createEmptyProject('gen');
    const project = {
      ...p,
      sources: [
        { id: 'g1', kind: 'generator' as const, generator: 'noise', params: { scale: 6 }, seed: 42 },
      ],
      composition: { ...p.composition, sourceId: 'g1' },
    };
    const reloaded = parseProject(JSON.parse(JSON.stringify(projectSchema.parse(project))));
    const src = reloaded.sources[0]!;
    expect(src).toEqual({ id: 'g1', kind: 'generator', generator: 'noise', params: { scale: 6 }, seed: 42 });
    expect(isGeneratorSource(src)).toBe(true);
    expect(isFileSource(src)).toBe(false);
    expect(isLiveSource(src)).toBe(false);
  });

  it('older fixtures still open unchanged', () => {
    const v2 = JSON.parse(
      readFileSync(join(__dirname, 'fixtures', 'project-v2-pattern.json'), 'utf8'),
    ) as Record<string, unknown>;
    const migrated = parseProject(v2);
    expect(migrated.version).toBe(3);
    expect(migrated.sources.every(isFileSource)).toBe(true);
  });
});

describe('structural gates', () => {
  const code = (...parts: string[]) =>
    readFileSync(join(__dirname, '..', ...parts), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('generators are SourceRuntimes, not a separate render universe', () => {
    const src = code('src', 'sources', 'generators', 'GeneratorSource.ts');
    expect(src.includes('implements SourceRuntime')).toBe(true);
    expect(src.includes('temporalSource()')).toBe(true);
    // Stateless generators are exact temporal sources (the decoder-free path).
    expect(src.includes('acquireAt')).toBe(true);
  });

  it('simulation generators reuse the CE1E solver — no duplicate kernel', () => {
    const src = code('src', 'sources', 'generators', 'GeneratorSource.ts');
    expect(src.includes('SimulationRunner')).toBe(true);
    expect(src.includes('reactionDiffusionKernel')).toBe(true);
    expect(src.includes('cellularKernel')).toBe(true);
    // no re-implemented Gray-Scott / life rules here
    // no re-implemented Gray-Scott reaction term or life rule tables here
    expect(src.includes('float abb')).toBe(false);
    expect(src.includes('bitSet(')).toBe(false);
  });

  it('generator shaders are pure: no wall clock, no Math.random', () => {
    const shaders = code('src', 'sources', 'generators', 'generatorShaders.ts');
    expect(shaders.includes('performance.now')).toBe(false);
    expect(shaders.includes('Math.random')).toBe(false);
    expect(shaders.includes('uTime')).toBe(true);
    expect(shaders.includes('uSeed')).toBe(true);
  });

  it('no generated pixels cross the process; only config + resolved params', () => {
    const channel = code('shared', 'outputChannel.ts');
    expect(channel.includes("kind: 'generator'")).toBe(true);
    expect(channel.includes('sourceParams')).toBe(true);
    for (const banned of ['ImageData', 'pixels', 'dataUrl']) {
      expect(channel.includes(banned), `channel must not carry ${banned}`).toBe(false);
    }
  });

  it('the Output never evaluates modulation for source params', () => {
    const replica = code('src', 'output-window', 'replica.ts');
    expect(replica.includes('msg.sourceParams')).toBe(true);
    expect(replica.includes('applySourceModulations')).toBe(false);
    expect(replica.includes('modulationRuntime')).toBe(false);
  });

  it('the CE1D-2 viewport regression stays fixed in generator rendering', () => {
    const src = code('src', 'sources', 'generators', 'GeneratorSource.ts');
    expect(src.includes('setRenderTarget')).toBe(true);
    expect(src.includes('setViewport')).toBe(false);
  });
});

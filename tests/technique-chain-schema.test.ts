import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createEmptyProject, parseProject, projectSchema } from '@shared/schemas/project';
import { PROJECT_FORMAT_VERSION } from '@shared/constants/app';
import { assessTechniqueChain } from '@/techniques/chainCompatibility';

const technique = (id: string, techniqueId: string, params: Record<string, number | boolean | string>) => ({
  id,
  techniqueId,
  enabled: true,
  params,
});

describe('project technique chains', () => {
  it('migrates the legacy v3 single-technique fixture without adding stages', () => {
    const fixture = parseProject(
      JSON.parse(readFileSync(resolve(process.cwd(), 'tests/fixtures/v3-single-layer.material'), 'utf8')),
    );
    const layer = fixture.layers.find((entry) => entry.id === fixture.selectedLayerId)!;

    expect(layer.technique?.techniqueId).toBe('mosaic');
    expect(layer.techniqueChain).toEqual([]);
  });

  it('keeps a moving-source flow chain fixture valid and compatible', () => {
    const fixture = parseProject(
      JSON.parse(readFileSync(resolve(process.cwd(), 'tests/fixtures/motion-rgb-flow-chain.material'), 'utf8')),
    );
    const layer = fixture.layers.find((entry) => entry.id === fixture.selectedLayerId)!;
    const stages = [layer.technique!, ...layer.techniqueChain];

    expect(fixture.sources[0]).toMatchObject({ kind: 'generator', generator: 'waves' });
    expect(stages.map(({ techniqueId }) => techniqueId)).toEqual(['motion-rgb', 'flow-displace']);
    expect(assessTechniqueChain(stages)).toMatchObject({ compatible: true });
  });

  it('advances the project format to v7', () => {
    expect(PROJECT_FORMAT_VERSION).toBe(7);
  });

  it('defaults each layer chain to no additional stages', () => {
    const project = createEmptyProject();
    expect(project.layers[0]!.techniqueChain).toEqual([]);
  });

  it('allows at most two additional stages and requires a primary technique', () => {
    const project = createEmptyProject();
    const primary = technique('primary', 'mosaic', { columns: 24 });
    const extra = technique('extra', 'flow-displace', { amount: 1.25 });
    const secondExtra = technique('second-extra', 'motion-rgb', { amount: 0.8 });
    const layer = project.layers[0]!;

    expect(() =>
      projectSchema.parse({
        ...project,
        layers: [{ ...layer, technique: primary, techniqueChain: [extra, secondExtra] }],
      }),
    ).not.toThrow();
    expect(() =>
      projectSchema.parse({
        ...project,
        layers: [{ ...layer, technique: primary, techniqueChain: [extra, secondExtra, extra] }],
      }),
    ).toThrow();
    expect(() =>
      projectSchema.parse({
        ...project,
        layers: [{ ...layer, technique: null, techniqueChain: [extra] }],
      }),
    ).toThrow();
  });

  it("migrates a v6 project's legacy technique and starts its chain empty", () => {
    const current = createEmptyProject('v6 migration');
    const legacy = technique('legacy', 'mosaic', { columns: 32, rows: 18 });
    const migrated = parseProject({
      ...current,
      version: 6,
      layers: [{ ...current.layers[0]!, technique: legacy }],
    });

    expect(migrated.version).toBe(7);
    expect(migrated.layers[0]!.technique).toEqual(legacy);
    expect(migrated.layers[0]!.techniqueChain).toEqual([]);
  });

  it('round-trips additional stages in order with their parameter values', () => {
    const project = createEmptyProject('chain round trip');
    const primary = technique('primary', 'mosaic', { columns: 24 });
    const chain = [
      technique('extra-1', 'flow-displace', { amount: 1.25, against: true }),
      technique('extra-2', 'motion-rgb', { amount: 0.8 }),
    ];
    const serialized = JSON.stringify({
      ...project,
      layers: [{ ...project.layers[0]!, technique: primary, techniqueChain: chain }],
    });

    const parsed = parseProject(JSON.parse(serialized));
    expect(parsed.layers[0]!.technique).toEqual(primary);
    expect(parsed.layers[0]!.techniqueChain).toEqual(chain);
  });
});

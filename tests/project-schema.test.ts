import { describe, expect, test } from 'vitest';
import {
  createEmptyProject,
  parseProject,
  projectSchema,
} from '@shared/schemas/project';

describe('project schema', () => {
  test('empty project validates', () => {
    const project = createEmptyProject('Test');
    expect(() => projectSchema.parse(project)).not.toThrow();
  });

  test('serialization round-trip preserves the project', () => {
    const project = createEmptyProject('Burnout');
    const json = JSON.stringify(project);
    const parsed = parseProject(JSON.parse(json));
    expect(parsed).toEqual(project);
  });

  test('modulation stage target survives serialization by stable ID', () => {
    const project = createEmptyProject('Stage modulation');
    project.modulations = [{
      id: 'stage-mod', enabled: true, source: 'bass', target: 'scale',
      targetStageId: 'stage-2', amount: 1, min: 0, max: 1, invert: false,
      smoothing: 0, curve: 'linear', frozenValue: null,
    }];
    const parsed = parseProject(JSON.parse(JSON.stringify(project)));
    expect(parsed.modulations[0]).toMatchObject({ target: 'scale', targetStageId: 'stage-2' });
  });

  test('v7 Pin layer routing, activity, and default chain survive serialization', () => {
    const project = createEmptyProject('Pin state');
    const layer = project.layers[0]!;
    const withPin = {
      ...project,
      pinnedLooks: [
        {
          id: 'pin-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          label: 'PIN 001',
          note: '',
          slot: null,
          seed: 1,
          thumbnail: null,
          techniques: [],
          material: layer.material,
          modulations: [],
          triggers: [],
          selectedLayerId: layer.id,
          layers: [
            {
              id: layer.id,
              material: layer.material,
              input: 'below',
              activity: { start: 2, end: 8, fadeIn: 1, fadeOut: 1 },
            },
          ],
        },
      ],
    };
    const parsed = parseProject(JSON.parse(JSON.stringify(withPin)));
    expect(parsed.version).toBe(7);
    expect(parsed.pinnedLooks[0]!.layers![0]).toMatchObject({
      input: 'below',
      activity: { start: 2, end: 8, fadeIn: 1, fadeOut: 1 },
    });
  });

  test('rejects unsupported version', () => {
    const project = { ...createEmptyProject(), version: 999 };
    expect(() => parseProject(project)).toThrow(/version/i);
  });

  test('rejects corrupted structure', () => {
    expect(() => parseProject({ version: 1, name: 42 })).toThrow();
    expect(() => parseProject(null)).toThrow();
    expect(() => parseProject('string')).toThrow();
  });
});

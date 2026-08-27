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

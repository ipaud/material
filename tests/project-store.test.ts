import { beforeEach, describe, expect, test } from 'vitest';
import { useProjectStore } from '@/state/projectStore';

function store() {
  return useProjectStore.getState();
}

describe('project store history', () => {
  beforeEach(() => {
    store().newProject();
  });

  test('apply pushes undo history', () => {
    store().apply((p) => ({ ...p, name: 'A' }));
    store().apply((p) => ({ ...p, name: 'B' }));
    expect(store().project.name).toBe('B');
    store().undo();
    expect(store().project.name).toBe('A');
    store().undo();
    expect(store().project.name).toBe('Untitled');
    store().redo();
    expect(store().project.name).toBe('A');
  });

  test('redo stack clears on new change', () => {
    store().apply((p) => ({ ...p, name: 'A' }));
    store().undo();
    store().apply((p) => ({ ...p, name: 'C' }));
    store().redo();
    expect(store().project.name).toBe('C');
  });

  test('transient gesture coalesces into a single history entry', () => {
    store().beginTransient();
    for (let i = 0; i < 50; i++) {
      store().apply((p) => ({ ...p, name: `drag-${i}` }));
    }
    store().commitTransient();
    expect(store().project.name).toBe('drag-49');
    store().undo();
    expect(store().project.name).toBe('Untitled');
    expect(store().past.length).toBe(0);
  });

  test('cancelTransient restores the pre-gesture state', () => {
    store().apply((p) => ({ ...p, name: 'base' }));
    store().beginTransient();
    store().apply((p) => ({ ...p, name: 'dragging' }));
    store().cancelTransient();
    expect(store().project.name).toBe('base');
  });

  test('dirty flag tracks changes and saves', () => {
    expect(store().dirty).toBe(false);
    store().apply((p) => ({ ...p, name: 'X' }));
    expect(store().dirty).toBe(true);
    store().markSaved('/tmp/x.material');
    expect(store().dirty).toBe(false);
    expect(store().projectPath).toBe('/tmp/x.material');
  });
});

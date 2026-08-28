import { beforeEach, describe, expect, test } from 'vitest';
import { createEmptyProject } from '@shared/schemas/project';
import type { PinnedLook, Project } from '@shared/schemas/project';
import { useProjectStore } from '@/state/projectStore';
import { candidateRuntime } from '@/performance/candidateRuntime';
import { morphRuntime } from '@/performance/morphRuntime';
import { captureLookCore } from '@/performance/lookCore';
import { setMacroValue } from '@/performance/performanceActions';
import { applyLook, pinCurrentLook, updateLook } from '@/projects/lookActions';
import { freezeAll, clearAllFreezes } from '@/modulation/modulationActions';
import { liveScheduler } from '@/signals/triggerRuntime';

/**
 * Phase 17 §24: long undo/redo sequences across every v0.2 system. The
 * property under test is that history and RUNTIME state stay in step — a
 * rewind must not leave an overlay armed, a candidate pointing at a state
 * that no longer exists, or a Look marked active that was never applied.
 */

function look(id: string, scale: number, slot: number, withModulation = false): PinnedLook {
  return {
    id,
    createdAt: new Date(0).toISOString(),
    label: id.toUpperCase(),
    note: '',
    slot,
    seed: 1,
    thumbnail: null,
    techniques: [{ id: `t-${id}`, techniqueId: 'mosaic', enabled: true, params: { scale } }],
    material: createEmptyProject().material,
    modulations: withModulation
      ? [
          {
            id: 'mod-look', enabled: true, source: 'bass', target: 'scale', amount: 0.4,
            min: 0, max: 1, invert: false, smoothing: 0.1, curve: 'linear', frozenValue: null,
          },
        ]
      : [],
    triggers: [],
  };
}

function project(): Project {
  const p = createEmptyProject('Undo');
  return {
    ...p,
    techniques: [{ id: 'tech', techniqueId: 'mosaic', enabled: true, params: { scale: 1 } }],
    modulations: [
      {
        id: 'mod-1', enabled: true, source: 'bass', target: 'scale', amount: 0.5,
        min: 0, max: 1, invert: false, smoothing: 0.2, curve: 'linear', frozenValue: null,
      },
    ],
    macros: [
      {
        id: 'mac-1', name: 'M', value: 0,
        mappings: [
          { targetParam: 'scale', amount: 0.5, min: 0, max: 1, invert: false, curve: 'linear', enabled: true },
        ],
      },
    ],
    pinnedLooks: [look('look-a', 0.4, 1, true), look('look-b', 2.2, 2)],
    timeline: { ...p.timeline, bpm: 120 },
    performanceQuantize: 'off',
  };
}

describe('long undo / redo sequences', () => {
  beforeEach(() => {
    candidateRuntime.reset();
    morphRuntime.abortSilently();
    liveScheduler.reset(0);
    useProjectStore.getState().loadProject('', project());
  });

  test('a mixed sequence rewinds completely and replays identically', () => {
    const store = () => useProjectStore.getState();
    const initial = JSON.parse(JSON.stringify(store().project));

    // 1 macro gesture
    store().beginTransient();
    for (let v = 0; v <= 10; v++) setMacroValue('mac-1', v / 10);
    store().commitTransient();
    // 2 look apply
    applyLook('look-b');
    // 3 freeze
    freezeAll();
    // 4 pin
    pinCurrentLook();
    // 5 update
    updateLook('look-a');
    // 6 candidate apply
    candidateRuntime.generate();
    candidateRuntime.apply();
    // 7 unfreeze
    clearAllFreezes();

    const afterAll = JSON.parse(JSON.stringify(store().project));
    const depth = store().past.length;
    expect(depth).toBeGreaterThanOrEqual(5);

    for (let i = 0; i < depth; i++) store().undo();
    expect(store().project).toEqual(initial);

    for (let i = 0; i < depth; i++) store().redo();
    expect(store().project).toEqual(afterAll);
  });

  test('undo past a candidate apply drops the runtime candidate', () => {
    candidateRuntime.generate();
    expect(candidateRuntime.current).not.toBeNull();
    candidateRuntime.apply();
    expect(candidateRuntime.current).toBeNull();
    useProjectStore.getState().undo();
    // Nothing may point at a state that no longer exists.
    expect(candidateRuntime.current).toBeNull();
    expect(candidateRuntime.isPreviewing).toBe(false);
  });

  test('undo never runs while a gesture is open', () => {
    const store = () => useProjectStore.getState();
    const before = JSON.parse(JSON.stringify(store().project));
    store().beginTransient();
    setMacroValue('mac-1', 0.9);
    store().undo(); // must be refused mid-gesture
    expect(store().project.macros[0]!.value).toBe(0.9);
    store().commitTransient();
    store().undo();
    expect(store().project).toEqual(before);
  });

  test('active Look and frozen mappings stay consistent through a rewind', () => {
    const store = () => useProjectStore.getState();
    applyLook('look-a');
    expect(store().project.activeLookId).toBe('look-a');
    freezeAll();
    expect(store().project.modulations[0]!.frozenValue).not.toBeNull();
    applyLook('look-b');
    expect(store().project.activeLookId).toBe('look-b');
    // look-b carries no modulations, so nothing is frozen any more.
    expect(store().project.modulations).toHaveLength(0);
    store().undo(); // back to frozen look-a
    expect(store().project.activeLookId).toBe('look-a');
    expect(store().project.modulations[0]!.frozenValue).not.toBeNull();
    store().undo(); // back before the freeze
    expect(store().project.modulations[0]!.frozenValue).toBeNull();
  });

  test('a morph commit is one entry and undo restores the pre-morph core', () => {
    const store = () => useProjectStore.getState();
    applyLook('look-a');
    const before = captureLookCore(store().project)!;
    const depth = store().past.length;
    morphRuntime.start(
      'look-b',
      { startQuantize: 'off', duration: { mode: 'seconds', seconds: 2 }, curve: 'linear' },
      0,
    );
    morphRuntime.tick(2.5);
    expect(store().past.length).toBe(depth + 1);
    expect(store().project.morphEvents).toHaveLength(1);
    store().undo();
    expect(captureLookCore(store().project)!.params).toEqual(before.params);
    expect(store().project.morphEvents).toHaveLength(0);
  });

  test('rapid undo/redo churn leaves no stale runtime state', () => {
    const store = () => useProjectStore.getState();
    applyLook('look-b');
    freezeAll();
    pinCurrentLook();
    for (let i = 0; i < 40; i++) {
      store().undo();
      store().redo();
    }
    expect(morphRuntime.current).toBeNull();
    expect(candidateRuntime.current).toBeNull();
    expect(store().project.pinnedLooks.length).toBeGreaterThanOrEqual(2);
    // History pointers remain coherent: one more undo still moves.
    const snapshot = JSON.stringify(store().project);
    store().undo();
    expect(JSON.stringify(store().project)).not.toBe(snapshot);
  });
});

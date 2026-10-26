import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';

const actions = vi.hoisted(() => ({
  overwriteSlotWithCurrent: vi.fn(),
  pinCurrentLook: vi.fn(),
  performLookRecall: vi.fn(),
  performToggleFreeze: vi.fn(),
  toggleArm: vi.fn(),
  toggleTakePlayback: vi.fn(),
  applyLookQuantized: vi.fn(() => true),
  cancelPendingActions: vi.fn(() => 0),
  cycleQuantize: vi.fn(),
  firePad: vi.fn(),
  morphToLookQuantized: vi.fn(),
  generate: vi.fn(),
  setPreview: vi.fn(),
  apply: vi.fn(),
  discard: vi.fn(),
  cancelQueued: vi.fn(),
  morphCancelKeep: vi.fn(),
}));

vi.mock('@/projects/lookActions', () => ({
  overwriteSlotWithCurrent: actions.overwriteSlotWithCurrent,
  pinCurrentLook: actions.pinCurrentLook,
}));
vi.mock('@/performance/take/gestures', () => ({
  performLookRecall: actions.performLookRecall,
  performToggleFreeze: actions.performToggleFreeze,
}));
vi.mock('@/performance/take/takeActions', () => ({
  toggleArm: actions.toggleArm,
  toggleTakePlayback: actions.toggleTakePlayback,
}));
vi.mock('@/performance/morphRuntime', () => ({
  morphRuntime: { current: null, cancelKeep: actions.morphCancelKeep },
}));
vi.mock('@/performance/performanceActions', () => ({
  applyLookQuantized: actions.applyLookQuantized,
  cancelPendingActions: actions.cancelPendingActions,
  cycleQuantize: actions.cycleQuantize,
  firePad: actions.firePad,
  morphToLookQuantized: actions.morphToLookQuantized,
}));
vi.mock('@/performance/candidateRuntime', () => ({
  candidateRuntime: {
    current: { id: 'candidate' },
    generate: actions.generate,
    setPreview: actions.setPreview,
    apply: actions.apply,
    discard: actions.discard,
    cancelQueued: actions.cancelQueued,
  },
}));
vi.mock('@/utils/platform', () => ({
  isMac: true,
  hasCommand: (e: KeyboardEvent) => e.metaKey,
}));

import { usePerformanceKeys } from '@/hooks/usePerformanceKeys';
import { useWorkspaceKeys } from '@/hooks/useWorkspaceKeys';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { useOutputStore } from '@/state/outputStore';
import { CLOSED_OUTPUT_STATUS } from '@shared/display';
import { createEmptyProject } from '@shared/schemas/project';

const initialProjectState = useProjectStore.getState();
const initialUiState = useUiStore.getState();
const initialOutputState = useOutputStore.getState();

function key(code: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ workspace: 'perform', perfMorphTargetId: null, perfHud: false });
  useProjectStore.setState({
    project: {
      ...createEmptyProject('Keyboard test'),
      pinnedLooks: [{
        id: 'look-1', createdAt: '2026-01-01T00:00:00.000Z', label: 'Look', note: '',
        slot: 1, seed: 1, thumbnail: null, techniques: [],
        material: { materialId: 'square', colorMode: 'source', params: {}, assetPath: null },
        modulations: [], triggers: [],
      }],
      performancePads: [{ id: 'pad-1', label: 'Pad', velocityScale: false, trigger: null }],
    },
  });
  useOutputStore.setState({
    status: CLOSED_OUTPUT_STATUS,
    mode: 'windowed',
    selectMode: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useProjectStore.setState(initialProjectState, true);
  useUiStore.setState(initialUiState, true);
  useOutputStore.setState(initialOutputState, true);
});

describe('keyboard shortcut hooks', () => {
  it('routes look, pin, freeze, and take keys and ignores modified or edited text', () => {
    renderHook(() => usePerformanceKeys());

    expect(key('Digit2').defaultPrevented).toBe(true);
    key('Digit3', { shiftKey: true });
    key('KeyP');
    key('KeyF');
    key('KeyR');
    key('KeyT');
    key('Digit1', { metaKey: true });
    const editable = document.createElement('div');
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    const textTargets = [
      document.createElement('input'),
      document.createElement('textarea'),
      document.createElement('select'),
      editable,
    ];
    for (const target of textTargets) {
      document.body.append(target);
      key(target instanceof HTMLTextAreaElement ? 'Backspace' : 'KeyP', {}, target);
      target.remove();
    }

    expect(actions.applyLookQuantized.mock.calls).toEqual([[2]]);
    expect(actions.discard).not.toHaveBeenCalled();
    expect(actions.overwriteSlotWithCurrent).toHaveBeenCalledWith(3);
    expect(actions.pinCurrentLook).toHaveBeenCalledOnce();
    expect(actions.performToggleFreeze).toHaveBeenCalledOnce();
    expect(actions.toggleArm).toHaveBeenCalledOnce();
    expect(actions.toggleTakePlayback).toHaveBeenCalledOnce();
  });

  it('keeps candidate audition held, supports candidate actions in Explore, and ignores text fields', () => {
    useUiStore.setState({ workspace: 'explore' });
    renderHook(() => usePerformanceKeys());

    key('KeyG');
    key('KeyG', { shiftKey: true });
    expect(key('KeyB').defaultPrevented).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyB', bubbles: true }));
    key('Enter');
    key('Backspace');
    key('KeyG', { ctrlKey: true });

    expect(actions.generate).toHaveBeenNthCalledWith(1);
    expect(actions.generate).toHaveBeenNthCalledWith(2, { fromCandidate: true });
    expect(actions.setPreview).toHaveBeenNthCalledWith(1, true);
    expect(actions.setPreview).toHaveBeenNthCalledWith(2, false);
    expect(actions.apply).toHaveBeenCalledOnce();
    expect(actions.discard).toHaveBeenCalledOnce();
    expect(actions.generate).toHaveBeenCalledTimes(2);
  });

  it('keeps quantize, morph, pads, HUD, and Escape scoped to PLAY', () => {
    renderHook(() => usePerformanceKeys());
    key('KeyQ');
    useUiStore.setState({ perfMorphTargetId: 'look-1' });
    key('KeyM');
    key('KeyZ');
    key('Tab');
    key('Escape');

    expect(actions.cycleQuantize).toHaveBeenCalledOnce();
    expect(actions.morphToLookQuantized).toHaveBeenCalledWith('look-1', { mode: 'bars', bars: 1 });
    expect(actions.firePad).toHaveBeenCalledWith('pad-1');
    expect(useUiStore.getState().perfHud).toBe(true);
    expect(actions.cancelQueued).toHaveBeenCalledOnce();

    useUiStore.setState({ workspace: 'build' });
    key('KeyQ');
    expect(actions.cycleQuantize).toHaveBeenCalledOnce();
  });

  it('switches workspace only for Command+Option+1–4 and only toggles an open Output window', () => {
    renderHook(() => useWorkspaceKeys());
    const valid = key('Digit2', { metaKey: true, altKey: true });
    expect(valid.defaultPrevented).toBe(true);
    expect(useUiStore.getState().workspace).toBe('explore');
    key('Digit3', { metaKey: true, altKey: true, shiftKey: true });
    key('Digit3', { ctrlKey: true, altKey: true });
    expect(useUiStore.getState().workspace).toBe('explore');

    key('KeyF', { metaKey: true, shiftKey: true });
    expect(useOutputStore.getState().selectMode).not.toHaveBeenCalled();
    useOutputStore.setState({ status: { ...CLOSED_OUTPUT_STATUS, state: 'open', displayId: 1, mode: 'windowed' } });
    key('KeyF', { metaKey: true, shiftKey: true });
    expect(useOutputStore.getState().selectMode).toHaveBeenCalledWith('fullscreen');
  });
});

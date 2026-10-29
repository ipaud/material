import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriggerMapping } from '@shared/schemas/project';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { addGeneratorSource } from '@/projects/projectActions';
import { overwriteSlotWithCurrent } from '@/projects/lookActions';
import { morphRuntime } from '@/performance/morphRuntime';
import { configureTriggers, fireManualTrigger, getTriggerState, resetTriggers } from '@/signals/triggerRuntime';

/**
 * What each trigger action does to the live project when a hand fires it (a pad, a key, a MIDI note):
 * freezes, Look recall and stepping, parameter reset, mapping toggles, morphs.
 */

vi.mock('@/performance/thumbnail', () => ({ renderThumbnail: () => ({ dataUrl: null, luminance: null }), isDarkThumbnail: () => false }));

const project = () => useProjectStore.getState().project;
const toasts = () => useUiStore.getState().toasts.map((t) => t.message);
const CTX = { bpm: 120, beatOffsetSec: 0, beatsPerBar: 4, analysis: null, markers: [] };

function trigger(action: TriggerMapping['action'], patch: Partial<TriggerMapping> = {}): TriggerMapping {
  return {
    id: `t-${action}`,
    enabled: true,
    source: 'manual',
    action,
    targetParam: null,
    targetMappingId: null,
    lookSlot: null,
    quantize: 'off',
    cooldownSec: 0,
    attackSec: 0,
    holdSec: 0,
    decaySec: 0.2,
    amount: 0.5,
    curve: 'linear',
    ...patch,
  } as TriggerMapping;
}

let now = 0;
function fire(t: TriggerMapping): void {
  configureTriggers([t], CTX);
  now += 1;
  fireManualTrigger(t.id, now);
}

const mapping = (id: string, frozenValue: number | null = null) => ({
  id,
  enabled: true,
  source: 'bass',
  target: 'scale',
  amount: 1,
  min: 0,
  max: 1,
  smoothing: 0,
  curve: 'linear',
  invert: false,
  frozenValue,
});

beforeEach(() => {
  now = 0;
  useProjectStore.getState().newProject();
  useUiStore.setState({ toasts: [] });
  addGeneratorSource('noise');
  resetTriggers(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Looks from triggers', () => {
  it('applyLook recalls the slot, or says the slot is empty', () => {
    overwriteSlotWithCurrent(1);
    const look = project().pinnedLooks[0]!;
    useProjectStore.getState().apply((p) => ({ ...p, activeLookId: null }));
    fire(trigger('applyLook', { lookSlot: 1 }));
    expect(project().activeLookId).toBe(look.id);
    fire(trigger('applyLook', { lookSlot: 7 }));
    expect(toasts().at(-1)).toBe('No pinned look in slot 7');
  });

  it('next and previous Look wrap around the pinned list', () => {
    overwriteSlotWithCurrent(1);
    overwriteSlotWithCurrent(2);
    const [a, b] = project().pinnedLooks;
    fire(trigger('applyLook', { lookSlot: 1 })); // stepping continues from the last recalled Look
    expect(project().activeLookId).toBe(a!.id);
    fire(trigger('nextLook'));
    expect(project().activeLookId).toBe(b!.id);
    fire(trigger('nextLook'));
    expect(project().activeLookId).toBe(a!.id);
    fire(trigger('prevLook'));
    expect(project().activeLookId).toBe(b!.id);
  });

  it('stepping with no Looks does nothing', () => {
    const before = project();
    fire(trigger('nextLook'));
    fire(trigger('prevLook'));
    expect(project().pinnedLooks).toEqual(before.pinnedLooks);
  });

  it('pinLook pins the current state', () => {
    fire(trigger('pinLook'));
    expect(project().pinnedLooks).toHaveLength(1);
  });

  it('morphToLook starts a morph toward the slot, or says it is empty', () => {
    const start = vi.spyOn(morphRuntime, 'start').mockImplementation(() => undefined as never);
    overwriteSlotWithCurrent(3);
    fire(trigger('morphToLook', { lookSlot: 3 }));
    expect(start).toHaveBeenCalledWith(project().pinnedLooks[0]!.id, expect.objectContaining({ duration: { mode: 'bars', bars: 1 }, curve: 'easeInOut' }), 1);
    fire(trigger('morphToLook', { lookSlot: 9 }));
    expect(toasts().at(-1)).toBe('No pinned look in slot 9 to morph to');
  });
});

describe('mappings and parameters', () => {
  beforeEach(() => {
    useProjectStore.getState().apply((p) => ({ ...p, modulations: [mapping('m1'), mapping('m2', 0.3)] as never }));
  });

  it('freeze and unfreeze one mapping or all of them', () => {
    fire(trigger('freeze', { targetMappingId: 'm1' }));
    expect(project().modulations.find((m) => m.id === 'm1')!.frozenValue).not.toBeNull();
    fire(trigger('unfreeze', { targetMappingId: '*' }));
    expect(project().modulations.every((m) => m.frozenValue === null)).toBe(true);
    fire(trigger('freeze'));
    expect(project().modulations.every((m) => m.frozenValue !== null)).toBe(true);
  });

  it('toggleFreeze flips each mapping on its own', () => {
    fire(trigger('toggleFreeze'));
    expect(project().modulations.map((m) => m.frozenValue === null)).toEqual([false, true]);
  });

  it('toggleMapping switches one mapping off and on', () => {
    fire(trigger('toggleMapping', { targetMappingId: 'm2' }));
    expect(project().modulations.find((m) => m.id === 'm2')!.enabled).toBe(false);
    fire(trigger('toggleMapping', { targetMappingId: 'm2' }));
    expect(project().modulations.find((m) => m.id === 'm2')!.enabled).toBe(true);
  });

  it('resetParam puts the selected layer’s parameter back to its default; unknown ids change nothing', () => {
    useProjectStore.getState().apply((p) => ({
      ...p,
      layers: p.layers.map((l) => (l.technique ? { ...l, technique: { ...l.technique, params: { ...l.technique.params, scale: 1.9 } } } : l)),
    }));
    fire(trigger('resetParam', { targetParam: 'scale' }));
    expect(project().layers[0]!.technique!.params.scale).not.toBe(1.9);
    const before = project();
    fire(trigger('resetParam', { targetParam: 'nope' }));
    expect(project()).toBe(before);
  });
});

it('the bridge’s configuration is what the runtime holds', () => {
  const t = trigger('pinLook');
  configureTriggers([t], CTX);
  expect(getTriggerState()).toEqual({ triggers: [t], ctx: CTX });
  fireManualTrigger('unknown', 1); // no such trigger: nothing happens
  expect(project().pinnedLooks).toHaveLength(0);
});

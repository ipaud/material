import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { playback } from '@/playback/PlaybackController';
import { getTriggerState, liveScheduler } from '@/signals/triggerRuntime';
import type { MorphDuration } from '@/performance/morphRuntime';
import { performLookRecall, performMorph } from '@/performance/take/gestures';
import { uid } from '@/utils/id';
import type { Macro, QuantizeMode, TriggerMapping } from '@shared/schemas/project';

/**
 * Performance-surface actions (Phase 15). Everything routes through the
 * existing systems: quantized actions ride the ONE TriggerScheduler (no
 * second queue), morphs ride morphRuntime, pads fire existing trigger
 * mappings. Live-class only — none of this is export state.
 */

export function setPerformanceQuantize(mode: QuantizeMode): void {
  useProjectStore.getState().apply((p) => ({ ...p, performanceQuantize: mode }));
}

export function cycleQuantize(): void {
  const order: QuantizeMode[] = ['off', 'beat', 'bar', '2bars', '4bars'];
  const current = useProjectStore.getState().project.performanceQuantize;
  const next = order[(order.indexOf(current) + 1) % order.length] as QuantizeMode;
  setPerformanceQuantize(next);
}

/** Synthesized live trigger for a quantized performance action. */
function perfTrigger(patch: Partial<TriggerMapping>): TriggerMapping {
  return {
    id: `perf-${patch.action}-${patch.lookSlot ?? 0}`,
    enabled: true,
    source: 'manual',
    action: 'applyLook',
    targetParam: null,
    targetMappingId: null,
    lookSlot: null,
    quantize: 'off',
    cooldownSec: 0,
    attackSec: 0.01,
    holdSec: 0,
    decaySec: 0.18,
    amount: 0.35,
    curve: 'easeOut',
    ...patch,
  };
}

/**
 * Apply a look under the global performance quantization. Immediate when
 * OFF; otherwise queued on the live scheduler and shown as pending.
 */
export function applyLookQuantized(slot: number): boolean {
  const { project } = useProjectStore.getState();
  if (!project.pinnedLooks.some((l) => l.slot === slot)) return false;
  const quantize = project.performanceQuantize;
  if (quantize === 'off' || !project.timeline.bpm) {
    const look = project.pinnedLooks.find((l) => l.slot === slot);
    if (!look) return false;
    performLookRecall(look.id);
    return true;
  }
  // A QUEUED action is recorded when it executes, not when the button was
  // pressed — the scheduler is the only place that knows the instant a
  // quantized gesture actually landed on, and that instant is what a replay
  // has to reproduce.
  const { ctx } = getTriggerState();
  liveScheduler.fireLive(
    perfTrigger({ action: 'applyLook', lookSlot: slot, quantize }),
    playback.getTime(),
    ctx,
  );
  return true;
}

/** Launch a morph to a look using the global quantization + a musical duration. */
export function morphToLookQuantized(lookId: string, duration: MorphDuration): boolean {
  const { project } = useProjectStore.getState();
  const quantize = project.timeline.bpm ? project.performanceQuantize : 'off';
  return performMorph(lookId, duration, 'easeInOut', quantize);
}

/**
 * Fire a performance pad (live-class). The pad's embedded trigger goes
 * straight to the live scheduler — pads survive look switches because they
 * never live inside look-core trigger state.
 */
export function firePad(padId: string): void {
  const { project } = useProjectStore.getState();
  const pad = project.performancePads.find((p) => p.id === padId);
  if (!pad?.trigger) return;
  const { ctx } = getTriggerState();
  liveScheduler.fireLive({ ...pad.trigger, source: 'manual' }, playback.getTime(), ctx);
  // Presentation-only: lets pad buttons flash on keyboard/MIDI fires too,
  // without any React state on this hot path.
  window.dispatchEvent(new CustomEvent('material:pad-fired', { detail: padId }));
}

/** Esc: drop queued quantized actions (never fires them). */
export function cancelPendingActions(): number {
  const n = liveScheduler.getPending().length;
  liveScheduler.cancelPending();
  if (n > 0) useUiStore.getState().pushToast('info', 'Queued action cancelled');
  return n;
}

// ---- Macros -----------------------------------------------------------

export function setMacroValue(id: string, value: number): void {
  const v = Math.min(Math.max(value, 0), 1);
  useProjectStore.getState().apply((p) => ({
    ...p,
    macros: p.macros.map((m) => (m.id === id ? { ...m, value: v } : m)),
  }));
}

export function renameMacro(id: string, name: string): void {
  const trimmed = name.trim().slice(0, 24);
  if (!trimmed) return;
  useProjectStore.getState().apply((p) => ({
    ...p,
    macros: p.macros.map((m) => (m.id === id ? { ...m, name: trimmed } : m)),
  }));
}

export function resetMacro(id: string): void {
  setMacroValue(id, 0);
}

export function addMacro(name = 'MACRO'): Macro {
  const macro: Macro = { id: uid('macro'), name, value: 0, mappings: [] };
  useProjectStore.getState().apply((p) => ({ ...p, macros: [...p.macros, macro] }));
  return macro;
}

export function deleteMacro(id: string): void {
  useProjectStore.getState().apply((p) => ({
    ...p,
    macros: p.macros.filter((m) => m.id !== id),
    midiMappings: p.midiMappings.filter((m) => !(m.targetType === 'macro' && m.targetParam === id)),
  }));
}

import { TriggerScheduler, type ActionTarget } from './scheduler';
import type { TriggerContext } from './triggerSources';
import type { TriggerMapping } from '@shared/schemas/project';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { freezeMapping, unfreezeMapping, updateMapping } from '@/modulation/modulationActions';
import { applyLook, pinCurrentLook } from '@/projects/lookActions';
import { morphRuntime } from '@/performance/morphRuntime';
import { getTechnique } from '@/techniques/registry';
import { allParams } from '@/techniques/types';

/**
 * Live trigger runtime: one scheduler wired to the real stores, advanced by
 * the playback clock (composition time — never rAF wall time; the tick just
 * delivers the current clock reading).
 */

let currentLookIndex = -1;

function lookIdAtSlot(slot: number): string | null {
  const looks = useProjectStore.getState().project.pinnedLooks;
  const look = looks.find((l) => l.slot === slot);
  if (look) currentLookIndex = looks.indexOf(look);
  return look?.id ?? null;
}

const liveTarget: ActionTarget = {
  freeze: (mappingId) => {
    const { project } = useProjectStore.getState();
    const ids =
      mappingId && mappingId !== '*' ? [mappingId] : project.modulations.map((m) => m.id);
    for (const id of ids) freezeMapping(id);
  },
  unfreeze: (mappingId) => {
    const { project } = useProjectStore.getState();
    const ids =
      mappingId && mappingId !== '*' ? [mappingId] : project.modulations.map((m) => m.id);
    for (const id of ids) unfreezeMapping(id);
  },
  toggleFreeze: (mappingId) => {
    const { project } = useProjectStore.getState();
    const targets =
      mappingId && mappingId !== '*'
        ? project.modulations.filter((m) => m.id === mappingId)
        : project.modulations;
    for (const m of targets) {
      if (m.frozenValue === null) freezeMapping(m.id);
      else unfreezeMapping(m.id);
    }
  },
  pinLook: () => pinCurrentLook(),
  applyLook: (slot) => {
    const id = lookIdAtSlot(slot);
    if (id) applyLook(id);
    else useUiStore.getState().pushToast('info', `No pinned look in slot ${slot}`);
  },
  nextLook: () => {
    const looks = useProjectStore.getState().project.pinnedLooks;
    if (looks.length === 0) return;
    currentLookIndex = (currentLookIndex + 1) % looks.length;
    const look = looks[currentLookIndex];
    if (look) applyLook(look.id);
  },
  prevLook: () => {
    const looks = useProjectStore.getState().project.pinnedLooks;
    if (looks.length === 0) return;
    currentLookIndex = (currentLookIndex - 1 + looks.length) % looks.length;
    const look = looks[currentLookIndex];
    if (look) applyLook(look.id);
  },
  resetParam: (paramId) => {
    useProjectStore.getState().apply((p) => {
      const active = p.techniques.find((t) => t.enabled);
      if (!active) return p;
      const definition = getTechnique(active.techniqueId);
      const def = definition ? allParams(definition).find((d) => d.id === paramId) : null;
      if (!def) return p;
      return {
        ...p,
        techniques: p.techniques.map((t) =>
          t.id === active.id ? { ...t, params: { ...t.params, [paramId]: def.default } } : t,
        ),
      };
    });
  },
  toggleMapping: (mappingId) => {
    const mapping = useProjectStore
      .getState()
      .project.modulations.find((m) => m.id === mappingId);
    if (mapping) updateMapping(mappingId, { enabled: !mapping.enabled });
  },
  applyCandidate: () => {
    // Lazy import avoids a cycle: candidateRuntime imports this module.
    void import('@/performance/candidateRuntime').then(({ candidateRuntime }) => {
      const candidate = candidateRuntime.current;
      if (candidate) candidateRuntime.commit(candidate.id);
    });
  },
  morphToLook: (slot, atTime) => {
    const id = lookIdAtSlot(slot);
    if (!id) {
      useUiStore.getState().pushToast('info', `No pinned look in slot ${slot} to morph to`);
      return;
    }
    // Trigger-launched morphs: event already timed, so start immediately;
    // default musical length of one bar, easeInOut (documented default).
    morphRuntime.start(
      id,
      { startQuantize: 'off', duration: { mode: 'bars', bars: 1 }, curve: 'easeInOut' },
      atTime,
    );
  },
};

export const liveScheduler = new TriggerScheduler(liveTarget);

let triggers: TriggerMapping[] = [];
let triggerCtx: TriggerContext = {
  bpm: null,
  beatOffsetSec: 0,
  beatsPerBar: 4,
  analysis: null,
  markers: [],
};

/** Bridge pushes project/analysis state here (same cadence as modulation). */
export function configureTriggers(nextTriggers: TriggerMapping[], ctx: TriggerContext): void {
  triggers = nextTriggers;
  triggerCtx = ctx;
}

export function getTriggerState(): { triggers: TriggerMapping[]; ctx: TriggerContext } {
  return { triggers, ctx: triggerCtx };
}

/** Called from the playback tick with the current composition time. */
export function tickTriggers(compositionTime: number): void {
  liveScheduler.advanceTo(compositionTime, triggers, triggerCtx);
}

/** Manual fire (UI button now; keyboard/MIDI later share this path). */
export function fireManualTrigger(mappingId: string, compositionTime: number): void {
  const mapping = triggers.find((m) => m.id === mappingId);
  if (mapping) liveScheduler.fireLive(mapping, compositionTime, triggerCtx);
}

export function resetTriggers(timeSec: number | null): void {
  liveScheduler.reset(timeSec);
}

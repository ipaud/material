import { selectedLayerOf, withSelectedTechnique, type ParamValue, type TechniqueInstance } from '@shared/schemas/project';
import { useProjectStore } from '@/state/projectStore';
import { playback } from '@/playback/PlaybackController';
import { setLayerOpacity, toggleLayerEnabled, updateLayer } from '@/projects/layerActions';
import { applyLook } from '@/projects/lookActions';
import { freezeMapping, unfreezeMapping } from '@/modulation/modulationActions';
import { morphRuntime, type MorphDuration } from '@/performance/morphRuntime';
import { captureLookCore } from '@/performance/lookCore';
import type { MorphCurve } from '@shared/schemas/project';
import { getTechnique } from '@/techniques/registry';
import { allParams } from '@/techniques/types';
import { layerOpacityTarget, macroTarget, paramTarget, stageParamTarget } from './model';
import { takeRecorder } from './recorder';

/**
 * v0.7B — THE capture seam.
 *
 * One module, and the only one that both records and applies. Everything a
 * hand can do to MATERIAL comes through here: the Performance strip, the
 * inspector, the keyboard, the MIDI engine, the pads. Everything a Take does
 * on replay goes through `livePerformer.ts` instead, which reaches the same
 * state via the primitives below this layer and has no way to reach this one.
 *
 * That asymmetry — record ABOVE the primitive, replay THROUGH it — is what
 * makes "a replayed event cannot record itself" a property of the import
 * graph rather than of a boolean somebody has to remember to check (§35/§36).
 * Generated control never appears here at all: Signals, Audio and Pattern
 * reach parameters through the evaluator, which is nowhere near this file.
 *
 * Structural edits are absent by the same logic (§41/§91/§92): adding a layer,
 * changing a source or a technique, and editing routes are composition edits,
 * so their actions were left exactly where they were.
 */

function now(): number {
  return playback.getTime();
}

/**
 * Snapshot the creative state a Look recall is about to overwrite.
 *
 * Called before every gesture that can replace it. The recorder keeps only
 * the first, so this is idempotent and costs a `captureLookCore` on the few
 * frames a Look actually changes.
 */
function markLookBaseline(): void {
  if (!takeRecorder.recording) return;
  const { project } = useProjectStore.getState();
  const core = captureLookCore(project);
  if (core) takeRecorder.captureLookBaseline(core, project.activeLookId);
}

// ---- Continuous ------------------------------------------------------------

export function performLayerOpacity(layerId: string, value: number): void {
  const layer = useProjectStore.getState().project.layers.find((l) => l.id === layerId);
  takeRecorder.control(layerOpacityTarget(layerId), value, now(), layer?.opacity ?? value, 1);
  setLayerOpacity(layerId, value);
}

export function performMacroValue(macroId: string, value: number): void {
  const macro = useProjectStore.getState().project.macros.find((m) => m.id === macroId);
  takeRecorder.control(macroTarget(macroId), value, now(), macro?.value ?? value, 1);
  useProjectStore.getState().apply((p) => ({
    ...p,
    macros: p.macros.map((m) =>
      m.id === macroId ? { ...m, value: Math.min(Math.max(value, 0), 1) } : m,
    ),
  }));
}

/**
 * A performable numeric parameter, dragged directly.
 *
 * The recorder's epsilon is scaled by the parameter's own range, so it means
 * the same fraction of travel whether the control runs 0..1 or 0..4096 (§22).
 * The lane stores the parameter's OWN value, not a normalised position, so it
 * agrees with what a Look stores for the same parameter.
 *
 * Only the SELECTED layer's technique is writable this way, matching the
 * inspector — which is the only place the gesture exists.
 */
export function performSelectedParam(paramId: string, value: ParamValue): void {
  const { project } = useProjectStore.getState();
  const layer = selectedLayerOf(project);
  // A non-numeric parameter (enum, boolean) is applied but not recorded: those
  // are structure more often than performance, and §93 leaves them for later.
  if (typeof value === 'number') {
    const current = layer.technique?.params[paramId];
    const definition = layer.technique ? getTechnique(layer.technique.techniqueId) : null;
    const def = definition ? allParams(definition).find((d) => d.id === paramId) : undefined;
    takeRecorder.control(
      paramTarget(layer.id, paramId),
      value,
      now(),
      typeof current === 'number' ? current : value,
      def && def.type === 'number' ? def.max - def.min : 1,
    );
  }
  useProjectStore.getState().apply((p) =>
    selectedLayerOf(p).technique
      ? withSelectedTechnique(p, (t: TechniqueInstance | null) =>
          t ? { ...t, params: { ...t.params, [paramId]: value } } : t,
        )
      : p,
  );
}

/** Edit and record numeric control on stable extra-stage identity. */
export function performTechniqueStageParam(stageId: string, paramId: string, value: ParamValue): void {
  const { project } = useProjectStore.getState();
  const layer = selectedLayerOf(project);
  const stage = layer.techniqueChain.find((entry) => entry.id === stageId);
  if (!stage) return;
  const definition = getTechnique(stage.techniqueId);
  const def = definition ? allParams(definition).find((entry) => entry.id === paramId) : undefined;
  if (typeof value === 'number') {
    takeRecorder.control(
      stageParamTarget(layer.id, stage.id, paramId), value, now(),
      typeof stage.params[paramId] === 'number' ? stage.params[paramId] as number : value,
      def?.type === 'number' ? def.max - def.min : 1,
    );
  }
  useProjectStore.getState().apply((p) => ({
    ...p,
    layers: p.layers.map((entry) => entry.id !== layer.id ? entry : {
      ...entry,
      techniqueChain: entry.techniqueChain.map((item) => item.id === stageId
        ? { ...item, params: { ...item.params, [paramId]: value } }
        : item),
    }),
  }));
}

// ---- Discrete --------------------------------------------------------------

export function performLookRecall(lookId: string): void {
  markLookBaseline();
  takeRecorder.event({ kind: 'look.recall', lookId, morph: null, on: null, layerId: null, origin: 'user' }, now());
  applyLook(lookId);
}

export function performMorph(
  lookId: string,
  duration: MorphDuration,
  curve: MorphCurve,
  startQuantize: Parameters<typeof morphRuntime.start>[1]['startQuantize'],
): boolean {
  markLookBaseline();
  // While a Take is recording it becomes this morph's record; writing a
  // morphEvent as well would hand the export two virtual morphs for one
  // gesture.
  const started = morphRuntime.start(lookId, {
    startQuantize,
    duration,
    curve,
    record: !takeRecorder.recording,
  });
  if (!started) return false;
  const active = morphRuntime.current;
  takeRecorder.event(
    {
      kind: 'morph.start',
      lookId,
      morph: {
        durationMode: 'seconds',
        // The quantized start and the musical length are already resolved to
        // exact seconds by morphRuntime — recording the RESOLVED schedule is
        // what makes a replay land on the instant the performance did, rather
        // than re-quantizing itself one boundary further out each time.
        durationValue: active ? Math.max(active.endTime - active.startTime, 0.05) : 1,
        curve,
      },
      on: null,
      layerId: null,
      origin: 'user',
    },
    // …and the event's own time is the morph's START, not the button press.
    active ? active.startTime : now(),
  );
  return true;
}

/** Explicit state, never a toggle — see the Take contract. */
export function performFreeze(on: boolean): void {
  takeRecorder.event({ kind: 'freeze.set', on, lookId: null, morph: null, layerId: null, origin: 'user' }, now());
  const { project } = useProjectStore.getState();
  for (const m of project.modulations) {
    if (on) {
      if (m.enabled && m.frozenValue === null) freezeMapping(m.id);
    } else if (m.frozenValue !== null) {
      unfreezeMapping(m.id);
    }
  }
}

/** F key: whatever it does, the Take records the STATE it produced. */
export function performToggleFreeze(): void {
  const anyFrozen = useProjectStore
    .getState()
    .project.modulations.some((m) => m.frozenValue !== null);
  performFreeze(!anyFrozen);
}

export function performLayerEnabled(layerId: string, on: boolean): void {
  takeRecorder.event({ kind: 'layer.enable', layerId, on, lookId: null, morph: null, origin: 'user' }, now());
  updateLayer(layerId, { enabled: on });
}

export function performToggleLayerEnabled(layerId: string): void {
  const layer = useProjectStore.getState().project.layers.find((l) => l.id === layerId);
  if (!layer) {
    toggleLayerEnabled(layerId);
    return;
  }
  performLayerEnabled(layerId, !layer.enabled);
}

/**
 * A live-class trigger executed (MIDI note, pad, keyboard, manual button).
 *
 * Called from the scheduler, which is the only place that knows a trigger
 * fired AND knows whether its source was a hand or a beat. Deterministic
 * sources never reach here: they re-evaluate during export from the timeline
 * itself, so recording them would double them (§36).
 */
export function performTriggerAction(
  action: string,
  lookSlot: number | null,
  atComposition: number,
): void {
  if (!takeRecorder.recording) return;
  const { project } = useProjectStore.getState();
  if (action === 'applyLook' || action === 'morphToLook') markLookBaseline();
  const lookId =
    lookSlot === null ? null : (project.pinnedLooks.find((l) => l.slot === lookSlot)?.id ?? null);
  if (action === 'applyLook' && lookId) {
    takeRecorder.event(
      { kind: 'look.recall', lookId, morph: null, on: null, layerId: null, origin: 'midi' },
      atComposition,
    );
    return;
  }
  if (action === 'freeze' || action === 'unfreeze' || action === 'toggleFreeze') {
    const anyFrozen = project.modulations.some((m) => m.frozenValue !== null);
    const on = action === 'freeze' ? true : action === 'unfreeze' ? false : !anyFrozen;
    takeRecorder.event(
      { kind: 'freeze.set', on, lookId: null, morph: null, layerId: null, origin: 'midi' },
      atComposition,
    );
    return;
  }
  if (action === 'morphToLook' && lookId) {
    const { bpm, beatsPerBar } = project.timeline;
    const barSec = bpm && bpm > 0 ? (60 / bpm) * beatsPerBar : 2;
    takeRecorder.event(
      {
        kind: 'morph.start',
        lookId,
        morph: { durationMode: 'seconds', durationValue: barSec, curve: 'easeInOut' },
        on: null,
        layerId: null,
        origin: 'midi',
      },
      atComposition,
    );
  }
  // nextLook/prevLook/pinLook/resetParam/toggleMapping/applyCandidate are not
  // in the Take vocabulary: the first two are relative (a replay would land
  // somewhere else after any Look list edit), and the rest are composition
  // edits. Backlogged, deliberately.
}

import type { TakeBaseline } from '@shared/schemas/project';
import { useProjectStore } from '@/state/projectStore';
import { updateLayer } from '@/projects/layerActions';
import { applyLook } from '@/projects/lookActions';
import { freezeMapping, unfreezeMapping, updateMapping } from '@/modulation/modulationActions';
import { morphRuntime } from '@/performance/morphRuntime';
import { projectWithLookCore } from '@/performance/lookCore';
import type { TakeMorphSpec, TakePerformer } from './evaluate';

/**
 * v0.7B — the editor-side TakePerformer.
 *
 * This module deliberately does NOT import the recorder or `gestures.ts`. A
 * replayed Look recall reaches the store through `applyLook`, the same
 * primitive the Looks panel's click handler eventually calls — but the
 * recording hook lives in the WRAPPER above that primitive, not in it, so
 * replay is structurally incapable of recording itself. That is the whole
 * anti-recursion design (§35/§36); there is no origin flag to forget to pass.
 *
 * Everything here runs inside `runSilently`, because replay is playback and
 * not an edit: no undo entries, no dirty flag (§76).
 */

function silently(fn: () => void): void {
  useProjectStore.getState().runSilently(fn);
}

export const livePerformer: TakePerformer = {
  restoreBaseline(baseline: TakeBaseline): void {
    silently(() => {
      // The creative state a recall replaced, put back first — otherwise a
      // seek to before the Take's first Look recall leaves that Look on
      // screen, because nothing else remembers what it overwrote.
      if (baseline.lookCore) {
        useProjectStore
          .getState()
          .apply((p) => projectWithLookCore(p, baseline.lookCore!, baseline.activeLookId));
      }
      for (const [layerId, enabled] of Object.entries(baseline.layerEnabled)) {
        const layer = useProjectStore.getState().project.layers.find((l) => l.id === layerId);
        if (layer && layer.enabled !== enabled) updateLayer(layerId, { enabled });
      }
      for (const [mappingId, frozen] of Object.entries(baseline.frozen)) {
        const mapping = useProjectStore
          .getState()
          .project.modulations.find((m) => m.id === mappingId);
        if (mapping && mapping.frozenValue !== frozen) {
          updateMapping(mappingId, { frozenValue: frozen });
        }
      }
      // Continuous baselines are NOT written back: a lane holds its first
      // sample backwards (which is that same resting value), so the overlay
      // already answers for every controlled target without touching the
      // document. Writing them would make stopping a Take silently rewrite
      // stored parameters.
    });
    morphRuntime.abortSilently();
  },

  advanceTo(compositionSec: number): void {
    // The morph runtime is the only Take-controlled state that finishes by
    // time passing rather than by an event. Ticking it here is what retires a
    // morph a seek re-created — see TakePerformer.advanceTo.
    morphRuntime.tick(compositionSec);
  },

  recallLook(lookId: string): void {
    silently(() => applyLook(lookId));
  },

  startMorph(lookId: string, atComposition: number, spec: TakeMorphSpec): void {
    const duration =
      spec.durationMode === 'seconds'
        ? ({ mode: 'seconds', seconds: spec.durationValue } as const)
        : spec.durationMode === 'beats'
          ? ({ mode: 'beats', beats: spec.durationValue } as const)
          : ({ mode: 'bars', bars: spec.durationValue } as const);
    // Quantization is deliberately OFF: the recorded time already IS the
    // quantized instant the morph launched at when it was played. Re-applying
    // the grid would push every replay one boundary later than the
    // performance, and further each time.
    silently(() =>
      morphRuntime.start(
        lookId,
        // record: false — this morph is already recorded, in the Take that is
        // replaying it. See ActiveMorph.record.
        { startQuantize: 'off', duration, curve: spec.curve, record: false },
        atComposition,
      ),
    );
  },

  setFreeze(on: boolean): void {
    silently(() => {
      const { project } = useProjectStore.getState();
      for (const m of project.modulations) {
        if (on) {
          if (m.enabled && m.frozenValue === null) freezeMapping(m.id);
        } else if (m.frozenValue !== null) {
          unfreezeMapping(m.id);
        }
      }
    });
  },

  setLayerEnabled(layerId: string, on: boolean): void {
    silently(() => {
      const layer = useProjectStore.getState().project.layers.find((l) => l.id === layerId);
      if (layer && layer.enabled !== on) updateLayer(layerId, { enabled: on });
    });
  },
};

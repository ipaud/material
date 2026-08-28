import { useEffect } from 'react';
import { applyLookBySlot, overwriteSlotWithCurrent, pinCurrentLook } from '@/projects/lookActions';
import { toggleFreezeAll } from '@/modulation/modulationActions';
import { useUiStore } from '@/state/uiStore';
import { useProjectStore } from '@/state/projectStore';
import { morphRuntime, type MorphDuration } from '@/performance/morphRuntime';
import {
  applyLookQuantized,
  cancelPendingActions,
  cycleQuantize,
  firePad,
  morphToLookQuantized,
} from '@/performance/performanceActions';
import { candidateRuntime } from '@/performance/candidateRuntime';

const PAD_CODES = ['KeyZ', 'KeyX', 'KeyC', 'KeyV'];
const DURATION_VALUES: Record<string, MorphDuration> = {
  '1beat': { mode: 'beats', beats: 1 },
  '2beats': { mode: 'beats', beats: 2 },
  '1bar': { mode: 'bars', bars: 1 },
  '2bars': { mode: 'bars', bars: 2 },
  '4bars': { mode: 'bars', bars: 4 },
};

/**
 * Performance keys (Phases 13/15/16):
 *   1–9        apply look (quantized in PERFORM workspace)
 *   Shift+1–9  overwrite that slot with the current state
 *   P          pin current look
 *   F          freeze all / clear all (toggle)
 * PERFORM workspace only:
 *   Q          cycle quantization
 *   M          morph to the selected target look
 *   Z X C V    trigger pads 1–4
 *   Tab        minimal HUD
 *   Esc        cancel queued actions, else cancel-and-keep an armed morph
 *   G          mutate: generate a candidate from CURRENT
 *   Shift+G    mutate again, using the candidate as parent
 *   B (hold)   audition the candidate; release returns to CURRENT
 *   Enter      apply the candidate (quantized)
 *   Backspace  discard the candidate
 * Space (play), ` (A/B), ⌘-shortcuts owned elsewhere — no collisions.
 */
export function usePerformanceKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable)
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const isPerf = useUiStore.getState().workspace === 'perform';

      if (e.code.startsWith('Digit')) {
        const digit = Number(e.code.slice(5));
        if (digit >= 1 && digit <= 9) {
          e.preventDefault();
          if (e.shiftKey) {
            overwriteSlotWithCurrent(digit);
          } else {
            const ok = isPerf ? applyLookQuantized(digit) : applyLookBySlot(digit);
            if (!ok) {
              useUiStore.getState().pushToast('info', `No look in slot ${digit} — press P to pin`);
            }
          }
          return;
        }
      }
      if (e.shiftKey) {
        // Shift+M: mutate again from the candidate (lineage step).
        if (isPerf && e.code === 'KeyG') {
          e.preventDefault();
          candidateRuntime.generate({ fromCandidate: true });
        }
        return;
      }

      if (e.code === 'KeyP') {
        e.preventDefault();
        void pinCurrentLook();
        return;
      }
      if (e.code === 'KeyF') {
        e.preventDefault();
        toggleFreezeAll();
        return;
      }
      if (!isPerf) return;

      if (e.code === 'KeyQ') {
        e.preventDefault();
        cycleQuantize();
      } else if (e.code === 'KeyM') {
        e.preventDefault();
        const { perfMorphTargetId, perfMorphDuration } = useUiStore.getState();
        if (perfMorphTargetId) {
          morphToLookQuantized(
            perfMorphTargetId,
            DURATION_VALUES[perfMorphDuration] ?? { mode: 'bars', bars: 1 },
          );
        } else {
          useUiStore.getState().pushToast('info', 'No morph target — right-click a look tile');
        }
      } else if (e.code === 'Tab') {
        e.preventDefault();
        useUiStore.getState().togglePerfHud();
      } else if (e.code === 'Escape') {
        e.preventDefault();
        candidateRuntime.cancelQueued();
        if (cancelPendingActions() === 0 && morphRuntime.current) {
          morphRuntime.cancelKeep();
        }
      } else if (e.code === 'KeyG') {
        e.preventDefault();
        candidateRuntime.generate();
      } else if (e.code === 'KeyB') {
        // B = the "other side": A is CURRENT, B is CANDIDATE (§5). Held, not
        // toggled — releasing always lands back on CURRENT.
        e.preventDefault();
        if (!e.repeat) candidateRuntime.setPreview(true);
      } else if (e.code === 'Enter') {
        e.preventDefault();
        if (candidateRuntime.current) candidateRuntime.apply();
      } else if (e.code === 'Backspace' || e.code === 'Delete') {
        e.preventDefault();
        candidateRuntime.discard();
      } else if (PAD_CODES.includes(e.code)) {
        e.preventDefault();
        const index = PAD_CODES.indexOf(e.code);
        const pad = useProjectStore.getState().project.performancePads[index];
        if (pad) firePad(pad.id);
      }
    };
    // Hold-to-preview: release returns to CURRENT (naturally safe, §4).
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'KeyB') candidateRuntime.setPreview(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);
}

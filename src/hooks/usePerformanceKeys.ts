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

const PAD_CODES = ['KeyZ', 'KeyX', 'KeyC', 'KeyV'];
const DURATION_VALUES: Record<string, MorphDuration> = {
  '1beat': { mode: 'beats', beats: 1 },
  '2beats': { mode: 'beats', beats: 2 },
  '1bar': { mode: 'bars', bars: 1 },
  '2bars': { mode: 'bars', bars: 2 },
  '4bars': { mode: 'bars', bars: 4 },
};

/**
 * Performance keys (§6/§15/§25):
 *   1–9        apply look (quantized in PERFORMANCE workspace)
 *   Shift+1–9  overwrite that slot with the current state
 *   P          pin current look
 *   F          freeze all / clear all (toggle)
 * PERFORMANCE workspace only:
 *   Q          cycle quantization
 *   M          morph to the selected target look
 *   Z X C V    trigger pads 1–4
 *   Tab        minimal HUD
 *   Esc        cancel queued action, else cancel-and-keep an armed morph
 * Space (play), ` (A/B), ⌘-shortcuts owned elsewhere — no collisions.
 */
export function usePerformanceKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable)
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const isPerf = useUiStore.getState().workspace === 'performance';

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
      if (e.shiftKey) return;

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
        if (cancelPendingActions() === 0 && morphRuntime.current) {
          morphRuntime.cancelKeep();
        }
      } else if (PAD_CODES.includes(e.code)) {
        e.preventDefault();
        const index = PAD_CODES.indexOf(e.code);
        const pad = useProjectStore.getState().project.performancePads[index];
        if (pad) firePad(pad.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

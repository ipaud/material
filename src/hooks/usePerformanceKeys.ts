import { useEffect } from 'react';
import { applyLookBySlot, overwriteSlotWithCurrent, pinCurrentLook } from '@/projects/lookActions';
import { toggleFreezeAll } from '@/modulation/modulationActions';
import { useUiStore } from '@/state/uiStore';

/**
 * Performance keys (§6/§15):
 *   1–9        apply pinned look in that slot
 *   Shift+1–9  overwrite that slot with the current state
 *   P          pin current look
 *   F          freeze all modulated targets / clear all freezes (toggle)
 * Space (play), ` (A/B), ⌘-shortcuts are owned elsewhere — no collisions:
 * these are bare keys with no modifier except the documented Shift.
 */
export function usePerformanceKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable)
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.code.startsWith('Digit')) {
        const digit = Number(e.code.slice(5));
        if (digit >= 1 && digit <= 9) {
          e.preventDefault();
          if (e.shiftKey) {
            overwriteSlotWithCurrent(digit);
          } else if (!applyLookBySlot(digit)) {
            useUiStore.getState().pushToast('info', `No look in slot ${digit} — press P to pin`);
          }
          return;
        }
      }
      if (e.shiftKey) return;
      if (e.code === 'KeyP') {
        e.preventDefault();
        pinCurrentLook();
      } else if (e.code === 'KeyF') {
        e.preventDefault();
        toggleFreezeAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

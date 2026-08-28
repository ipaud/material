import { useExportStore } from '@/state/exportStore';
import { useUiStore } from '@/state/uiStore';

/**
 * Export isolation (Phase 17 §23).
 *
 * The frame evaluator works from a snapshot, so parameters are already safe.
 * What is NOT snapshot-able is the shared hardware state a render needs: the
 * video element's position and the engine's technique/material renderers,
 * which the store bridge pushes live. A look switch or a seek during an
 * export therefore changes pixels mid-render — measured as a byte-different
 * file under live interference.
 *
 * Rather than duplicate the renderer, MATERIAL blocks the handful of actions
 * that move that shared state while an export runs, and says so.
 */
export function isExporting(): boolean {
  return useExportStore.getState().phase === 'running';
}

/** True when the action must NOT run; also tells the user why. */
export function blockedByExport(what: string): boolean {
  if (!isExporting()) return false;
  useUiStore.getState().pushToast('info', `${what} is unavailable while exporting`);
  return true;
}

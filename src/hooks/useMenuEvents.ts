import { useEffect } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import {
  importMediaViaDialog,
  newProject,
  openProject,
  saveProject,
} from '@/projects/projectActions';
import { useExportStore } from '@/state/exportStore';
import { morphRuntime } from '@/performance/morphRuntime';

/** Wire native menu events (File/Edit/View accelerators) to app actions. */
export function useMenuEvents(): void {
  useEffect(() => {
    return window.material.onMenuEvent((id) => {
      switch (id) {
        case 'new-project':
          newProject();
          break;
        case 'open-project':
          void openProject();
          break;
        case 'save-project':
          void saveProject();
          break;
        case 'save-project-as':
          void saveProject(true);
          break;
        case 'import-media':
          void importMediaViaDialog();
          break;
        case 'undo':
          // History rewinds under an armed morph would desync the overlay.
          morphRuntime.abortSilently();
          useProjectStore.getState().undo();
          break;
        case 'redo':
          morphRuntime.abortSilently();
          useProjectStore.getState().redo();
          break;
        case 'toggle-debug-overlay':
          useUiStore.getState().toggleDebugOverlay();
          break;
        case 'export':
          useExportStore.getState().openDialog();
          break;
      }
    });
  }, []);
}

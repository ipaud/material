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
          useProjectStore.getState().undo();
          break;
        case 'redo':
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

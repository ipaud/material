import { create } from 'zustand';

export type WorkspaceId = 'create' | 'explore' | 'techniques' | 'modulation' | 'performance';

export interface AppToast {
  id: string;
  kind: 'error' | 'info';
  message: string;
}

interface UiStore {
  workspace: WorkspaceId;
  debugOverlay: boolean;
  showOriginal: boolean; // A/B compare: hold to view source
  toasts: AppToast[];
  libraryWidth: number;
  inspectorWidth: number;
  timelineHeight: number;
  /** Source ids whose files are missing on disk (MEDIA OFFLINE). */
  offlineSources: string[];
  showBeatGrid: boolean;
  showSignalMonitor: boolean;

  setWorkspace: (workspace: WorkspaceId) => void;
  toggleDebugOverlay: () => void;
  setShowOriginal: (show: boolean) => void;
  pushToast: (kind: AppToast['kind'], message: string) => void;
  dismissToast: (id: string) => void;
  setPanelSize: (panel: 'library' | 'inspector' | 'timeline', size: number) => void;
  setOfflineSources: (ids: string[]) => void;
  toggleBeatGrid: () => void;
  toggleSignalMonitor: () => void;
}

let toastCounter = 0;

export const useUiStore = create<UiStore>((set) => ({
  workspace: 'create',
  debugOverlay: false,
  showOriginal: false,
  toasts: [],
  libraryWidth: 220,
  inspectorWidth: 280,
  timelineHeight: 140,
  offlineSources: [],
  showBeatGrid: true,
  showSignalMonitor: false,
  setOfflineSources: (ids) => set({ offlineSources: ids }),
  toggleBeatGrid: () => set((s) => ({ showBeatGrid: !s.showBeatGrid })),
  toggleSignalMonitor: () => set((s) => ({ showSignalMonitor: !s.showSignalMonitor })),

  setWorkspace: (workspace) => set({ workspace }),
  setPanelSize: (panel, size) =>
    set(() => {
      if (panel === 'library') return { libraryWidth: Math.min(Math.max(size, 160), 400) };
      if (panel === 'inspector') return { inspectorWidth: Math.min(Math.max(size, 220), 460) };
      return { timelineHeight: Math.min(Math.max(size, 90), 320) };
    }),
  toggleDebugOverlay: () => set((s) => ({ debugOverlay: !s.debugOverlay })),
  setShowOriginal: (show) => set({ showOriginal: show }),
  pushToast: (kind, message) =>
    set((s) => ({
      toasts: [...s.toasts.slice(-4), { id: `toast_${toastCounter++}`, kind, message }],
    })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Surface an error to the user and the console. Never silently fail. */
export function reportError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[${context}]`, err);
  useUiStore.getState().pushToast('error', `${context}: ${message}`);
}

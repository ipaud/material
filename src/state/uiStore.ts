import { create } from 'zustand';

export type WorkspaceId = 'build' | 'explore' | 'perform' | 'output';

/**
 * UI v2 renamed the workspaces. Old ids can still arrive from a stale dev
 * reload or a caller that was not updated; map them instead of rendering a
 * blank shell. Techniques and Modulation are sections of BUILD now.
 */
const LEGACY_WORKSPACES: Record<string, WorkspaceId> = {
  create: 'build',
  techniques: 'build',
  modulation: 'build',
  performance: 'perform',
};

const WORKSPACES: readonly WorkspaceId[] = ['build', 'explore', 'perform', 'output'];

export function normalizeWorkspace(id: string): WorkspaceId {
  if ((WORKSPACES as readonly string[]).includes(id)) return id as WorkspaceId;
  return LEGACY_WORKSPACES[id] ?? 'build';
}

export interface AppToast {
  id: string;
  kind: 'error' | 'info';
  message: string;
}

interface UiStore {
  workspace: WorkspaceId;
  /** BUILD: the technique browser overlay (it is no longer a workspace). */
  techniquesOpen: boolean;
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
  /** Performance workspace: minimal HUD (Tab). */
  perfHud: boolean;
  showShortcuts: boolean;
  /** Performance morph target look id (M key / MORPH button). */
  perfMorphTargetId: string | null;
  perfMorphDuration: '1beat' | '2beats' | '1bar' | '2bars' | '4bars';

  setWorkspace: (workspace: WorkspaceId | string) => void;
  toggleTechniques: () => void;
  toggleDebugOverlay: () => void;
  setShowOriginal: (show: boolean) => void;
  pushToast: (kind: AppToast['kind'], message: string) => void;
  dismissToast: (id: string) => void;
  setPanelSize: (panel: 'library' | 'inspector' | 'timeline', size: number) => void;
  setOfflineSources: (ids: string[]) => void;
  toggleBeatGrid: () => void;
  toggleSignalMonitor: () => void;
  togglePerfHud: () => void;
  toggleShortcuts: () => void;
  setPerfMorphTarget: (id: string | null) => void;
  setPerfMorphDuration: (d: UiStore['perfMorphDuration']) => void;
}

/** Compact waveform band: toolbar + track, nothing wasted. */
export const TIMELINE_MIN_HEIGHT = 64;

let toastCounter = 0;

export const useUiStore = create<UiStore>((set) => ({
  workspace: 'build',
  techniquesOpen: false,
  debugOverlay: false,
  showOriginal: false,
  toasts: [],
  libraryWidth: 220,
  inspectorWidth: 280,
  timelineHeight: 96,
  offlineSources: [],
  showBeatGrid: true,
  showSignalMonitor: false,
  perfHud: false,
  showShortcuts: false,
  perfMorphTargetId: null,
  perfMorphDuration: '1bar',
  togglePerfHud: () => set((s) => ({ perfHud: !s.perfHud })),
  toggleShortcuts: () => set((s) => ({ showShortcuts: !s.showShortcuts })),
  setPerfMorphTarget: (id) => set({ perfMorphTargetId: id }),
  setPerfMorphDuration: (d) => set({ perfMorphDuration: d }),
  setOfflineSources: (ids) => set({ offlineSources: ids }),
  toggleBeatGrid: () => set((s) => ({ showBeatGrid: !s.showBeatGrid })),
  toggleSignalMonitor: () => set((s) => ({ showSignalMonitor: !s.showSignalMonitor })),

  setWorkspace: (workspace) => set({ workspace: normalizeWorkspace(workspace) }),
  toggleTechniques: () => set((s) => ({ techniquesOpen: !s.techniquesOpen })),
  setPanelSize: (panel, size) =>
    set(() => {
      if (panel === 'library') return { libraryWidth: Math.min(Math.max(size, 160), 400) };
      if (panel === 'inspector') return { inspectorWidth: Math.min(Math.max(size, 220), 460) };
      return { timelineHeight: Math.min(Math.max(size, TIMELINE_MIN_HEIGHT), 320) };
    }),
  toggleDebugOverlay: () => set((s) => ({ debugOverlay: !s.debugOverlay })),
  setShowOriginal: (show) => set({ showOriginal: show }),
  pushToast: (kind, message) =>
    set((s) => {
      // Repeating the same message (a knob hitting a frozen target, say)
      // should not build a wall of identical cards over the controls.
      const withoutDuplicate = s.toasts.filter((t) => t.message !== message);
      return {
        toasts: [...withoutDuplicate.slice(-2), { id: `toast_${toastCounter++}`, kind, message }],
      };
    }),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Surface an error to the user and the console. Never silently fail. */
export function reportError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[${context}]`, err);
  useUiStore.getState().pushToast('error', `${context}: ${message}`);
}

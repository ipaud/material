import { create } from 'zustand';

type ExportPhase = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

interface ExportStore {
  dialogOpen: boolean;
  phase: ExportPhase;
  progress: number;
  totalFrames: number;
  message: string | null;
  cancelRequested: boolean;

  openDialog: () => void;
  closeDialog: () => void;
  begin: (totalFrames: number) => void;
  setProgress: (progress: number) => void;
  requestCancel: () => void;
  finish: (phase: Exclude<ExportPhase, 'idle' | 'running'>, message?: string) => void;
}

export const useExportStore = create<ExportStore>((set) => ({
  dialogOpen: false,
  phase: 'idle',
  progress: 0,
  totalFrames: 0,
  message: null,
  cancelRequested: false,

  openDialog: () => set({ dialogOpen: true, phase: 'idle', message: null, progress: 0 }),
  closeDialog: () => set({ dialogOpen: false }),
  begin: (totalFrames) =>
    set({ phase: 'running', progress: 0, totalFrames, message: null, cancelRequested: false }),
  setProgress: (progress) => set({ progress }),
  requestCancel: () => set({ cancelRequested: true }),
  finish: (phase, message) => set({ phase, message: message ?? null }),
}));

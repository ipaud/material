import { create } from 'zustand';
import type { OutputWindowStatus } from '@shared/outputChannel';

interface OutputStore {
  status: OutputWindowStatus;
  setStatus: (status: OutputWindowStatus) => void;
}

/** Editor-side mirror of the output window's lifecycle (main owns the window). */
export const useOutputStore = create<OutputStore>((set) => ({
  status: 'closed',
  setStatus: (status) => set({ status }),
}));

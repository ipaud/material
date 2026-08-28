import { create } from 'zustand';
import {
  CLOSED_OUTPUT_STATUS,
  type DisplayInfo,
  type OutputDisplayStatus,
  type OutputMode,
} from '@shared/display';

/**
 * Editor-side mirror of the output window (main owns the native window).
 *
 * Status is never inferred from what the user clicked — every value here
 * comes from a main-process report, so a native operation that fails cannot
 * leave the UI claiming LIVE.
 */
interface OutputStore {
  status: OutputDisplayStatus;
  displays: DisplayInfo[];
  /** Selected target; may differ from `status.displayId` while closed. */
  targetDisplayId: number | null;
  mode: OutputMode;

  setStatus: (status: OutputDisplayStatus) => void;
  setDisplays: (displays: DisplayInfo[]) => void;
  refreshDisplays: () => Promise<void>;
  selectDisplay: (displayId: number) => Promise<void>;
  selectMode: (mode: OutputMode) => Promise<void>;
  openDisplay: () => Promise<void>;
}

export const useOutputStore = create<OutputStore>((set, get) => ({
  status: CLOSED_OUTPUT_STATUS,
  displays: [],
  targetDisplayId: null,
  mode: 'fullscreen',

  setStatus: (status) => set({ status }),
  setDisplays: (displays) =>
    set((s) => ({
      displays,
      // A remembered target that has been unplugged falls back to whatever
      // is still connected rather than leaving an unselectable id.
      targetDisplayId:
        s.targetDisplayId !== null && displays.some((d) => d.id === s.targetDisplayId)
          ? s.targetDisplayId
          : (displays[0]?.id ?? null),
    })),

  refreshDisplays: async () => {
    const [displays, target] = await Promise.all([
      window.material.outputDisplays(),
      window.material.outputTarget(),
    ]);
    get().setDisplays(displays);
    set((s) => ({
      mode: target.mode,
      targetDisplayId:
        target.displayId !== null && displays.some((d) => d.id === target.displayId)
          ? target.displayId
          : s.targetDisplayId,
    }));
  },

  selectDisplay: async (displayId) => {
    set({ targetDisplayId: displayId });
    // Moves the existing window when open; only remembers the choice when not.
    await window.material.outputMove(displayId, get().mode);
  },

  selectMode: async (mode) => {
    set({ mode });
    await window.material.outputSetMode(mode);
  },

  openDisplay: async () => {
    const { targetDisplayId, mode } = get();
    await window.material.outputOpen({ displayId: targetDisplayId, mode });
  },
}));

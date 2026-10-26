import { create } from 'zustand';
import type { ExploreMutationMode, Variation } from '@/explore/exploration';
import { useProjectStore } from '@/state/projectStore';

const HISTORY_LIMIT = 8;

interface ExploreGeneration {
  populationSeed: number;
  variations: Variation[];
  thumbnails: Record<number, string>;
  selectedSeed: number | null;
  progress: number;
}

interface ExploreStore {
  variations: Variation[];
  thumbnails: Record<number, string>; // seed → dataURL
  selectedSeed: number | null;
  populationSeed: number | null;
  count: number;
  generating: boolean;
  progress: number;
  mode: ExploreMutationMode;
  history: ExploreGeneration[];

  setCount: (count: number) => void;
  startGeneration: (populationSeed: number, variations: Variation[]) => void;
  setThumbnail: (seed: number, dataUrl: string) => void;
  setProgress: (progress: number) => void;
  setMode: (mode: ExploreMutationMode) => void;
  finishGeneration: () => void;
  goBack: () => void;
  select: (seed: number | null) => void;
  clear: () => void;
}

export const useExploreStore = create<ExploreStore>((set) => ({
  variations: [],
  thumbnails: {},
  selectedSeed: null,
  populationSeed: null,
  count: 12,
  generating: false,
  progress: 0,
  mode: 'variation',
  history: [],

  setCount: (count) => set({ count }),
  startGeneration: (populationSeed, variations) =>
    set((state) => ({
      populationSeed,
      variations,
      thumbnails: {},
      generating: true,
      progress: 0,
      selectedSeed: null,
      history: state.populationSeed === null || state.variations.length === 0
        ? state.history
        : [...state.history.slice(-(HISTORY_LIMIT - 1)), {
            populationSeed: state.populationSeed,
            variations: state.variations,
            thumbnails: state.thumbnails,
            selectedSeed: state.selectedSeed,
            progress: state.progress,
          }],
    })),
  setThumbnail: (seed, dataUrl) =>
    set((s) => ({ thumbnails: { ...s.thumbnails, [seed]: dataUrl } })),
  setProgress: (progress) => set({ progress }),
  setMode: (mode) => set({ mode }),
  finishGeneration: () => set({ generating: false }),
  goBack: () => set((state) => {
    const previous = state.history[state.history.length - 1];
    if (!previous) return state;
    return {
      ...previous,
      history: state.history.slice(0, -1),
      generating: false,
      progress: previous.progress,
    };
  }),
  select: (seed) => set({ selectedSeed: seed }),
  clear: () =>
    set({ variations: [], thumbnails: {}, selectedSeed: null, populationSeed: null, generating: false, progress: 0, history: [] }),
}));

let projectGeneration = useProjectStore.getState().projectGeneration;
useProjectStore.subscribe((state) => {
  if (state.projectGeneration === projectGeneration) return;
  projectGeneration = state.projectGeneration;
  useExploreStore.getState().clear();
});

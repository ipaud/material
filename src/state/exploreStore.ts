import { create } from 'zustand';
import type { Variation } from '@/explore/exploration';

interface ExploreStore {
  variations: Variation[];
  thumbnails: Record<number, string>; // seed → dataURL
  selectedSeed: number | null;
  populationSeed: number | null;
  count: number;
  generating: boolean;
  progress: number;

  setCount: (count: number) => void;
  startGeneration: (populationSeed: number, variations: Variation[]) => void;
  setThumbnail: (seed: number, dataUrl: string) => void;
  setProgress: (progress: number) => void;
  finishGeneration: () => void;
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

  setCount: (count) => set({ count }),
  startGeneration: (populationSeed, variations) =>
    set({ populationSeed, variations, thumbnails: {}, generating: true, progress: 0, selectedSeed: null }),
  setThumbnail: (seed, dataUrl) =>
    set((s) => ({ thumbnails: { ...s.thumbnails, [seed]: dataUrl } })),
  setProgress: (progress) => set({ progress }),
  finishGeneration: () => set({ generating: false }),
  select: (seed) => set({ selectedSeed: seed }),
  clear: () =>
    set({ variations: [], thumbnails: {}, selectedSeed: null, populationSeed: null, generating: false, progress: 0 }),
}));

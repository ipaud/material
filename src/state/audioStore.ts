import { create } from 'zustand';
import type { AudioAnalysis } from '@/audio/analysis';

interface AudioStore {
  /** Path of the loaded audio source (null = none). */
  path: string | null;
  loading: boolean;
  analysis: AudioAnalysis | null;
  /** Interleaved min/max peak pairs for the waveform. */
  peaks: Float32Array | null;
  durationSec: number;

  setLoading: (path: string) => void;
  setLoaded: (path: string, analysis: AudioAnalysis, peaks: Float32Array, durationSec: number) => void;
  clear: () => void;
}

export const useAudioStore = create<AudioStore>((set) => ({
  path: null,
  loading: false,
  analysis: null,
  peaks: null,
  durationSec: 0,

  setLoading: (path) => set({ path, loading: true, analysis: null, peaks: null }),
  setLoaded: (path, analysis, peaks, durationSec) =>
    set({ path, loading: false, analysis, peaks, durationSec }),
  clear: () => set({ path: null, loading: false, analysis: null, peaks: null, durationSec: 0 }),
}));

import { create } from 'zustand';

/**
 * Coarse playback state for UI. The authoritative clock lives in
 * PlaybackController (outside React); timeSec here updates at UI rate only.
 */
interface PlaybackStore {
  playing: boolean;
  timeSec: number;
  durationSec: number;
  loop: boolean;

  setPlaying: (playing: boolean) => void;
  setTime: (timeSec: number) => void;
  setDuration: (durationSec: number) => void;
  setLoop: (loop: boolean) => void;
}

export const usePlaybackStore = create<PlaybackStore>((set) => ({
  playing: false,
  timeSec: 0,
  durationSec: 0,
  loop: true,

  setPlaying: (playing) => set({ playing }),
  setTime: (timeSec) => set({ timeSec }),
  setDuration: (durationSec) => set({ durationSec }),
  setLoop: (loop) => set({ loop }),
}));

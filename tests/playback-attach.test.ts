import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { playback } from '@/playback/PlaybackController';
import { usePlaybackStore } from '@/state/playbackStore';

/** Just enough of an HTMLVideoElement for the transport. */
function fakeVideo() {
  return {
    loop: true,
    duration: 200,
    currentTime: 0,
    paused: true,
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
  } as unknown as HTMLVideoElement & { play: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.stubGlobal('material', { setLiveness: vi.fn(async () => undefined) });
  playback.detachVideo();
});

afterEach(() => {
  playback.pause();
  playback.detachVideo();
  vi.unstubAllGlobals();
});

describe('a video attached while the transport runs', () => {
  it('starts playing, instead of leaving the clock frozen on a paused element', () => {
    // A Recipe auto-plays on the internal clock; opening a project with a video
    // then attached that video paused, and the time stood still while the
    // transport still showed "playing" (found recording the tutorial on 0.9.4).
    playback.play();
    expect(usePlaybackStore.getState().playing).toBe(true);
    const video = fakeVideo();

    playback.attachVideo(video);

    expect(video.play).toHaveBeenCalledOnce();
  });

  it('stays paused when the transport is stopped', () => {
    const video = fakeVideo();
    playback.attachVideo(video);
    expect(video.play).not.toHaveBeenCalled();
  });
});

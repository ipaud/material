import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Playback from '@/playback/PlaybackController';
import type * as PlaybackStore from '@/state/playbackStore';
import type * as UiStore from '@/state/uiStore';

/**
 * The single transport clock: who is master (audio, then video, then a wall clock for generator-only
 * projects), how video is slaved to audio, what a seek resets, what ends or loops playback, and how
 * the clock interacts with recording and export. Frames are stepped by hand.
 */

const h = vi.hoisted(() => ({
  audio: {
    isLoaded: false,
    playing: false,
    time: 0,
    duration: 0,
    getTime() {
      return h.audio.time;
    },
    play: vi.fn(() => {
      h.audio.playing = true;
    }),
    pause: vi.fn(() => {
      h.audio.playing = false;
    }),
    seek: vi.fn((t: number) => {
      h.audio.time = t;
    }),
  },
  engine: { setTime: vi.fn(), invalidate: vi.fn(), resetTemporal: vi.fn(), resetFlowPairEverywhere: vi.fn() },
  recorder: { armed: false, recording: false, tick: vi.fn() },
  player: { tick: vi.fn(), seek: vi.fn() },
  takeActions: { beginRecording: vi.fn(), stopRecording: vi.fn() },
  exporting: false,
  resetTriggers: vi.fn(),
  frames: [] as FrameRequestCallback[],
  now: 0,
}));

vi.mock('@/audio/AudioEngine', () => ({ audioEngine: h.audio }));
vi.mock('@/rendering/RenderEngine', () => ({ engine: h.engine }));
vi.mock('@/export/exportGuard', () => ({ isExporting: () => h.exporting }));
vi.mock('@/signals/triggerRuntime', () => ({ resetTriggers: h.resetTriggers, tickTriggers: vi.fn() }));
vi.mock('@/performance/morphRuntime', () => ({ morphRuntime: { tick: vi.fn() } }));
vi.mock('@/runtime/RuntimeBus', () => ({ runtimeBus: { emitTransport: vi.fn() } }));
vi.mock('@/performance/take/recorder', () => ({ takeRecorder: h.recorder }));
vi.mock('@/performance/take/player', () => ({ takePlayer: h.player }));
vi.mock('@/performance/take/takeActions', () => h.takeActions);

let playback: typeof Playback.playback;
let store: typeof PlaybackStore.usePlaybackStore;
let ui: typeof UiStore.useUiStore;
const setLiveness = vi.fn(async () => true);

/** Advance wall time and run one animation frame. */
function frame(ms = 120) {
  h.now += ms;
  const pending = h.frames.splice(0);
  for (const cb of pending) cb(h.now);
}

function fakeVideo(duration = 10) {
  return {
    loop: true,
    duration,
    currentTime: 0,
    paused: true,
    ended: false,
    play: vi.fn(async function (this: { paused: boolean }) {
      this.paused = false;
    }),
    pause: vi.fn(function (this: { paused: boolean }) {
      this.paused = true;
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

beforeEach(async () => {
  Object.assign(h.audio, { isLoaded: false, playing: false, time: 0, duration: 0 });
  Object.assign(h.recorder, { armed: false, recording: false });
  h.exporting = false;
  h.frames.length = 0;
  h.now = 1000;
  vi.stubGlobal('material', { setLiveness });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => h.frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {
    h.frames.length = 0;
  });
  vi.spyOn(performance, 'now').mockImplementation(() => h.now);
  vi.resetModules();
  playback = (await import('@/playback/PlaybackController')).playback;
  store = (await import('@/state/playbackStore')).usePlaybackStore;
  ui = (await import('@/state/uiStore')).useUiStore;
  store.setState({ playing: false, timeSec: 0, durationSec: 0, loop: false });
  ui.setState({ toasts: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('a project with no media (generators only)', () => {
  it('runs on its own clock, holds while paused and keeps the app awake only while playing', () => {
    playback.play();
    expect(store.getState().playing).toBe(true);
    frame(500);
    expect(playback.getTime()).toBeCloseTo(0.5);
    playback.pause();
    frame(2000);
    // Pausing used to snap a generator-only project back to 0 (found writing this test, 0.9.4).
    expect(playback.getTime()).toBeCloseTo(0.5);
    expect(store.getState().timeSec).toBeCloseTo(0.5);
    playback.play();
    frame(100);
    expect(playback.getTime()).toBeCloseTo(0.6);
    expect(setLiveness.mock.calls).toEqual([
      ['transport', true],
      ['transport', false],
      ['transport', true],
    ]);
  });

  it('a seek moves its clock', () => {
    store.setState({ durationSec: 0 });
    playback.play();
    playback.seek(0); // clamped to the (zero) duration
    frame(250);
    expect(playback.getTime()).toBeCloseTo(0.25);
  });
});

describe('audio is the master', () => {
  beforeEach(() => {
    Object.assign(h.audio, { isLoaded: true, duration: 20 });
    playback.refreshDuration();
  });

  it('the video starts at the audio position and is pulled back when it drifts', () => {
    const video = fakeVideo(10);
    playback.attachVideo(video as never);
    expect(video.loop).toBe(false);
    h.audio.time = 3;
    playback.play();
    expect(h.audio.play).toHaveBeenCalledOnce();
    expect(video.currentTime).toBe(3);
    expect(video.play).toHaveBeenCalled();

    video.currentTime = 3.03; // within tolerance: left alone
    frame();
    expect(video.currentTime).toBe(3.03);

    video.currentTime = 3.5; // 0.5 s off: corrected
    frame();
    expect(video.currentTime).toBe(3);
  });

  it('when the song outlives the video, the last frame is held', () => {
    const video = fakeVideo(10);
    playback.attachVideo(video as never);
    h.audio.time = 12;
    playback.play();
    expect(video.pause).toHaveBeenCalled();
    expect(video.currentTime).toBe(10);
    video.paused = false;
    frame();
    expect(video.paused).toBe(true);
    expect(playback.avDriftSec).toBe(0);
  });

  it('at the end it stops, or starts over when looping', () => {
    store.setState({ durationSec: 20 });
    playback.play();
    h.audio.time = 19.99;
    frame();
    expect(store.getState().playing).toBe(false);

    playback.setLoop(true);
    playback.play();
    h.audio.time = 19.99;
    frame();
    expect(store.getState().playing).toBe(true);
    expect(h.audio.seek).toHaveBeenLastCalledWith(0);
  });

  it('removing the video keeps the song playing', () => {
    playback.attachVideo(fakeVideo() as never);
    playback.play();
    playback.detachVideo();
    expect(store.getState().playing).toBe(true);
  });
});

describe('video only', () => {
  it('removing the only clock stops and rewinds', () => {
    const video = fakeVideo(8);
    playback.attachVideo(video as never);
    expect(store.getState().durationSec).toBe(8);
    playback.play();
    video.currentTime = 4;
    playback.detachVideo();
    expect(store.getState()).toMatchObject({ playing: false, timeSec: 0, durationSec: 0 });
  });

  it('the end of the video ends playback', () => {
    const video = fakeVideo(8);
    playback.attachVideo(video as never);
    playback.play();
    video.ended = true;
    frame();
    expect(store.getState().playing).toBe(false);
  });

  it('a duration the element cannot report counts as none', () => {
    playback.attachVideo(fakeVideo(Number.POSITIVE_INFINITY) as never);
    expect(store.getState().durationSec).toBe(0);
  });
});

describe('seeking', () => {
  beforeEach(() => {
    Object.assign(h.audio, { isLoaded: true, duration: 30 });
    playback.refreshDuration();
  });

  it('clamps to the clip and resets everything that remembers earlier frames', () => {
    const video = fakeVideo(10);
    playback.attachVideo(video as never);
    playback.seek(45);
    expect(h.audio.seek).toHaveBeenLastCalledWith(30);
    expect(video.currentTime).toBe(10);
    expect(h.engine.resetTemporal).toHaveBeenCalled();
    expect(h.engine.resetFlowPairEverywhere).toHaveBeenCalled();
    expect(h.resetTriggers).toHaveBeenCalledWith(30);
    expect(h.player.seek).toHaveBeenCalledWith(30);
    expect(store.getState().timeSec).toBe(30);
    playback.seek(-5);
    expect(store.getState().timeSec).toBe(0);
  });

  it('does nothing while an export owns the media', () => {
    h.exporting = true;
    playback.seek(5);
    expect(h.audio.seek).not.toHaveBeenCalled();
  });

  it('a seek while recording ends the take and keeps it, and says so', async () => {
    h.recorder.recording = true;
    playback.seek(5);
    await vi.waitFor(() => expect(h.takeActions.stopRecording).toHaveBeenCalled());
    expect(ui.getState().toasts.at(-1)?.message).toBe('Seek ended the recording');
  });
});

describe('recording', () => {
  it('ARM then PLAY starts recording; pausing stops it', async () => {
    h.recorder.armed = true;
    playback.play();
    await vi.waitFor(() => expect(h.takeActions.beginRecording).toHaveBeenCalled());
    h.recorder.recording = true;
    playback.pause();
    await vi.waitFor(() => expect(h.takeActions.stopRecording).toHaveBeenCalled());
  });

  it('every frame advances the recorder and the player on composition time', () => {
    playback.play();
    frame(100);
    expect(h.recorder.tick).toHaveBeenCalledWith(expect.closeTo(0.1, 5));
    expect(h.player.tick).toHaveBeenCalledWith(expect.closeTo(0.1, 5));
  });

  it('toggle flips the transport', () => {
    playback.toggle();
    expect(store.getState().playing).toBe(true);
    playback.toggle();
    expect(store.getState().playing).toBe(false);
  });
});

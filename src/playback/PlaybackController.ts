import { usePlaybackStore } from '@/state/playbackStore';
import { engine } from '@/rendering/RenderEngine';
import { audioEngine } from '@/audio/AudioEngine';
import { resetTriggers, tickTriggers } from '@/signals/triggerRuntime';
import { morphRuntime } from '@/performance/morphRuntime';

const UI_TICK_MS = 100;
/** Video is re-synced to the audio clock when drift exceeds this. */
const DRIFT_CORRECT_SEC = 0.06;

/**
 * Single authoritative playback clock (§63).
 * Master priority: audio (AudioContext clock) → video element → none.
 * Video slaves to audio: drift measured each tick, corrected via seek.
 */
class PlaybackController {
  private video: HTMLVideoElement | null = null;
  private rafId = 0;
  private lastUiPush = 0;
  /** Last measured A/V drift (seconds, video - audio) for the debug overlay. */
  avDriftSec = 0;

  private get audioMaster(): boolean {
    return audioEngine.isLoaded;
  }

  attachVideo(video: HTMLVideoElement): void {
    this.video = video;
    video.loop = false; // looping handled by the controller
    this.refreshDuration();
  }

  detachVideo(): void {
    this.video = null;
    this.avDriftSec = 0;
    if (!this.audioMaster) {
      this.pause();
      usePlaybackStore.getState().setTime(0);
    }
    this.refreshDuration();
  }

  audioChanged(): void {
    this.refreshDuration();
    if (!this.audioMaster && !this.video) this.pause();
  }

  refreshDuration(): void {
    const duration = Math.max(audioEngine.duration, this.video?.duration ?? 0);
    usePlaybackStore.getState().setDuration(Number.isFinite(duration) ? duration : 0);
  }

  get currentVideo(): HTMLVideoElement | null {
    return this.video;
  }

  getTime(): number {
    if (this.audioMaster) return audioEngine.getTime();
    return this.video?.currentTime ?? 0;
  }

  getDuration(): number {
    return usePlaybackStore.getState().durationSec;
  }

  play(): void {
    if (!this.audioMaster && !this.video) return;
    if (this.audioMaster) {
      audioEngine.play();
      if (this.video && this.video.duration > 0) {
        const t = audioEngine.getTime();
        if (t < this.video.duration) {
          this.video.currentTime = t;
          void this.video.play().catch(() => undefined);
        } else {
          // Audio outlives the video: hold the last frame.
          this.video.pause();
          this.video.currentTime = this.video.duration;
        }
      }
    } else if (this.video) {
      void this.video.play().catch(() => undefined);
    }
    usePlaybackStore.getState().setPlaying(true);
    this.startTicking();
  }

  pause(): void {
    audioEngine.pause();
    this.video?.pause();
    usePlaybackStore.getState().setPlaying(false);
    this.stopTicking();
    engine.invalidate();
  }

  toggle(): void {
    if (usePlaybackStore.getState().playing) this.pause();
    else this.play();
  }

  seek(timeSec: number): void {
    const clamped = Math.min(Math.max(timeSec, 0), this.getDuration());
    // Frames before a seek are not history for what comes after it (§13);
    // the same goes for trigger events and pending quantized actions.
    engine.resetTemporal();
    resetTriggers(clamped);
    if (this.audioMaster) audioEngine.seek(clamped);
    if (this.video) {
      this.video.currentTime = Math.min(clamped, this.video.duration || 0);
      const onSeeked = () => {
        engine.invalidate();
        this.video?.removeEventListener('seeked', onSeeked);
      };
      this.video.addEventListener('seeked', onSeeked);
    }
    usePlaybackStore.getState().setTime(clamped);
    engine.setTime(clamped);
    engine.invalidate();
  }

  setLoop(loop: boolean): void {
    usePlaybackStore.getState().setLoop(loop);
  }

  private startTicking(): void {
    if (this.rafId) return;
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      const time = this.getTime();
      engine.setTime(time); // invalidates → live texture refresh
      // Discrete trigger actions fire on composition-time crossings.
      tickTriggers(time);
      // Morph side flips + completion commit are composition-time driven too.
      morphRuntime.tick(time);

      // Slave video to the audio clock.
      if (this.audioMaster && this.video && this.video.duration > 0) {
        if (time >= this.video.duration) {
          // Past the video's end: freeze on the last frame, no restart fights.
          if (!this.video.paused) this.video.pause();
          this.avDriftSec = 0;
        } else {
          if (this.video.paused && usePlaybackStore.getState().playing) {
            void this.video.play().catch(() => undefined);
          }
          this.avDriftSec = this.video.currentTime - time;
          if (Math.abs(this.avDriftSec) > DRIFT_CORRECT_SEC) {
            this.video.currentTime = time;
          }
        }
      }

      const now = performance.now();
      if (now - this.lastUiPush > UI_TICK_MS) {
        this.lastUiPush = now;
        usePlaybackStore.getState().setTime(time);
        const { loop } = usePlaybackStore.getState();
        const duration = this.getDuration();
        const ended = this.audioMaster
          ? duration > 0 && time >= duration - 0.02
          : (this.video?.ended ?? false);
        if (ended) {
          if (loop) this.seek(0);
          else this.pause();
        }
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopTicking(): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    usePlaybackStore.getState().setTime(this.getTime());
  }
}

export const playback = new PlaybackController();

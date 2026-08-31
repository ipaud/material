import { usePlaybackStore } from '@/state/playbackStore';
import { useUiStore } from '@/state/uiStore';
import { engine } from '@/rendering/RenderEngine';
import { isExporting } from '@/export/exportGuard';
import { audioEngine } from '@/audio/AudioEngine';
import { resetTriggers, tickTriggers } from '@/signals/triggerRuntime';
import { morphRuntime } from '@/performance/morphRuntime';
import { runtimeBus } from '@/runtime/RuntimeBus';
import { takeRecorder } from '@/performance/take/recorder';
import { takePlayer } from '@/performance/take/player';

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

  /** v0.6: several layers may hold videos; only the first drives the clock. */
  get hasVideo(): boolean {
    return this.video !== null;
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

  // CE1F: a project can have NO media at all (generator sources are
  // unbounded, §50) — the transport then runs on its own wall clock so
  // composition time still advances for procedural animation, Patterns and
  // beat-driven modulation. Media, when present, remains the master.
  private clockOriginWall = 0;
  private clockOriginComp = 0;

  private get hasMediaClock(): boolean {
    return this.audioMaster || this.video !== null;
  }

  getTime(): number {
    if (this.audioMaster) return audioEngine.getTime();
    if (this.video) return this.video.currentTime;
    if (!usePlaybackStore.getState().playing) return this.clockOriginComp;
    return this.clockOriginComp + (performance.now() / 1000 - this.clockOriginWall);
  }

  getDuration(): number {
    return usePlaybackStore.getState().durationSec;
  }

  play(): void {
    // CE1F: no media is a valid project (generator sources) — run the
    // internal composition clock instead of refusing to play.
    if (!this.hasMediaClock) {
      this.clockOriginComp = usePlaybackStore.getState().timeSec;
      this.clockOriginWall = performance.now() / 1000;
      void window.material.setLiveness('transport', true).catch(() => undefined);
      usePlaybackStore.getState().setPlaying(true);
      this.beginArmedRecording();
      this.startTicking();
      runtimeBus.emitTransport('play', this.clockOriginComp);
      return;
    }
    // Keep macOS App Nap from throttling the live engine to ~1 Hz while the
    // editor window is hidden or occluded (docs/BACKGROUND_RENDERING.md).
    void window.material.setLiveness('transport', true).catch(() => undefined);
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
    this.beginArmedRecording();
    this.startTicking();
    runtimeBus.emitTransport('play', this.getTime());
  }

  /**
   * v0.7: ARM then PLAY starts the recording, so a performance can begin at
   * composition t=0 in step with the song rather than a moment after it. The
   * import is lazy for one reason only — takeActions reaches back into this
   * controller for the playhead and the loop flag, and the cycle would be
   * evaluated at module load.
   */
  private beginArmedRecording(): void {
    if (!takeRecorder.armed) return;
    void import('@/performance/take/takeActions').then((m) => m.beginRecording());
  }

  pause(): void {
    // Stopping the transport ends the take: a recording is a stretch of the
    // song, and a paused clock records nothing but a pile of events at one
    // instant.
    if (takeRecorder.recording) {
      void import('@/performance/take/takeActions').then((m) => m.stopRecording());
    }
    void window.material.setLiveness('transport', false).catch(() => undefined);
    audioEngine.pause();
    this.video?.pause();
    usePlaybackStore.getState().setPlaying(false);
    this.stopTicking();
    engine.invalidate();
    runtimeBus.emitTransport('pause', this.getTime());
  }

  toggle(): void {
    if (usePlaybackStore.getState().playing) this.pause();
    else this.play();
  }

  seek(timeSec: number): void {
    // The export owns the video element's position while it runs.
    if (isExporting()) return;
    const clamped = Math.min(Math.max(timeSec, 0), this.getDuration());
    // v0.7 §39: a seek during recording ENDS the take rather than writing
    // backwards time into a lane that has to stay monotonic. Ending and
    // keeping, not cancelling — a performer who seeks by accident should not
    // lose what they played.
    if (takeRecorder.recording) {
      void import('@/performance/take/takeActions').then((m) => {
        m.stopRecording();
        useUiStore.getState().pushToast('info', 'Seek ended the recording');
      });
    }
    // Frames before a seek are not history for what comes after it (§13);
    // the same goes for trigger events and pending quantized actions.
    engine.resetTemporal();
    engine.resetFlowPairEverywhere();
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
    if (!this.hasMediaClock) {
      this.clockOriginComp = clamped;
      this.clockOriginWall = performance.now() / 1000;
    }
    usePlaybackStore.getState().setTime(clamped);
    engine.setTime(clamped);
    // A Take is seekable by reconstruction, not by rewinding: there is no
    // previous frame for the playhead to have crossed anything from.
    takePlayer.seek(clamped);
    engine.invalidate();
    runtimeBus.emitTransport('seek', clamped);
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
      // v0.7: both halves of Performance Capture run on the same composition
      // clock as everything else. Never wall time — a Take recorded at 120Hz
      // has to replay identically at 24.
      takeRecorder.tick(time);
      takePlayer.tick(time);

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

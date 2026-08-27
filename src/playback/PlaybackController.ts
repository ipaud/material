import { usePlaybackStore } from '@/state/playbackStore';
import { engine } from '@/rendering/RenderEngine';

const UI_TICK_MS = 100;

/**
 * Single authoritative playback clock.
 * With a video source the <video> element is the master clock; the engine is
 * invalidated every animation frame while playing so VideoTexture stays live.
 * (Phase 4: an audio source becomes the master and video slaves to it.)
 */
class PlaybackController {
  private video: HTMLVideoElement | null = null;
  private rafId = 0;
  private lastUiPush = 0;

  attachVideo(video: HTMLVideoElement): void {
    this.video = video;
    usePlaybackStore.getState().setDuration(video.duration || 0);
    video.loop = usePlaybackStore.getState().loop;
  }

  detachVideo(): void {
    this.pause();
    this.video = null;
    usePlaybackStore.getState().setDuration(0);
    usePlaybackStore.getState().setTime(0);
  }

  get currentVideo(): HTMLVideoElement | null {
    return this.video;
  }

  getTime(): number {
    return this.video?.currentTime ?? 0;
  }

  getDuration(): number {
    return this.video?.duration ?? 0;
  }

  play(): void {
    if (!this.video) return;
    void this.video.play().catch(() => {
      /* interrupted by pause — harmless */
    });
    usePlaybackStore.getState().setPlaying(true);
    this.startTicking();
  }

  pause(): void {
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
    if (!this.video) return;
    const clamped = Math.min(Math.max(timeSec, 0), this.video.duration || 0);
    this.video.currentTime = clamped;
    usePlaybackStore.getState().setTime(clamped);
    // Repaint once the seeked frame is decoded.
    const onSeeked = () => {
      engine.invalidate();
      this.video?.removeEventListener('seeked', onSeeked);
    };
    this.video.addEventListener('seeked', onSeeked);
    engine.invalidate();
  }

  setLoop(loop: boolean): void {
    usePlaybackStore.getState().setLoop(loop);
    if (this.video) this.video.loop = loop;
  }

  private startTicking(): void {
    if (this.rafId) return;
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      engine.setTime(this.getTime()); // also invalidates → VideoTexture refresh
      const now = performance.now();
      if (now - this.lastUiPush > UI_TICK_MS) {
        this.lastUiPush = now;
        usePlaybackStore.getState().setTime(this.getTime());
        if (this.video?.ended && !this.video.loop) {
          this.pause();
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

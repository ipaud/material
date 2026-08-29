import * as THREE from 'three';
import type {
  LiveSourceRuntime,
  SourceCapabilities,
  SourceRuntimeStatus,
} from './SourceRuntime';
import type { TemporalSource } from '@/rendering/temporal/TemporalFrameProvider';

const CAPS: SourceCapabilities = {
  seekable: false,
  duration: null,
  deterministic: false,
  exportable: false,
  // 18E: current frame only — realtime history accumulation is 18F.
  temporalHistory: 'realtime',
  audio: false,
};

/**
 * Screen / window capture source (Phase 18E) — the second LiveSourceRuntime.
 *
 * One class for both kinds: after the main process resolves WHICH display or
 * window is being captured (the display-media request handler), the renderer
 * lifecycle is byte-identical — own the MediaStream, feed a muted off-DOM
 * video element, expose a VideoTexture, current frame only. The `kind` keeps
 * the semantics visible at the API level.
 *
 * `connect()` is the ONLY editor-side getDisplayMedia call site, and it never
 * resolves without explicit user intent: the caller (captureManager) arms the
 * main-process gate with the exact target first — there is no picker in the
 * renderer, and a saved screen/window project sits IDLE forever until START.
 *
 * Capture is live: free-running element, transport never pauses/seeks it,
 * pixels are always "now". A window resize simply changes videoWidth/Height —
 * the getters below read the element live, so metadata follows.
 */
export class DisplayCaptureSource implements LiveSourceRuntime {
  readonly caps = CAPS;
  status: SourceRuntimeStatus = 'offline';

  private stream: MediaStream | null = null;
  private video: HTMLVideoElement;
  private tex: THREE.VideoTexture | null = null;
  private disposed = false;
  private listeners = new Set<(status: SourceRuntimeStatus) => void>();

  constructor(readonly kind: 'live-screen' | 'live-window') {
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    this.video = video;
  }

  get width(): number | null {
    return this.tex ? this.video.videoWidth : null;
  }
  get height(): number | null {
    return this.tex ? this.video.videoHeight : null;
  }

  /** Negotiated frame rate, for status UI — null until live. */
  get frameRate(): number | null {
    const track = this.stream?.getVideoTracks()[0];
    const fps = track?.getSettings().frameRate;
    return typeof fps === 'number' ? Math.round(fps) : null;
  }

  private setStatus(status: SourceRuntimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }

  onStatus(listener: (status: SourceRuntimeStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Acquire the capture. No constraints beyond video-only: the main-process
   * handler already decided the exact source, and format negotiation belongs
   * to the platform (§50 — report actual fps, don't force 60).
   */
  async connect(): Promise<void> {
    if (this.disposed) return;
    this.setStatus('connecting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (err) {
      const name = (err as DOMException)?.name;
      const message = (err as DOMException)?.message ?? '';
      // NotAllowedError: denied TCC state or disarmed gate. On macOS, a
      // handler-granted source that the OS refuses to open (Screen Recording
      // permission missing) surfaces as OverconstrainedError / "Invalid
      // capture constraints" — measured in the packaged 18E QA. Both mean
      // the same thing to the user: grant access in System Settings.
      this.setStatus(
        name === 'NotAllowedError' ||
          name === 'OverconstrainedError' ||
          message.includes('Invalid capture constraints')
          ? 'permission-denied'
          : name === 'NotFoundError'
            ? 'device-lost'
            : 'error',
      );
      throw err;
    }
    if (this.disposed) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    this.stream = stream;
    this.video.srcObject = stream;

    await new Promise<void>((resolve, reject) => {
      const onPlaying = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('capture element failed'));
      };
      const cleanup = () => {
        this.video.removeEventListener('playing', onPlaying);
        this.video.removeEventListener('error', onError);
      };
      if (this.video.readyState >= 2 && this.video.videoWidth > 0) {
        resolve();
        return;
      }
      this.video.addEventListener('playing', onPlaying);
      this.video.addEventListener('error', onError);
      void this.video.play().catch(() => undefined);
    });
    if (this.disposed) {
      this.teardownStream();
      return;
    }

    // Same texture semantics as Camera/FileVideo — capture kinds must not
    // introduce color drift (§20).
    const texture = new THREE.VideoTexture(this.video);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.tex = texture;

    // Captured window closed / display unplugged / OS revoked: one clean
    // transition. Never auto-recapture something else (§28/§29).
    const track = stream.getVideoTracks()[0];
    if (track) {
      track.onended = () => {
        if (!this.disposed) this.setStatus('device-lost');
      };
    }
    this.setStatus('live');
  }

  texture(): THREE.Texture | null {
    return this.status === 'live' ? this.tex : null;
  }

  /** 18E: current frame only — realtime history is 18F. */
  temporalSource(): TemporalSource | null {
    return null;
  }

  private teardownStream(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.video.pause();
    this.video.srcObject = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardownStream();
    this.tex?.dispose();
    this.tex = null;
    this.listeners.clear();
    this.setStatus = () => undefined;
    this.status = 'offline';
  }
}

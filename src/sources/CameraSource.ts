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
  // 18D: current frame only. Realtime history accumulation is 18F — until
  // then temporal techniques are honestly gated in the UI.
  temporalHistory: 'realtime',
  audio: false,
};

/**
 * Live camera source (Phase 18D) — the first LiveSourceRuntime.
 *
 * Owns the MediaStream, its tracks, a muted off-DOM video element and the
 * VideoTexture. `connect()` is the ONLY place that touches getUserMedia, and
 * it never runs without explicit user intent: the caller (cameraManager)
 * arms the main-process permission gate first, so a saved camera project can
 * sit in a project forever without a single permission prompt.
 *
 * The camera is live: the element free-runs (autoplay), the transport never
 * pauses or seeks it, and PlaybackController never attaches it. Pixels are
 * always "now"; composition time drives modulation, not this sensor.
 */
export class CameraSource implements LiveSourceRuntime {
  readonly kind = 'live-camera' as const;
  readonly caps = CAPS;
  status: SourceRuntimeStatus = 'offline';

  private stream: MediaStream | null = null;
  private video: HTMLVideoElement;
  private tex: THREE.VideoTexture | null = null;
  private disposed = false;
  private listeners = new Set<(status: SourceRuntimeStatus) => void>();

  constructor(readonly deviceId: string | null) {
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

  /** The device actually in use (may differ from the requested preference). */
  get activeDeviceId(): string | null {
    return this.stream?.getVideoTracks()[0]?.getSettings().deviceId ?? null;
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
   * Acquire the stream. Conservative constraints: prefer the remembered
   * device but let the browser negotiate format — forcing 4K/60 on hardware
   * that cannot deliver it fails noisily for nothing.
   */
  async connect(): Promise<void> {
    if (this.disposed) return;
    this.setStatus('connecting');
    let stream: MediaStream;
    try {
      const constraints: MediaStreamConstraints = {
        video: this.deviceId ? { deviceId: { exact: this.deviceId } } : true,
        audio: false,
      };
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        // The remembered device may be gone (ids are best-effort): fall back
        // to the default camera rather than failing the project.
        if (this.deviceId && (err as DOMException)?.name === 'OverconstrainedError') {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        } else {
          throw err;
        }
      }
    } catch (err) {
      const name = (err as DOMException)?.name;
      this.setStatus(
        name === 'NotAllowedError'
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

    // Not ready until the element has real dimensions and is delivering
    // frames — a 0×0 texture must never reach the engine.
    await new Promise<void>((resolve, reject) => {
      const onPlaying = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('camera element failed'));
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

    // Same texture semantics as FileVideoSource — camera and file video must
    // not diverge in color.
    const texture = new THREE.VideoTexture(this.video);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.tex = texture;

    // Unplug / OS revoke: one clean transition, no error spam.
    const track = stream.getVideoTracks()[0];
    if (track) {
      track.onended = () => {
        if (!this.disposed) this.setStatus('device-lost');
      };
    }
    this.watchFrames();
    this.setStatus('live');
  }


  /** 18F diagnostics: source-frame freshness via requestVideoFrameCallback.
   * Dev/QA only — proves history advances at SOURCE cadence, never render
   * cadence. Never persisted, never gates behavior. */
  private sourceFrames = 0;
  private lastMediaTime = 0;
  private rvfcHandle: number | null = null;

  private watchFrames(): void {
    const video = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
    };
    if (typeof video.requestVideoFrameCallback !== 'function') return;
    const tick = (_now: number, meta: { mediaTime: number }) => {
      this.sourceFrames++;
      this.lastMediaTime = meta.mediaTime;
      if (!this.disposed) this.rvfcHandle = video.requestVideoFrameCallback!(tick);
    };
    this.rvfcHandle = video.requestVideoFrameCallback(tick);
  }

  frameInfo(): { frameId: number; mediaTime: number } {
    return { frameId: this.sourceFrames, mediaTime: this.lastMediaTime };
  }

  texture(): THREE.Texture | null {
    return this.status === 'live' ? this.tex : null;
  }

  /** 18D: current frame only — realtime history is 18F. */
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

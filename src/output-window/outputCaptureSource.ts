import * as THREE from 'three';

/**
 * Replica-side screen/window capture surface (18E fan-out).
 *
 * ADR: like camera streams, display-capture MediaStreams cannot cross
 * renderer processes, and pixel transport is prohibited. The mechanism is a
 * SILENT REJOIN: this getDisplayMedia call carries no target — the
 * main-process display-media request handler recognizes the Output frame and
 * grants exactly the source the EDITOR was granted (its `grantedCapture`
 * record), or denies. There is no picker anywhere in this window, no
 * enumeration, no retry loop, and a stale handle cannot reacquire: STOP,
 * source switch and project switch all revoke the grant in main.
 */
export class OutputCaptureSource {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement;
  private tex: THREE.VideoTexture | null = null;
  private disposed = false;

  constructor() {
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    this.video = video;
  }

  async load(): Promise<void> {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    if (this.disposed) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.stream = stream;
    this.video.srcObject = stream;
    await new Promise<void>((resolve, reject) => {
      const onPlaying = () => resolve();
      const onError = () => reject(new Error('capture element failed'));
      if (this.video.readyState >= 2 && this.video.videoWidth > 0) {
        resolve();
        return;
      }
      this.video.addEventListener('playing', onPlaying, { once: true });
      this.video.addEventListener('error', onError, { once: true });
      void this.video.play().catch(() => undefined);
    });
    if (this.disposed) {
      this.teardown();
      return;
    }
    const texture = new THREE.VideoTexture(this.video);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.tex = texture;
  }

  texture(): THREE.Texture | null {
    return this.tex;
  }

  private teardown(): void {
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
    this.teardown();
    this.tex?.dispose();
    this.tex = null;
  }
}

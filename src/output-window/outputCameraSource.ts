import * as THREE from 'three';

/**
 * Replica-side camera surface (18D fan-out).
 *
 * ADR: MediaStreams cannot cross renderer processes (MessagePort transfer of
 * a MediaStreamTrack throws DataCloneError — measured), and pixel transport
 * is prohibited. The mechanism is SAME-DEVICE DUAL ACQUISITION: the replica
 * asks Chromium for the device named in the authority's RenderInputs
 * descriptor, and Chromium's capture service fans the one physical capture
 * out to both renderers (measured: editor cold acquisition 844ms, replica
 * join 21ms, both delivered at 30fps, one camera indicator).
 *
 * The replica can never INITIATE capture: the main-process permission gate
 * only grants video capture while the editor's user-armed camera intent is
 * active. No descriptor → no request; intent disarmed → NotAllowedError.
 * There is no UI here, no enumeration, no retry loop.
 */
export class OutputCameraSource {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement;
  private tex: THREE.VideoTexture | null = null;
  private disposed = false;

  constructor(readonly deviceId: string | null) {
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    this.video = video;
  }

  async load(): Promise<void> {
    const constraints: MediaStreamConstraints = {
      video: this.deviceId ? { deviceId: { exact: this.deviceId } } : true,
      audio: false,
    };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (this.deviceId && (err as DOMException)?.name === 'OverconstrainedError') {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } else {
        throw err;
      }
    }
    if (this.disposed) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.stream = stream;
    this.video.srcObject = stream;
    await new Promise<void>((resolve, reject) => {
      const onPlaying = () => resolve();
      const onError = () => reject(new Error('camera element failed'));
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

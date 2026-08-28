import * as THREE from 'three';
import { VideoTemporalSource } from '@/rendering/temporal/sources';
import type { TemporalSource } from '@/rendering/temporal/TemporalFrameProvider';
import {
  mediaUrl,
  type SourceCapabilities,
  type SourceRuntime,
  type SourceRuntimeStatus,
} from './SourceRuntime';

const CAPS: SourceCapabilities = {
  seekable: true,
  duration: null, // known after load; caps.duration stays the static promise
  deterministic: true,
  exportable: true,
  temporalHistory: 'exact',
  audio: true,
};

/**
 * File video source. Extracted from engineBridge (18A): same element setup,
 * same VideoTexture parameters, same error split (decode failure vs missing
 * file via main-process probe).
 *
 * The video ELEMENT stays exposed: the editor's PlaybackController attaches
 * it as the (video-)clock slave. A future Output replica creates its own
 * FileVideoSource and slaves it to ClockSync instead — the element never
 * crosses process boundaries.
 */
export class FileVideoSource implements SourceRuntime {
  readonly kind = 'file-video' as const;
  readonly caps = CAPS;
  status: SourceRuntimeStatus = 'offline';
  readonly video: HTMLVideoElement;

  private tex: THREE.VideoTexture | null = null;
  private temporal: VideoTemporalSource | null = null;
  private disposed = false;

  constructor(readonly path: string) {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    this.video = video;
  }

  get width(): number | null {
    return this.tex ? this.video.videoWidth : null;
  }
  get height(): number | null {
    return this.tex ? this.video.videoHeight : null;
  }

  get durationSec(): number | null {
    const d = this.video.duration;
    return Number.isFinite(d) && d > 0 ? d : null;
  }

  load(): Promise<void> {
    this.status = 'connecting';
    return new Promise((resolve, reject) => {
      this.video.addEventListener('loadedmetadata', () => {
        if (this.disposed) return;
        const texture = new THREE.VideoTexture(this.video);
        texture.colorSpace = THREE.SRGBColorSpace;
        this.tex = texture;
        this.temporal = new VideoTemporalSource(this.video, texture);
        this.status = 'live';
        resolve();
      });
      this.video.addEventListener('error', () => {
        if (this.disposed) return;
        // A moved or deleted file fails exactly like an unplayable one. Ask
        // the filesystem which it is before blaming the codec — "unsupported
        // codec?" on a file the user simply moved sends them hunting for the
        // wrong problem.
        const fileName = this.path.split('/').pop() ?? this.path;
        void window.material
          .probeMedia(this.path)
          .then(() => {
            this.status = 'error';
            reject(new Error(`Could not decode ${fileName} (unsupported codec?)`));
          })
          .catch(() => {
            this.status = 'offline';
            reject(new Error(`${fileName} is missing — relink it from the Library`));
          });
      });
      this.video.src = mediaUrl(this.path);
    });
  }

  texture(): THREE.Texture | null {
    return this.tex;
  }

  temporalSource(): TemporalSource | null {
    return this.temporal;
  }

  dispose(): void {
    this.disposed = true;
    this.video.removeAttribute('src');
    this.video.load();
    this.tex = null;
    this.temporal = null;
    this.status = 'offline';
  }
}

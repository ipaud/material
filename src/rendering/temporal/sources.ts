import type * as THREE from 'three';
import type { TemporalSource } from './TemporalFrameProvider';

/** Still image / no time dimension: every requested time yields the same frame. */
export class StaticTemporalSource implements TemporalSource {
  readonly isStatic = true;
  readonly startSec = 0;
  readonly endSec = 0;

  constructor(private readonly texture: THREE.Texture | null) {}

  currentTexture(): THREE.Texture | null {
    return this.texture;
  }

  async acquireAt(): Promise<THREE.Texture | null> {
    return this.texture;
  }
}

const SEEK_EPSILON = 0.0005;
const SEEK_TIMEOUT_MS = 4000;

/**
 * Video-backed temporal source. Preview reads the live VideoTexture; export
 * seeks the element to exact timestamps and waits for the decoded frame.
 *
 * Frame identity is the seeked `currentTime`, so two exports of the same range
 * request byte-identical timestamps.
 */
export class VideoTemporalSource implements TemporalSource {
  readonly isStatic = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly texture: THREE.Texture,
  ) {}

  get startSec(): number {
    return 0;
  }

  get endSec(): number {
    const d = this.video.duration;
    return Number.isFinite(d) && d > 0 ? d : 0;
  }

  currentTexture(): THREE.Texture | null {
    return this.texture;
  }

  async acquireAt(timeSec: number): Promise<THREE.Texture | null> {
    const target = Math.min(Math.max(timeSec, 0), Math.max(this.endSec - 0.001, 0));
    if (Math.abs(this.video.currentTime - target) < SEEK_EPSILON) {
      this.texture.needsUpdate = true;
      return this.texture;
    }
    await this.seek(target);
    this.texture.needsUpdate = true;
    return this.texture;
  }

  private seek(target: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        this.video.removeEventListener('seeked', done);
        clearTimeout(timer);
        resolve();
      };
      // A stalled decoder must not hang an entire export.
      const timer = setTimeout(done, SEEK_TIMEOUT_MS);
      this.video.addEventListener('seeked', done);
      this.video.currentTime = target;
    });
  }
}

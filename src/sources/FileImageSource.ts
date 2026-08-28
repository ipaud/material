import * as THREE from 'three';
import { StaticTemporalSource } from '@/rendering/temporal/sources';
import type { TemporalSource } from '@/rendering/temporal/TemporalFrameProvider';
import {
  mediaUrl,
  type SourceCapabilities,
  type SourceRuntime,
  type SourceRuntimeStatus,
} from './SourceRuntime';

const CAPS: SourceCapabilities = {
  seekable: true, // any time yields the (one) frame
  duration: null,
  deterministic: true,
  exportable: true,
  temporalHistory: 'static',
  audio: false,
};

/**
 * Still image source. Extracted from engineBridge (18A) — texture parameters
 * and lifecycles are byte-for-byte the previous inline behavior.
 */
export class FileImageSource implements SourceRuntime {
  readonly kind = 'file-image' as const;
  readonly caps = CAPS;
  status: SourceRuntimeStatus = 'offline';

  private tex: THREE.Texture | null = null;
  private temporal: StaticTemporalSource | null = null;
  private disposed = false;

  constructor(readonly path: string) {}

  get width(): number | null {
    return this.tex?.image ? (this.tex.image as HTMLImageElement).naturalWidth : null;
  }
  get height(): number | null {
    return this.tex?.image ? (this.tex.image as HTMLImageElement).naturalHeight : null;
  }

  load(): Promise<void> {
    this.status = 'connecting';
    return new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(
        mediaUrl(this.path),
        (texture) => {
          if (this.disposed) {
            texture.dispose();
            return;
          }
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.minFilter = THREE.LinearMipmapLinearFilter;
          texture.generateMipmaps = true;
          this.tex = texture;
          this.temporal = new StaticTemporalSource(texture);
          this.status = 'live';
          resolve();
        },
        undefined,
        () => {
          this.status = 'error';
          reject(new Error(`Could not load ${this.path}`));
        },
      );
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
    // The engine owns disposal of the texture it was handed (setSource
    // disposes replaced textures) — matching the previous inline behavior.
    this.tex = null;
    this.temporal = null;
    this.status = 'offline';
  }
}

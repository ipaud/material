import * as THREE from 'three';
import { TemporalFrameProvider } from '@/rendering/temporal/TemporalFrameProvider';
import { getTechnique } from '@/techniques/registry';
import { defaultParams } from '@/techniques/types';
import type { MaterialState, ParamRecord } from '@shared/schemas/project';
import { ProceduralTemporalSource } from './proceduralSource';

const PREVIEW_W = 320;
const PREVIEW_H = 180;
const PREVIEW_TIME = 6;
const PREVIEW_SEED = 20250828;

const PREVIEW_MATERIAL: MaterialState = {
  materialId: 'square',
  colorMode: 'source',
  params: { aspect: 1 },
  assetPath: null,
};

/** Representative parameters per technique — what the card should show. */
export const PREVIEW_PARAMS: Record<string, ParamRecord> = {
  mosaic: {
    columns: 34,
    rows: 19,
    spacing: 0.14,
    lumToScale: 0.95,
    contrast: 1.15,
    tileMode: 'off',
  },
  'mosaic-temporal': {
    columns: 14,
    rows: 8,
    spacing: 0.06,
    lumToScale: 0.3,
    tileMode: 'tile',
    offsetMode: 'radial',
    maxOffsetSec: 1.6,
    falloff: 0.8,
  },
  echo: {
    copies: 10,
    delaySec: 0.14,
    decay: 0.82,
    offsetX: 2.4,
    offsetY: 0,
    copyScale: 1.012,
    distribution: 'linear',
  },
  'step-print': {
    copies: 5,
    stepSec: 0.16,
    hold: 2,
    decay: 0.82,
    offsetX: 2.5,
    offsetY: 1.4,
    mode: 'accumulate',
  },
  'slit-scan': {
    axis: 'horizontal',
    strips: 90,
    spanSec: 1.8,
    direction: 'forward',
    interpolate: 0,
  },
};

/**
 * Isolated renderer for technique cards. Uses its own GL context, its own
 * temporal buffer and owned procedural footage, so generating previews can
 * never disturb the user's composition or their temporal history.
 */
export class TechniquePreviewRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(28, PREVIEW_W / PREVIEW_H, 1, 100000);
  private readonly source = new ProceduralTemporalSource();
  private readonly temporal = new TemporalFrameProvider({ slotCount: 30, spacingSec: 1 / 20 });
  private readonly target: THREE.WebGLRenderTarget;

  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = PREVIEW_W;
    canvas.height = PREVIEW_H;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(1);
    this.target = new THREE.WebGLRenderTarget(PREVIEW_W, PREVIEW_H, {
      colorSpace: THREE.SRGBColorSpace,
    });
    const distance = PREVIEW_H / 2 / Math.tan((28 * Math.PI) / 360);
    this.camera.position.set(0, 0, distance);
    this.camera.far = distance * 4;
    this.camera.updateProjectionMatrix();
  }

  /** Render one card image. `variantId` selects the PREVIEW_PARAMS entry. */
  async render(techniqueId: string, variantId = techniqueId): Promise<string | null> {
    const definition = getTechnique(techniqueId);
    if (!definition) return null;

    const params: ParamRecord = {
      ...defaultParams(definition),
      ...(PREVIEW_PARAMS[variantId] ?? {}),
    };

    // Prime history exactly as an export would, from procedural timestamps.
    await this.temporal.primeExact(this.renderer, PREVIEW_TIME, this.source);
    this.source.drawAt(PREVIEW_TIME);

    const renderer = definition.createRenderer();
    this.scene.add(renderer.object3d);
    try {
      renderer.update(params, {
        sourceTexture: this.source.currentTexture(),
        materialTexture: null,
        temporal: this.temporal.getUniforms(),
        compWidth: PREVIEW_W,
        compHeight: PREVIEW_H,
        material: PREVIEW_MATERIAL,
        timeSec: PREVIEW_TIME,
        seed: PREVIEW_SEED,
      });

      this.renderer.setRenderTarget(this.target);
      this.renderer.setClearColor('#0c0c0d', 1);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);

      const pixels = new Uint8Array(PREVIEW_W * PREVIEW_H * 4);
      this.renderer.readRenderTargetPixels(this.target, 0, 0, PREVIEW_W, PREVIEW_H, pixels);
      this.renderer.setRenderTarget(null);

      const canvas = document.createElement('canvas');
      canvas.width = PREVIEW_W;
      canvas.height = PREVIEW_H;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      // GL reads bottom-up.
      const flipped = new Uint8ClampedArray(pixels.length);
      const rowBytes = PREVIEW_W * 4;
      for (let y = 0; y < PREVIEW_H; y++) {
        flipped.set(
          pixels.subarray(y * rowBytes, (y + 1) * rowBytes),
          (PREVIEW_H - 1 - y) * rowBytes,
        );
      }
      ctx.putImageData(new ImageData(flipped, PREVIEW_W, PREVIEW_H), 0, 0);
      return canvas.toDataURL('image/png');
    } finally {
      this.scene.remove(renderer.object3d);
      renderer.dispose();
    }
  }

  dispose(): void {
    this.target.dispose();
    this.temporal.dispose();
    this.source.dispose();
    this.renderer.dispose();
  }
}

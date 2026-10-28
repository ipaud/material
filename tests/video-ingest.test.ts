import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { VideoIngest } from '@/rendering/layers/VideoIngest';

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');

// No GL context in vitest: pin the structure; the pixels are pinned by
// `npm run gate:identity` (flat grey as video vs the same grey as PNG).
describe('video sources reach technique shaders sRGB-decoded', () => {
  const layer = read('src/rendering/layers/LayerRuntimeImpl.ts');

  it('techniques are handed the ingested copy, never the raw VideoTexture', () => {
    expect(layer).toContain('sourceTexture: this.techniqueSource(),');
    expect(layer).not.toMatch(/techniqueRenderer\.update\([^)]*sourceTexture: this\.sourceTexture/s);
  });

  it('the ingest renders through a built-in material into an SRGB target', () => {
    const ingest = read('src/rendering/layers/VideoIngest.ts');
    expect(ingest).toContain('new THREE.MeshBasicMaterial');
    expect(ingest).toContain('colorSpace: THREE.SRGBColorSpace');
  });

  it('is only engaged for video textures', () => {
    expect(layer).toContain('isVideoTexture');
  });
});

describe('VideoIngest frame copy', () => {
  it('resizes target, copies current texture, and restores renderer state', () => {
    const ingest = new VideoIngest();
    const target = (ingest as unknown as { target: THREE.WebGLRenderTarget }).target;
    const resize = vi.spyOn(target, 'setSize');
    const previousTarget = {} as THREE.WebGLRenderTarget;
    const renderer = {
      autoClear: false,
      getRenderTarget: vi.fn(() => previousTarget),
      setRenderTarget: vi.fn(),
      render: vi.fn(),
    } as unknown as THREE.WebGLRenderer;
    const video = new THREE.Texture();

    ingest.update(renderer, video, 640, 360);

    expect(resize).toHaveBeenCalledWith(640, 360);
    const scene = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as THREE.Scene;
    expect((scene.children[0] as THREE.Mesh).material).toMatchObject({ map: video });
    expect(renderer.setRenderTarget).toHaveBeenNthCalledWith(1, target);
    expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(previousTarget);
    expect(renderer.autoClear).toBe(false);
    ingest.dispose();
  });

  it('skips empty frames and restores renderer state when draw fails', () => {
    const ingest = new VideoIngest();
    const previousTarget = {} as THREE.WebGLRenderTarget;
    const renderer = {
      autoClear: false,
      getRenderTarget: vi.fn(() => previousTarget),
      setRenderTarget: vi.fn(),
      render: vi.fn(() => { throw new Error('draw failed'); }),
    } as unknown as THREE.WebGLRenderer;
    const video = new THREE.Texture();

    ingest.update(renderer, video, 0, 360);
    expect(renderer.render).not.toHaveBeenCalled();
    expect(renderer.setRenderTarget).not.toHaveBeenCalled();

    expect(() => ingest.update(renderer, video, 640, 360)).toThrow('draw failed');
    expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(previousTarget);
    expect(renderer.autoClear).toBe(false);
    ingest.dispose();
  });
});

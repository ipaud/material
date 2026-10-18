import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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

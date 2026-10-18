import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// No GL in vitest: the structure is pinned here, the pixels by a headless render
// (a layer with a source and no technique exported 0 before, the source's level now).
describe('a layer with a source and no technique passes the source through', () => {
  it('shows the original quad whenever there is no technique renderer', () => {
    const layer = readFileSync(join(process.cwd(), 'src/rendering/layers/LayerRuntimeImpl.ts'), 'utf8');
    expect(layer).toContain('this.originalQuad.visible = !showProcessed || !this.techniqueRenderer;');
  });
});

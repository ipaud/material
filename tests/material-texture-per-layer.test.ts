import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createEmptyProject, emptyLayer, type MaterialState } from '@shared/schemas/project';
import { resyncFromStore } from '@/rendering/engineBridge';
import { useProjectStore } from '@/state/projectStore';
import { MaterialTextureSlot } from '@/materials/materialTextureSlot';

const typography = (text: string): MaterialState =>
  ({ materialId: 'typography', colorMode: 'source', assetPath: null, params: { text } }) as MaterialState;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
/** jsdom has no 2D canvas: a fake loader returns a texture named after its text. */
const fakeLoad = vi.fn(async (material: MaterialState) =>
  Object.assign(new THREE.Texture(), { name: String(material.params.text) }));

describe('material textures are per layer', () => {
  it('each layer loads from its own material, not the project-wide one', () => {
    const sync = vi.spyOn(MaterialTextureSlot.prototype, 'sync').mockImplementation(() => {});
    try {
      const base = createEmptyProject('Two typography layers');
      const a = { ...base.layers[0]!, id: 'layer-a', material: typography('AB') };
      const b = { ...emptyLayer('layer-b', 'B'), material: typography('XYZ') };
      useProjectStore.getState().loadProject('', { ...base, layers: [a, b], selectedLayerId: 'layer-a', material: a.material });
      resyncFromStore();

      const texts = sync.mock.calls.map(([material]) => material.params.text);
      expect(texts).toContain('AB');
      expect(texts).toContain('XYZ');
      // Two different slots — one per layer — not one shared texture.
      const slots = new Set(sync.mock.instances);
      expect(slots.size).toBeGreaterThanOrEqual(2);
    } finally {
      sync.mockRestore();
    }
  });

  it('applies the loaded texture for the material it was asked for', async () => {
    const slot = new MaterialTextureSlot(fakeLoad);
    const apply = vi.fn();
    slot.sync(typography('AB'), apply, vi.fn());
    await settle();
    expect(apply.mock.calls[0]![0].name).toBe('AB');
  });

  it('a load that lands after the material changed again is disposed, not applied', async () => {
    const slot = new MaterialTextureSlot(fakeLoad);
    const apply = vi.fn();
    slot.sync(typography('OLD'), apply, vi.fn());
    slot.sync(typography('NEW'), apply, vi.fn());
    await settle();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![0].name).toBe('NEW');
  });

  it('switching to a plain material clears the texture without loading anything', async () => {
    const load = vi.fn(async (material: MaterialState) =>
      Object.assign(new THREE.Texture(), { name: String(material.params.text) }));
    const apply = vi.fn();
    const slot = new MaterialTextureSlot(load);
    slot.sync(typography('AB'), apply, vi.fn());
    await settle();
    slot.sync({ materialId: 'square', colorMode: 'source', assetPath: null, params: {} } as MaterialState, apply, vi.fn());
    expect(load).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith(null);
  });
});

import type * as THREE from 'three';
import type { MaterialState } from '@shared/schemas/project';

/** What makes two materials need different textures; null = no texture. */
export function materialTextureKey(material: MaterialState): string | null {
  if (material.materialId === 'custom') return `custom:${material.assetPath ?? ''}`;
  if (material.materialId === 'typography') return `typography:${JSON.stringify(material.params)}`;
  return null;
}

/**
 * One layer's material texture. Each layer loads from ITS OWN material: a
 * single project-wide texture made a second typography layer sample the
 * first layer's glyph atlas with its own glyph count.
 *
 * Loads are async; a result that arrives after the material changed again is
 * disposed, never applied.
 */
type LoadTexture = (material: MaterialState) => Promise<THREE.Texture | null>;

/** Lazy: the loader (and its bundled font) stays out of the main chunk. */
const loadTexture: LoadTexture = (material) =>
  import('@/materials/textureLoader').then(({ loadMaterialTexture, loadTypographyTexture }) =>
    material.materialId === 'typography'
      ? loadTypographyTexture(material)
      : material.assetPath ? loadMaterialTexture(material.assetPath) : null);

export class MaterialTextureSlot {
  private key: string | null = null;

  constructor(private readonly load: LoadTexture = loadTexture) {}

  /** Forget what was applied, e.g. when the runtime behind it was rebuilt. */
  reset(): void {
    this.key = null;
  }

  sync(
    material: MaterialState,
    apply: (texture: THREE.Texture | null) => void,
    onError: (err: unknown) => void,
  ): void {
    const key = materialTextureKey(material);
    if (key === this.key) return;
    this.key = key;
    if (!key) {
      apply(null);
      return;
    }
    this.load(material)
      .then((texture) => {
        if (!texture) return;
        if (this.key === key) apply(texture);
        else texture.dispose();
      })
      .catch((err: unknown) => {
        if (this.key !== key) return;
        onError(err);
        apply(null);
      });
  }
}

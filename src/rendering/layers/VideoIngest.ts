import * as THREE from 'three';

/**
 * three uploads a VideoTexture as plain RGBA8 — no hardware sRGB decode — and
 * relies on its BUILT-IN materials to decode in the shader. A technique's own
 * ShaderMaterial gets no such help: it read the video's encoded bytes as linear
 * light, and the sRGB render target then encoded them again. Measured on a flat
 * 128 grey clip: flow-displace exported 184, an image of the same grey 124.
 *
 * This copies the video through a built-in material (which decodes) into an
 * SRGB8 target (which stores it encoded and decodes on sample, exactly like an
 * image texture), so every technique sees the same linear light for both.
 */
export class VideoIngest {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  private readonly material = new THREE.MeshBasicMaterial({ transparent: false, depthTest: false });
  private readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);

  constructor() {
    this.target = new THREE.WebGLRenderTarget(2, 2, {
      depthBuffer: false,
      colorSpace: THREE.SRGBColorSpace,
    });
    this.scene.add(this.quad);
  }

  texture(): THREE.Texture {
    return this.target.texture;
  }

  /** Copy the video's current frame in. Leaves the renderer's state as it found it. */
  update(renderer: THREE.WebGLRenderer, video: THREE.Texture, width: number, height: number): void {
    if (width < 1 || height < 1) return;
    if (this.target.width !== width || this.target.height !== height) {
      this.target.setSize(width, height);
    }
    this.material.map = video;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    try {
      renderer.autoClear = true;
      renderer.setRenderTarget(this.target);
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;
    }
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}

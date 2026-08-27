import * as THREE from 'three';

/**
 * Bounded GPU ring buffer of recent source frames, stored as a slot atlas in
 * one render target (8×7 slots of 256×144 ≈ 8 MB, ~5 s at ~11 fps capture).
 * Spike implementation (Phase 3.5) — capture cadence is wall-clock based and
 * therefore not yet deterministic for export; Phase 8 will re-time it.
 */
export class FrameRingBuffer {
  readonly cols = 8;
  readonly rows = 7;
  readonly count = this.cols * this.rows;
  readonly slotWidth = 256;
  readonly slotHeight = 144;
  head = 0;
  filled = 0;
  private lastCaptureMs = 0;
  readonly captureIntervalMs = 90;

  readonly target: THREE.WebGLRenderTarget;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  private readonly quadMaterial: THREE.MeshBasicMaterial;

  constructor() {
    this.target = new THREE.WebGLRenderTarget(
      this.cols * this.slotWidth,
      this.rows * this.slotHeight,
      { depthBuffer: false, colorSpace: THREE.SRGBColorSpace },
    );
    this.quadMaterial = new THREE.MeshBasicMaterial();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.quadMaterial);
    this.scene.add(quad);
  }

  /** Capture the given texture into the next slot (throttled). */
  maybeCapture(renderer: THREE.WebGLRenderer, texture: THREE.Texture, nowMs: number): boolean {
    if (nowMs - this.lastCaptureMs < this.captureIntervalMs) return false;
    this.lastCaptureMs = nowMs;
    this.quadMaterial.map = texture;
    const slot = this.head;
    const x = (slot % this.cols) * this.slotWidth;
    const y = Math.floor(slot / this.cols) * this.slotHeight;

    const prevTarget = renderer.getRenderTarget();
    const prevRatio = renderer.getPixelRatio();
    renderer.setPixelRatio(1);
    renderer.setRenderTarget(this.target);
    renderer.setViewport(x, y, this.slotWidth, this.slotHeight);
    renderer.setScissor(x, y, this.slotWidth, this.slotHeight);
    renderer.setScissorTest(true);
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
    renderer.setPixelRatio(prevRatio);
    renderer.setRenderTarget(prevTarget);

    this.head = (this.head + 1) % this.count;
    this.filled = Math.min(this.filled + 1, this.count);
    return true;
  }

  dispose(): void {
    this.target.dispose();
    this.quadMaterial.dispose();
  }
}

import * as THREE from 'three';

/**
 * Capture timing mode.
 * - 'wallclock': spike behavior (validated Phase 3.5) — throttled by real time,
 *   NOT deterministic for export.
 * - 'timeline': Phase 8 — slots re-timed to composition time so exports are
 *   frame-exact. Not implemented yet.
 */
export type RingBufferMode = 'wallclock' | 'timeline';

export interface RingBufferConfig {
  /** Total slots (default 56 = 8×7). */
  slotCount?: number;
  /** Per-slot resolution (default 256×144). */
  slotResolution?: { width: number; height: number };
  /** Advisory cap on how far back techniques may reach, in slots. */
  maxOffsetSlots?: number;
  mode?: RingBufferMode;
}

const DEFAULT_SLOT_COUNT = 56;
const DEFAULT_SLOT_W = 256;
const DEFAULT_SLOT_H = 144;

/**
 * Bounded GPU ring buffer of recent source frames, stored as a slot atlas in
 * one render target (defaults: 8×7 slots of 256×144 ≈ 8 MB, ~5 s at ~11 fps).
 * Config is API-prep only — defaults reproduce the validated spike exactly.
 */
export class FrameRingBuffer {
  readonly cols: number;
  readonly rows: number;
  readonly count: number;
  readonly slotWidth: number;
  readonly slotHeight: number;
  readonly maxOffsetSlots: number;
  readonly mode: RingBufferMode;
  head = 0;
  filled = 0;
  private lastCaptureMs = 0;
  readonly captureIntervalMs = 90;

  readonly target: THREE.WebGLRenderTarget;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  private readonly quadMaterial: THREE.MeshBasicMaterial;

  constructor(config: RingBufferConfig = {}) {
    this.mode = config.mode ?? 'wallclock';
    if (this.mode === 'timeline') {
      throw new Error('timeline ring-buffer mode is not implemented yet (Phase 8)');
    }
    const count = config.slotCount ?? DEFAULT_SLOT_COUNT;
    this.cols = Math.ceil(Math.sqrt(count));
    this.rows = Math.ceil(count / this.cols);
    this.count = this.cols * this.rows;
    this.slotWidth = config.slotResolution?.width ?? DEFAULT_SLOT_W;
    this.slotHeight = config.slotResolution?.height ?? DEFAULT_SLOT_H;
    this.maxOffsetSlots = Math.min(config.maxOffsetSlots ?? this.count - 1, this.count - 1);
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

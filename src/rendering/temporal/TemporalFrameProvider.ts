import * as THREE from 'three';

/**
 * Composition-time addressable frame history.
 *
 * The buffer is a *time grid*, not a capture log: logical slot `k` always
 * holds the frame at composition time `anchorTime - k * spacingSec`. That
 * makes GPU lookup pure arithmetic (no search, no per-slot time upload) and
 * lets export prime the exact same addresses deterministically.
 *
 *   logical k  ->  time   anchorTime - k * spacingSec
 *   logical k  ->  slot   (head - k + count) % count
 *
 * Preview advances the grid incrementally as playback moves (cheap, wall-clock
 * *scheduling* but composition-time *addressing*). Export primes every slot by
 * exact seek before the first frame, so preview state can never leak in.
 */

export interface TemporalConfig {
  slotCount: number;
  slotWidth: number;
  slotHeight: number;
  /** Seconds between adjacent history slots. */
  spacingSec: number;
}

export const DEFAULT_TEMPORAL_CONFIG: TemporalConfig = {
  slotCount: 56,
  slotWidth: 256,
  slotHeight: 144,
  spacingSec: 1 / 24,
};

/** Anything that can produce a frame for an exact source time. */
export interface TemporalSource {
  /** Draw the frame at `timeSec` into the provider (async: may seek/decode). */
  acquireAt(timeSec: number): Promise<THREE.Texture | null>;
  /** Best-effort synchronous current frame (preview fast path). */
  currentTexture(): THREE.Texture | null;
  /** Source time bounds for clamping. */
  readonly startSec: number;
  readonly endSec: number;
  /** True when the source has no time dimension (still image). */
  readonly isStatic: boolean;
}

export type BoundaryMode = 'clamp' | 'transparent' | 'wrap' | 'mirror';

export interface TemporalUniforms {
  texture: THREE.Texture;
  cols: number;
  rows: number;
  count: number;
  head: number;
  filled: number;
  anchorTime: number;
  spacingSec: number;
}

export interface TemporalStats {
  slotCount: number;
  filled: number;
  cacheMB: number;
  anchorTime: number;
  spanSec: number;
  hits: number;
  misses: number;
  seeks: number;
}

/** Clamp a requested time into the source's range (see §14). */
export function resolveBoundary(
  timeSec: number,
  startSec: number,
  endSec: number,
  mode: BoundaryMode = 'clamp',
): number {
  if (endSec <= startSec) return startSec;
  switch (mode) {
    case 'wrap': {
      const span = endSec - startSec;
      const rel = (((timeSec - startSec) % span) + span) % span;
      return startSec + rel;
    }
    case 'mirror': {
      const span = endSec - startSec;
      const rel = (((timeSec - startSec) % (span * 2)) + span * 2) % (span * 2);
      return startSec + (rel <= span ? rel : span * 2 - rel);
    }
    // 'transparent' is resolved in the shader; addressing still clamps.
    case 'transparent':
    case 'clamp':
    default:
      return Math.min(Math.max(timeSec, startSec), endSec);
  }
}

/** Snap a time to the temporal grid so preview and export agree exactly. */
export function snapToGrid(timeSec: number, spacingSec: number): number {
  return Math.round(timeSec / spacingSec) * spacingSec;
}

export class TemporalFrameProvider {
  readonly config: TemporalConfig;
  readonly cols: number;
  readonly rows: number;

  private target: THREE.WebGLRenderTarget;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  private readonly quadMaterial: THREE.MeshBasicMaterial;

  /** Physical index of logical slot 0 (the anchor / newest frame). */
  private head = 0;
  private filled = 0;
  private anchorTime = 0;
  private hits = 0;
  private misses = 0;
  private seeks = 0;

  constructor(config: Partial<TemporalConfig> = {}) {
    this.config = { ...DEFAULT_TEMPORAL_CONFIG, ...config };
    this.cols = Math.ceil(Math.sqrt(this.config.slotCount));
    this.rows = Math.ceil(this.config.slotCount / this.cols);
    this.target = new THREE.WebGLRenderTarget(
      this.cols * this.config.slotWidth,
      this.rows * this.config.slotHeight,
      { depthBuffer: false, colorSpace: THREE.SRGBColorSpace },
    );
    this.quadMaterial = new THREE.MeshBasicMaterial({ transparent: false });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.quadMaterial));
  }

  get slotCount(): number {
    return this.cols * this.rows;
  }

  /** Total history reachable, in seconds. */
  get spanSec(): number {
    return (this.slotCount - 1) * this.config.spacingSec;
  }

  get cacheBytes(): number {
    return this.cols * this.config.slotWidth * this.rows * this.config.slotHeight * 4;
  }

  getUniforms(): TemporalUniforms {
    return {
      texture: this.target.texture,
      cols: this.cols,
      rows: this.rows,
      count: this.slotCount,
      head: this.head,
      filled: this.filled,
      anchorTime: this.anchorTime,
      spacingSec: this.config.spacingSec,
    };
  }

  getStats(): TemporalStats {
    return {
      slotCount: this.slotCount,
      filled: this.filled,
      cacheMB: this.cacheBytes / (1024 * 1024),
      anchorTime: this.anchorTime,
      spanSec: this.spanSec,
      hits: this.hits,
      misses: this.misses,
      seeks: this.seeks,
    };
  }

  /** Composition time currently held by logical slot k. */
  timeForLogicalSlot(k: number): number {
    return this.anchorTime - k * this.config.spacingSec;
  }

  private physicalSlot(logicalK: number): number {
    const count = this.slotCount;
    return ((this.head - logicalK) % count + count) % count;
  }

  /** Drop all history (seek, source change, loop restart). */
  invalidate(): void {
    this.filled = 0;
    this.hits = 0;
    this.misses = 0;
  }

  dispose(): void {
    this.target.dispose();
    this.quadMaterial.dispose();
  }

  /** Blit a texture into one physical slot. */
  private writeSlot(renderer: THREE.WebGLRenderer, physical: number, texture: THREE.Texture): void {
    this.quadMaterial.map = texture;
    this.quadMaterial.needsUpdate = true;
    const x = (physical % this.cols) * this.config.slotWidth;
    const y = Math.floor(physical / this.cols) * this.config.slotHeight;

    const prevTarget = renderer.getRenderTarget();
    const prevRatio = renderer.getPixelRatio();
    renderer.setPixelRatio(1);
    renderer.setRenderTarget(this.target);
    renderer.setViewport(x, y, this.config.slotWidth, this.config.slotHeight);
    renderer.setScissor(x, y, this.config.slotWidth, this.config.slotHeight);
    renderer.setScissorTest(true);
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
    renderer.setPixelRatio(prevRatio);
    renderer.setRenderTarget(prevTarget);
  }

  /**
   * PREVIEW path: advance the grid to `compositionTime` using whatever frame
   * the source currently shows. Only fills slots the grid actually moved past,
   * so scrubbing forward a little is cheap. Large jumps invalidate instead of
   * fabricating history from an unrelated frame (§2: never show stale frames
   * as if they were real history).
   */
  advancePreview(
    renderer: THREE.WebGLRenderer,
    compositionTime: number,
    texture: THREE.Texture | null,
  ): void {
    if (!texture) return;
    const spacing = this.config.spacingSec;
    const snapped = snapToGrid(compositionTime, spacing);

    if (this.filled === 0) {
      this.anchorTime = snapped;
      this.head = 0;
      this.writeSlot(renderer, 0, texture);
      this.filled = 1;
      this.misses++;
      return;
    }

    const deltaSlots = Math.round((snapped - this.anchorTime) / spacing);
    if (deltaSlots === 0) {
      this.hits++;
      return;
    }
    if (deltaSlots < 0 || deltaSlots > this.slotCount) {
      // Backward seek or a jump larger than the whole history: the frames in
      // between were never observed, so the buffer is rebuilt rather than
      // silently reused.
      this.invalidate();
      this.anchorTime = snapped;
      this.head = 0;
      this.writeSlot(renderer, 0, texture);
      this.filled = 1;
      this.misses++;
      return;
    }

    // Advance the grid; intermediate slots that playback skipped get the
    // newest frame (they are within one buffer span, so this is a small,
    // bounded approximation used only for interactive preview).
    for (let i = 0; i < deltaSlots; i++) {
      this.head = (this.head + 1) % this.slotCount;
      this.anchorTime += spacing;
      this.writeSlot(renderer, this.head, texture);
      this.filled = Math.min(this.filled + 1, this.slotCount);
    }
    this.anchorTime = snapped;
    this.hits++;
  }

  /**
   * EXPORT path: fill every slot from exact composition timestamps.
   * Independent of any preview state (§3, mandatory). Returns the schedule of
   * (logicalSlot, sourceTime) actually used — the determinism tests assert on
   * this schedule.
   */
  async primeExact(
    renderer: THREE.WebGLRenderer,
    compositionTime: number,
    source: TemporalSource,
    boundary: BoundaryMode = 'clamp',
  ): Promise<{ logicalSlot: number; sourceTime: number }[]> {
    const spacing = this.config.spacingSec;
    const anchor = snapToGrid(compositionTime, spacing);
    const schedule = temporalSchedule(anchor, spacing, this.slotCount, source, boundary);

    this.invalidate();
    this.anchorTime = anchor;
    this.head = 0;

    if (source.isStatic) {
      const texture = source.currentTexture();
      if (texture) {
        for (const entry of schedule) this.writeSlot(renderer, this.physicalSlot(entry.logicalSlot), texture);
        this.filled = this.slotCount;
      }
      return schedule;
    }

    // Oldest first so the video element seeks monotonically forward.
    for (let i = schedule.length - 1; i >= 0; i--) {
      const entry = schedule[i];
      if (!entry) continue;
      const texture = await source.acquireAt(entry.sourceTime);
      this.seeks++;
      if (texture) this.writeSlot(renderer, this.physicalSlot(entry.logicalSlot), texture);
    }
    this.filled = this.slotCount;
    return schedule;
  }

  /**
   * EXPORT path, subsequent frames: the grid advances by whole slots, so only
   * the newly exposed slots need exact decodes.
   */
  async advanceExact(
    renderer: THREE.WebGLRenderer,
    compositionTime: number,
    source: TemporalSource,
    boundary: BoundaryMode = 'clamp',
  ): Promise<{ logicalSlot: number; sourceTime: number }[]> {
    const spacing = this.config.spacingSec;
    const anchor = snapToGrid(compositionTime, spacing);
    if (this.filled === 0) return this.primeExact(renderer, compositionTime, source, boundary);

    const deltaSlots = Math.round((anchor - this.anchorTime) / spacing);
    if (deltaSlots === 0) {
      this.hits++;
      return [];
    }
    if (deltaSlots < 0 || deltaSlots >= this.slotCount) {
      return this.primeExact(renderer, compositionTime, source, boundary);
    }

    const written: { logicalSlot: number; sourceTime: number }[] = [];
    for (let i = 1; i <= deltaSlots; i++) {
      const slotTime = this.anchorTime + i * spacing;
      const sourceTime = resolveBoundary(slotTime, source.startSec, source.endSec, boundary);
      const texture = source.isStatic ? source.currentTexture() : await source.acquireAt(sourceTime);
      this.seeks++;
      this.head = (this.head + 1) % this.slotCount;
      if (texture) this.writeSlot(renderer, this.head, texture);
      written.push({ logicalSlot: 0, sourceTime });
    }
    this.anchorTime = anchor;
    this.misses += deltaSlots;
    return written;
  }
}

/**
 * Pure function: the exact source times a full temporal buffer maps to.
 * Shared by the provider and the determinism tests — no rendering involved.
 */
export function temporalSchedule(
  anchorTime: number,
  spacingSec: number,
  slotCount: number,
  bounds: { startSec: number; endSec: number },
  boundary: BoundaryMode = 'clamp',
): { logicalSlot: number; sourceTime: number }[] {
  return Array.from({ length: slotCount }, (_, k) => ({
    logicalSlot: k,
    sourceTime: resolveBoundary(anchorTime - k * spacingSec, bounds.startSec, bounds.endSec, boundary),
  }));
}

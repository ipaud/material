import * as THREE from 'three';

/**
 * CE1B — the FEEDBACK primitive.
 *
 * A ping-pong pair of GPU render targets holding persistent RENDERED state
 * (not source history — that's the temporal atlas). Every step samples READ,
 * combines it with the current frame, renders into WRITE, then swaps.
 * Sampling and rendering never touch the same texture (structurally
 * enforced: `read`/`write` are distinct objects and step() swaps after).
 *
 * State is renderer-local by construction: the editor and the Output
 * replica each own their surfaces; nothing here ever crosses a process.
 *
 * Format: RGBA8 in the pipeline's SRGB color space — same as every other
 * render target, so a neutral loop neither washes out nor darkens (§9).
 * Resolution: the COMPOSITION resolution (not the canvas/backing store) —
 * one truth for editor, Output and export; ~16.6 MB per pair at 1080p.
 */
export class FeedbackSurface {
  private a: THREE.WebGLRenderTarget;
  private b: THREE.WebGLRenderTarget;
  private flipped = false;
  /** Bumped on every reset — lets renderers know to re-prime. */
  generation = 0;
  primed = false;

  constructor(
    public width: number,
    public height: number,
  ) {
    this.a = this.make(width, height);
    this.b = this.make(width, height);
  }

  private make(w: number, h: number): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(w, h, {
      depthBuffer: false,
      colorSpace: THREE.SRGBColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
  }

  get read(): THREE.WebGLRenderTarget {
    return this.flipped ? this.b : this.a;
  }
  get write(): THREE.WebGLRenderTarget {
    return this.flipped ? this.a : this.b;
  }

  swap(): void {
    this.flipped = !this.flipped;
  }

  /** Drop all state; the next step must prime before sampling. */
  reset(): void {
    this.primed = false;
    this.generation++;
  }

  /**
   * CE1H §57: after a WebGL context restore the old targets are dead GL
   * handles — touching one raises INVALID_OPERATION. Same size, so resize()
   * would no-op; this forces the reallocation.
   */
  recreate(): void {
    this.a.dispose();
    this.b.dispose();
    this.a = this.make(this.width, this.height);
    this.b = this.make(this.width, this.height);
    this.reset();
  }

  /** Reallocate on incompatible size; contents are gone → reset. */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.a.dispose();
    this.b.dispose();
    this.width = width;
    this.height = height;
    this.a = this.make(width, height);
    this.b = this.make(width, height);
    this.flipped = false;
    this.reset();
  }

  get bytes(): number {
    return this.width * this.height * 4 * 2;
  }

  dispose(): void {
    this.a.dispose();
    this.b.dispose();
    this.primed = false;
  }
}

/**
 * Feedback advances at a fixed step rate against a caller-supplied clock:
 * PREVIEW feeds wall time (live, file, paused transport and static images
 * all evolve — feedback is a visual process, §20/24); EXPORT feeds
 * composition time and steps deterministically from the timeline origin.
 * The accumulator returns how many whole steps to run this frame, capped in
 * preview so a stall never produces a runaway burst.
 */
export const FEEDBACK_STEP_RATE = 60; // steps per second, all contexts

export class FeedbackClock {
  private lastStep = -1;

  /** Whole steps elapsed at `clockSec`, capped for interactive use. */
  advance(clockSec: number, cap = 4): number {
    const step = Math.floor(clockSec * FEEDBACK_STEP_RATE);
    if (this.lastStep < 0) {
      this.lastStep = step;
      return 1; // first call always primes+steps once
    }
    let delta = step - this.lastStep;
    if (delta < 0) delta = 0; // clock went backwards (never in preview; safe)
    this.lastStep = step;
    return Math.min(delta, cap);
  }

  /** Exact steps between two composition times (export path, uncapped). */
  static stepsBetween(fromSec: number, toSec: number): number {
    return Math.max(
      Math.floor(toSec * FEEDBACK_STEP_RATE) - Math.floor(fromSec * FEEDBACK_STEP_RATE),
      0,
    );
  }

  reset(): void {
    this.lastStep = -1;
  }
}

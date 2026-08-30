import * as THREE from 'three';

/**
 * CE1E — the SIMULATION primitive.
 *
 * Feedback reprocesses prior IMAGERY; simulation evolves abstract STATE by
 * an explicit rule. Both use GPU ping-pong, but their lifecycles differ
 * enough (seeded canonical initial state, integer step index, per-system
 * formats/filters) that this is a sibling of FeedbackSurface, not a
 * refactor of it — stable code wins (§3).
 *
 * Clock (§8-15, the CE1B template):
 *   PREVIEW  wall-clock accumulator → fixed 60 Hz steps, capped catch-up.
 *   EXPORT   composition time → INTEGER step index, floor(t · RATE).
 * Step evolution is therefore addressed by an integer, which is what makes
 * repeated and subrange exports reproducible (§74-75).
 *
 * Nothing here reads pixels back in the product path; verification goes
 * through the CE1D-2 GPU harness (docs/GPU_TESTING.md).
 */

export const SIM_STEP_RATE = 60; // Hz — one meaning in preview and export
export const SIM_MAX_CATCHUP = 8; // §11 bounded catch-up

export interface SimulationFormat {
  /** Data type of the state targets. */
  type: THREE.TextureDataType;
  /** Nearest for discrete systems (cellular), Linear for continuous (RD). */
  filter: THREE.MagnificationTextureFilter;
}

export const SIM_FORMAT_CONTINUOUS: SimulationFormat = {
  type: THREE.HalfFloatType,
  filter: THREE.LinearFilter,
};
export const SIM_FORMAT_DISCRETE: SimulationFormat = {
  type: THREE.UnsignedByteType,
  filter: THREE.NearestFilter,
};

export class SimulationSurface {
  private a: THREE.WebGLRenderTarget;
  private b: THREE.WebGLRenderTarget;
  private flipped = false;
  /** Integer steps executed since the last reset — the determinism anchor. */
  stepIndex = 0;
  seeded = false;

  constructor(
    public width: number,
    public height: number,
    private format: SimulationFormat,
  ) {
    this.a = this.make();
    this.b = this.make();
  }

  private make(): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(this.width, this.height, {
      depthBuffer: false,
      type: this.format.type,
      minFilter: this.format.filter,
      magFilter: this.format.filter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
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

  /** Mark unseeded: the next step must re-run the seed pass first. */
  reset(): void {
    this.seeded = false;
    this.stepIndex = 0;
  }

  /** CE1H §57: rebuild after a context restore (see FeedbackSurface). */
  recreate(): void {
    this.a.dispose();
    this.b.dispose();
    this.a = this.make();
    this.b = this.make();
    this.flipped = false;
    this.reset();
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.a.dispose();
    this.b.dispose();
    this.width = width;
    this.height = height;
    this.a = this.make();
    this.b = this.make();
    this.flipped = false;
    this.reset();
  }

  get bytes(): number {
    const bpp = this.format.type === THREE.UnsignedByteType ? 4 : 8;
    return this.width * this.height * bpp * 2;
  }

  dispose(): void {
    this.a.dispose();
    this.b.dispose();
  }
}

/**
 * Fixed-step scheduler. Preview accumulates wall time; export asks for the
 * exact integer step index of a composition time. Both land on the same
 * grid, so "5 seconds in" means the same number of steps either way.
 */
export class SimulationClock {
  private lastWall = -1;
  private accumulator = 0;

  /** Preview: how many whole steps to run now (bounded catch-up). */
  advanceWall(wallSec: number): number {
    if (this.lastWall < 0) {
      this.lastWall = wallSec;
      return 1; // first frame runs one step so state is never empty
    }
    const dt = Math.max(wallSec - this.lastWall, 0);
    this.lastWall = wallSec;
    this.accumulator += dt;
    const stepDur = 1 / SIM_STEP_RATE;
    let steps = Math.floor(this.accumulator / stepDur);
    this.accumulator -= steps * stepDur;
    if (steps > SIM_MAX_CATCHUP) {
      steps = SIM_MAX_CATCHUP; // drop the backlog rather than freeze the app
      this.accumulator = 0;
    }
    return steps;
  }

  reset(): void {
    this.lastWall = -1;
    this.accumulator = 0;
  }

  /** Export: canonical integer step index for a composition time (§74-75).
   * Integer math keeps long exports drift-free. */
  static stepIndexAt(compositionSec: number): number {
    return Math.max(Math.floor(compositionSec * SIM_STEP_RATE), 0);
  }
}

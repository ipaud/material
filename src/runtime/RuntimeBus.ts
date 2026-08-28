import type { MaterialState, ParamRecord } from '@shared/schemas/project';

/**
 * RuntimeBus (Phase 18A) — the v0.3 state-synchronization seam.
 *
 * The editor renderer is the single runtime authority (clock, scheduler,
 * MIDI, modulation, overlays). A future Output replica renders exactly what
 * it receives from this bus over a MessagePort; in 18A the bus only emits
 * locally so the contract exists and is observable before any second window
 * does (docs/LIVE_OUTPUT_ARCHITECTURE.md §5–6).
 *
 * INVARIANT carried over from the export hotfix: `techniqueId` is explicit
 * render state. A consumer must never assume renderer identity from a
 * previously mounted technique — it observes FrameState.techniqueId,
 * synchronizes the correct renderer and temporal capability, then renders
 * the evaluated params:
 *
 *   active renderer technique === frame state technique
 *
 * Producers:
 *  - engineBridge feeds RenderInputs on project sync (low rate)
 *  - RenderEngine feeds evaluated frames from its real render pass
 *    (high rate; never from renderStill/export, which stay isolated)
 */

/** Low-rate render inputs — change with the project, not per frame. */
export interface RenderInputs {
  techniqueId: string | null;
  materialState: MaterialState | null;
  compWidth: number;
  compHeight: number;
  background: string;
}

/** High-rate evaluated frame — everything a replica needs to draw. */
export interface FrameState {
  compTime: number;
  /** Explicit render state — never inferred from a previously live renderer. */
  techniqueId: string | null;
  /** Temporal capability is composition state, carried with every frame. */
  temporalActive: boolean;
  /** Final evaluated params (base → macros → modulation → overlay → pulses). */
  finalParams: ParamRecord;
  materialState: MaterialState | null;
}

/**
 * Clock sync beacon (contract only in 18A; emitted from 18B).
 * Maps authority composition time onto the receiver's local clock.
 */
export interface ClockSync {
  compTime: number;
  sentAtHighRes: number;
  playing: boolean;
  rate: 1;
}

type FrameListener = (frame: FrameState) => void;

class RuntimeBus {
  private inputs: RenderInputs = {
    techniqueId: null,
    materialState: null,
    compWidth: 0,
    compHeight: 0,
    background: '#000000',
  };
  private lastFrame: FrameState | null = null;
  private listeners = new Set<FrameListener>();
  private frameCount = 0;

  /** engineBridge: project-shaped inputs changed. */
  setRenderInputs(inputs: RenderInputs): void {
    this.inputs = inputs;
  }

  getRenderInputs(): RenderInputs {
    return this.inputs;
  }

  /**
   * RenderEngine: one evaluated frame was drawn on the live canvas.
   * Hot path — one object literal per rendered frame, no store writes.
   */
  emitFrame(compTime: number, finalParams: ParamRecord, temporalActive: boolean): void {
    const frame: FrameState = {
      compTime,
      techniqueId: this.inputs.techniqueId,
      temporalActive,
      finalParams,
      materialState: this.inputs.materialState,
    };
    this.lastFrame = frame;
    this.frameCount++;
    for (const listener of this.listeners) listener(frame);
  }

  latest(): FrameState | null {
    return this.lastFrame;
  }

  /** Frames emitted since startup — cheap liveness probe for QA/devtools. */
  get emitted(): number {
    return this.frameCount;
  }

  subscribe(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Project switch: a replica must not render stale frame state. */
  reset(): void {
    this.lastFrame = null;
  }
}

export const runtimeBus = new RuntimeBus();

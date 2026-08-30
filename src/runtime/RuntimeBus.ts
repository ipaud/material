import type { LoadedShader } from '@shared/schemas/shaderPack';
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
  /** v0.5: pack shader definitions the Output needs in order to compile the
   * same technique locally. Data, not programs. */
  customShaders?: LoadedShader[];
  materialState: MaterialState | null;
  compWidth: number;
  compHeight: number;
  background: string;
  /** Structured-clone-safe source identity — a replica rebuilds its own media. */
  source:
    | { kind: 'file-image' | 'file-video'; path: string }
    | { kind: 'live-camera'; deviceId: string | null }
    | { kind: 'live-screen'; displayId: number | null }
    | { kind: 'live-window' }
    /** CE1F: generator config is LOW-FREQUENCY source config; the resolved
     * per-frame params travel with FrameState so the Output never evaluates
     * modulation itself. */
    | {
        kind: 'generator';
        generator: string;
        seed: number;
        params: Record<string, string | number | boolean>;
      }
    | null;
  /** Project generation — replicas drop state when it changes. */
  generation: number;
}

/** Transport notifications from the one clock (play/pause/seek). */
export interface TransportEvent {
  action: 'play' | 'pause' | 'seek';
  timeSec: number;
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
  sourceParams?: ParamRecord | undefined;
  /** CE1G: RESOLVED morph transition (editor authority). The Output
   * composites its own local frames with these values; it never computes
   * morph schedule, easing or progress. */
  transition?:
    | { generation: number; progress: number; style: string; params: Record<string, number> }
    | undefined;
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
type InputsListener = (inputs: RenderInputs) => void;
type TransportListener = (event: TransportEvent) => void;

class RuntimeBus {
  private inputs: RenderInputs = {
    techniqueId: null,
    materialState: null,
    compWidth: 0,
    compHeight: 0,
    background: '#000000',
    source: null,
    generation: -1,
  };
  private lastFrame: FrameState | null = null;
  private listeners = new Set<FrameListener>();
  private inputsListeners = new Set<InputsListener>();
  private transportListeners = new Set<TransportListener>();
  private frameCount = 0;

  /** engineBridge: project-shaped inputs changed. */
  setRenderInputs(inputs: RenderInputs): void {
    this.inputs = inputs;
    for (const listener of this.inputsListeners) listener(inputs);
  }

  subscribeInputs(listener: InputsListener): () => void {
    this.inputsListeners.add(listener);
    return () => this.inputsListeners.delete(listener);
  }

  /** PlaybackController: transport changed (synchronization only — the
   *  clock's semantics are untouched; this is a notification seam). */
  emitTransport(action: TransportEvent['action'], timeSec: number): void {
    for (const listener of this.transportListeners) listener({ action, timeSec });
  }

  subscribeTransport(listener: TransportListener): () => void {
    this.transportListeners.add(listener);
    return () => this.transportListeners.delete(listener);
  }

  getRenderInputs(): RenderInputs {
    return this.inputs;
  }

  /**
   * RenderEngine: one evaluated frame was drawn on the live canvas.
   * Hot path — one object literal per rendered frame, no store writes.
   */
  emitFrame(
    compTime: number,
    finalParams: ParamRecord,
    temporalActive: boolean,
    sourceParams?: ParamRecord,
    transition?: FrameState['transition'],
  ): void {
    const frame: FrameState = {
      compTime,
      techniqueId: this.inputs.techniqueId,
      temporalActive,
      finalParams,
      // CE1F: resolved generator params (authority = editor). Absent when no
      // generator is active, so the hot path does not grow for other sources.
      sourceParams,
      transition,
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

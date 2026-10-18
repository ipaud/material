/**
 * Editor-authority ↔ Output-replica message contracts (Phase 18B).
 *
 * Transported over a MessageChannelMain port pair brokered by the main
 * process — main never interprets these. Everything must be structured-clone
 * safe: no DOM refs, no Three objects, no functions.
 *
 * Performance-semantic events (MIDI, triggers, morph, candidate, look apply)
 * deliberately do NOT exist here: they resolve into FrameState on the
 * authority side. The replica renders results; it never evaluates.
 */

import type { MaterialState, ParamRecord } from './schemas/project';
import type { LoadedShader } from './schemas/shaderPack';

/** Low rate — project-shaped render configuration. */
export interface RenderInputsMsg {
  type: 'render-inputs';
  /** Bumped on new/open/recover — replica drops all prior media/state. */
  generation: number;
  techniqueId: string | null;
  materialState: MaterialState | null;
  compWidth: number;
  compHeight: number;
  background: string;
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
  /**
   * v0.5: shader DEFINITIONS the replica may need — the active custom
   * technique and any pinned Look that names one. Data only: manifest entry
   * plus GLSL text. No compiled program, no GPU object and no pixel ever
   * crosses this channel; the replica compiles locally, exactly as the editor
   * does, and caches by hash so a project change does not recompile.
   *
   * Low frequency by construction: this rides RenderInputs, which is sent on
   * project changes, not per frame.
   */
  customShaders?: LoadedShader[] | undefined;
  /**
   * v0.6E — the layer stack, as CONFIGURATION.
   *
   * The Output is a replica of the composition, and with layers the
   * composition is a stack. It still evaluates nothing: this carries which
   * layers exist, what each one is made of and how it blends, exactly the way
   * the single-technique fields above always have. The resolved per-frame
   * values — parameters and opacity — ride FrameState.
   *
   * The single-layer fields are kept and still describe the SELECTED layer,
   * so a replica that has not been taught about layers keeps working and the
   * diagnostics that read them do not have to change.
   */
  layers?: OutputLayerInput[] | undefined;
}

/** One layer's worth of RenderInputs. Configuration only — no pixels. */
export interface OutputLayerInput {
  id: string;
  techniqueId: string | null;
  materialState: MaterialState | null;
  blendMode: string;
  /** Serial layer (see Layer.input). Absent = 'source'. */
  input?: 'source' | 'below';
  enabled: boolean;
  opacity: number;
  source: RenderInputsMsg['source'];
}

/** High rate — one evaluated frame from the authority's live render pass. */
export interface FrameStateMsg {
  type: 'frame';
  seq: number;
  /** Authority wall clock (Date.now) at send — same machine, comparable. */
  wallEmittedAt: number;
  compTime: number;
  techniqueId: string | null;
  temporalActive: boolean;
  finalParams: ParamRecord;
  /** CE1F: resolved generator source params (editor authority). Present
   * only while a generator source is active. */
  sourceParams?: ParamRecord | undefined;
  /** CE1G: RESOLVED morph transition (editor authority). The Output
   * composites its own local frames with these values; it never computes
   * morph schedule, easing or progress. */
  transition?:
    | { generation: number; progress: number; style: string; params: Record<string, number> }
    | undefined;
  materialState: MaterialState | null;
  /**
   * v0.6E — resolved values for EVERY layer, keyed by layer id.
   *
   * `finalParams` above still carries the selected layer's, unchanged. These
   * carry the rest, plus every layer's resolved opacity, because a signal may
   * be driving it and the replica must never work that out for itself.
   */
  layerParams?: Record<string, ParamRecord> | undefined;
  layerOpacity?: Record<string, number> | undefined;
  /** Each generator layer's resolved SOURCE parameters — a different set from
   * its technique's, and what the replica drives its local generator with. */
  layerSourceParams?: Record<string, ParamRecord> | undefined;
}

export interface TransportMsg {
  type: 'transport';
  action: 'play' | 'pause' | 'seek';
  timeSec: number;
}

/** ~4 Hz beacon + sent on every transport change. */
export interface ClockSyncMsg {
  type: 'clock';
  seq: number;
  authorityTimeSec: number;
  playing: boolean;
  playbackRate: 1;
  wallEmittedAt: number;
}

export type OutputChannelMsg = RenderInputsMsg | FrameStateMsg | TransportMsg | ClockSyncMsg;

export type OutputWindowStatus = 'closed' | 'open' | 'error';

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
  materialState: MaterialState | null;
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

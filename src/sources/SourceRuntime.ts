import type * as THREE from 'three';
import type { TemporalSource } from '@/rendering/temporal/TemporalFrameProvider';

/**
 * Source runtime contract (Phase 18A seam — docs/LIVE_OUTPUT_ARCHITECTURE.md §8).
 *
 * v0.2 loaded file media inline in the engine bridge. v0.3 adds live sources
 * (camera / screen / window) whose constraints differ per capability, not per
 * scattered `if (kind === ...)`. This contract formalizes what every source
 * must expose; 18A ships the two file implementations, behavior-identical to
 * the previous inline code. Live implementations arrive in 18D/18E.
 */

export type SourceRuntimeKind =
  'file-image' | 'file-video' | 'live-camera' | 'live-screen' | 'live-window';

export type SourceRuntimeStatus =
  | 'offline'
  | 'connecting'
  | 'live'
  | 'permission-required'
  | 'permission-denied'
  | 'device-lost'
  | 'error';

export interface SourceCapabilities {
  /** Exact frame for an exact time on demand (export seeks). */
  seekable: boolean;
  /** Known finite duration, seconds — null for realtime sources. */
  duration: number | null;
  /** Same time → same frame, always. */
  deterministic: boolean;
  /** Offline sequence/movie export possible. */
  exportable: boolean;
  /** How temporal history can be built for this source. */
  temporalHistory: 'exact' | 'realtime' | 'static';
  audio: boolean;
}

export interface SourceRuntime {
  readonly kind: SourceRuntimeKind;
  readonly caps: SourceCapabilities;
  readonly status: SourceRuntimeStatus;
  readonly width: number | null;
  readonly height: number | null;
  /** Texture to hand to the engine — null until live/loaded. */
  texture(): THREE.Texture | null;
  /** Temporal feed for history-sampling techniques — null until ready. */
  temporalSource(): TemporalSource | null;
  dispose(): void;
}

/** Live sources add an explicit connect step (permission flow) — 18D/18E. */
export interface LiveSourceRuntime extends SourceRuntime {
  connect(): Promise<void>;
  onStatus(listener: (status: SourceRuntimeStatus) => void): () => void;
}

export function mediaUrl(path: string): string {
  return `material://media?p=${encodeURIComponent(path)}`;
}

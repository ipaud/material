import type * as THREE from 'three';
import type { ParamRecord } from '@shared/schemas/project';
import type { RawVisualStats, VisualSignalId } from '@/signals/visual/types';

/**
 * v0.6.1 — what a LAYER RUNTIME is, from the host's point of view.
 *
 * One creative chain: a source, a generator, temporal history, optical flow,
 * a technique, image analysis, feedback state. It owns no canvas, no
 * animation loop and no view transform, because those belong to the
 * composition hosting it.
 *
 * The host depends on THIS interface and never on the concrete class, which
 * is what keeps `LayerHost` free of a circular import and — more usefully —
 * makes the set of things a host may ask a layer an explicit, short list. If
 * a new host-side question needs a new method here, that is the moment to ask
 * whether the question has a well-defined scope.
 *
 * Every method is scoped to THIS layer. Questions about the SET live on
 * `LayerHost` and are named `any*` / `all*` / `*For(layerId)` so a reader can
 * never mistake one for the other — the v0.6 defect family was precisely that
 * mistake, made nine times.
 */
export interface LayerRuntime {
  // ---- lifecycle -----------------------------------------------------------
  /** Adopt a renderer. Called on creation and again if the host's is replaced. */
  initBranch(renderer: THREE.WebGLRenderer): void;
  disposeBranch(): void;
  handleContextRestored(): void;

  // ---- composition-wide state pushed down -----------------------------------
  setComposition(width: number, height: number, background: string): void;
  setSeed(seed: number): void;
  setTime(timeSec: number): void;
  setParamTransform(fn: ((base: ParamRecord, timeSec: number) => ParamRecord) | null): void;
  setSource(texture: THREE.Texture | null): void;
  setLiveSourceActive(active: boolean): void;

  // ---- render ---------------------------------------------------------------
  renderLayerTo(target: THREE.WebGLRenderTarget, opts: { clear: boolean }): void;
  renderLayerToWithParams(target: THREE.WebGLRenderTarget, params: ParamRecord, clear?: boolean): void;
  renderLayerToCanvas(renderer: THREE.WebGLRenderer): void;

  // ---- what THIS layer needs ------------------------------------------------
  /** A live device is delivering frames outside the invalidation model. */
  readonly liveSourceActive: boolean;
  /** A simulation generator advances on its own clock. */
  readonly generatorActive: boolean;
  /** This layer's technique keeps feedback history. */
  readonly isFeedbackTechnique: boolean;
  /** ...and is doing so right now (false during export, which steps it). */
  readonly feedbackActive: boolean;
  /** This layer is addressing frame history. */
  readonly isTemporalActive: boolean;
  readonly hasGenerator: boolean;

  // ---- export -------------------------------------------------------------
  beginExportMode(): void;
  endExportMode(): void;
  prepareGeneratorForExport(compositionTime: number, width: number, height: number): void;
  prepareFlowForExport(
    compositionTime: number,
    frameKey: string,
    isFirstFrame: boolean,
    width: number,
    height: number,
    params?: ParamRecord,
  ): void;
  prepareFeedbackForExport(compositionTime: number, isFirstFrame: boolean, params?: ParamRecord): void;
  prepareTemporalForExport(
    compositionTime: number,
    prime: boolean,
  ): Promise<{ logicalSlot: number; sourceTime: number }[]>;
  updateVisualStatsForExport(frameKey: string): void;
  setExportPreviousTime(sec: number | null): void;
  resetTemporal(): void;

  // ---- analysis -------------------------------------------------------------
  setVisualDemand(ids: ReadonlySet<VisualSignalId>): void;
  setVisualSink(fn: ((stats: RawVisualStats | null) => void) | null): void;
  readonly visualSignalStats: RawVisualStats | null;
  readonly visualDiagnostics: { reductions: number; bytes: number; width: number; height: number } | null;

  // ---- authority ------------------------------------------------------------
  /** What this layer last resolved for its technique, for the host to publish. */
  readonly lastResolved: ParamRecord | null;
  resolvedSourceParams(timeSec?: number): ParamRecord;
}

/** What a layer needs from the frame around it. Aggregated by the host. */
export interface LayerRequirements {
  readonly needsContinuousRender: boolean;
  readonly needsLiveSource: boolean;
  readonly needsFeedbackPreroll: boolean;
  readonly needsTemporalHistory: boolean;
  readonly needsGenerator: boolean;
}

export function requirementsOf(runtime: LayerRuntime): LayerRequirements {
  return {
    needsContinuousRender:
      runtime.liveSourceActive || runtime.feedbackActive || runtime.generatorActive,
    needsLiveSource: runtime.liveSourceActive,
    needsFeedbackPreroll: runtime.isFeedbackTechnique,
    needsTemporalHistory: runtime.isTemporalActive,
    needsGenerator: runtime.hasGenerator,
  };
}

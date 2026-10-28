import { selectedLayerOf } from '@shared/schemas/project';
import { projectWithLayerLooks } from '@/performance/layerLook';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { playback } from '@/playback/PlaybackController';
import { nextBoundary } from '@/signals/quantize';
import { blockedByExport } from '@/export/exportGuard';
import { uid } from '@/utils/id';
import { engine } from '@/rendering/RenderEngine';
import { DEFAULT_TRANSITION, type TransitionParams } from '@/rendering/transition/TransitionCompositor';
import { revealProgress, switchPoint } from './transitionWindow';
import { captureLookCore, lookToCore, projectWithLookCore } from './lookCore';
import { interpolateLookCore, morphCurve, type MorphStats } from './interpolate';
import type { LookCore, MorphCurve, QuantizeMode } from '@shared/schemas/project';

/**
 * Live morph runtime.
 *
 * While a morph is ARMED, the visual state at composition time t is a pure
 * function of (sourceSnapshot, targetCore, startTime, endTime, curve, t):
 * seeking before the start shows the source, seeking inside shows the exact
 * interpolated state, and loop wraps replay it — no scheduler history.
 *
 * Crossing the end during playback COMMITS the target into the project as a
 * single undo entry and records a MorphEvent so export replays the same
 * transition. Cancel commits the current interpolated state (cancel-and-keep)
 * and records the truncated event.
 *
 * The one store mutation while armed: when the interpolated technique or
 * material IDENTITY changes sides at the midpoint, the flip is written via
 * applySilent so the renderer/material loaders follow — numeric state stays
 * in the overlay and never touches the document until commit.
 */

export type MorphDuration =
  | { mode: 'seconds'; seconds: number }
  | { mode: 'beats'; beats: number }
  | { mode: 'bars'; bars: number };

export interface ActiveMorph {
  targetLookId: string;
  targetLabel: string;
  source: LookCore;
  target: LookCore;
  startTime: number;
  endTime: number;
  curve: MorphCurve;
  /**
   * v0.7: whether completing this morph appends a `morphEvent`.
   *
   * `morphEvents` exist so export can replay a transition the performer did
   * live. A morph a TAKE launched is already recorded — in the Take — so
   * writing it to history as well would give the export two virtual morphs
   * for one gesture, and dirty the project every time a Take is replayed.
   * One gesture, one record.
   */
  record: boolean;
}

class MorphRuntime {
  /**
   * CE1G — the visual TRANSITION style. A performance setting, not Look
   * content: Looks stay pure creative state (§50-51). `smooth` reproduces
   * v0.3 behaviour exactly, so existing projects never change.
   */
  private transition: TransitionParams = { ...DEFAULT_TRANSITION };
  /** Bumped whenever a morph activates — the Output's snapshot trigger. */
  transitionGeneration = 0;
  private snapshotTaken = false;

  setTransition(next: Partial<TransitionParams>): void {
    this.transition = { ...this.transition, ...next };
  }

  getTransition(): TransitionParams {
    return this.transition;
  }

  /** True when a style other than Smooth is armed for the active morph. */
  private get hasPixelTransition(): boolean {
    return this.active !== null && this.transition.style !== 'smooth';
  }

  private get crossTechnique(): boolean {
    return this.active !== null && this.active.source.techniqueId !== this.active.target.techniqueId;
  }

  /** Reveal progress at a composition time — see transitionWindow.ts. */
  transitionProgressAt(t: number): number | null {
    if (!this.active || !this.hasPixelTransition) return null;
    const raw = this.progressAt(t);
    if (raw === null) return null;
    return revealProgress(morphCurve(raw, this.active.curve), this.crossTechnique, true);
  }

  /** True while the reveal window is open (snapshot must exist). */
  transitionActive(t: number): boolean {
    const p = this.transitionProgressAt(t);
    return p !== null && p > 0 && p < 1;
  }

  /** The instant the snapshot must be taken: just before the reveal opens. */
  transitionArmed(t: number): boolean {
    const p = this.transitionProgressAt(t);
    return p !== null && p <= 0;
  }

  private active: ActiveMorph | null = null;
  private lastStats: MorphStats | null = null;
  /** Which identity side the store currently reflects (-1 A, 1 B). */
  private committedSide: -1 | 1 = -1;

  get current(): ActiveMorph | null {
    return this.active;
  }

  get stats(): MorphStats | null {
    return this.lastStats;
  }

  /** Resolve a musical duration to exact seconds using the CURRENT grid (§9). */
  resolveDurationSec(duration: MorphDuration): number {
    if (duration.mode === 'seconds') return Math.max(duration.seconds, 0.05);
    const { bpm, beatsPerBar } = useProjectStore.getState().project.timeline;
    const beatSec = bpm && bpm > 0 ? 60 / bpm : 0.5;
    if (duration.mode === 'beats') return Math.max(duration.beats * beatSec, 0.05);
    return Math.max(duration.bars * beatSec * beatsPerBar, 0.05);
  }

  /**
   * Launch a morph from the CURRENT state to a pinned look. Musical duration
   * and quantized start are resolved to exact times now — a BPM change during
   * the morph does not alter the end time (documented rule).
   */
  start(
    targetLookId: string,
    options: {
      startQuantize: QuantizeMode;
      duration: MorphDuration;
      curve: MorphCurve;
      /** Default true; false when something else already owns the record. */
      record?: boolean;
    },
    atTime = playback.getTime(),
  ): boolean {
    if (blockedByExport('Morph')) return false;
    // A morph that has REACHED ITS END commits before anything replaces it.
    //
    // Without this, a repeating trigger — "morph to Look 2 every bar", over one
    // bar — destroyed each morph at the exact instant it finished, because the
    // playback tick fires triggers before it ticks the morph runtime. Nothing
    // ever reached the document, so every new morph started from the original
    // state and the picture sawtoothed forever.
    //
    // Measured against export on a bar trigger at 120 BPM: the two diverged by
    // 7.0 on a parameter whose whole range is 0.2 to 6 — not a drift, two
    // different pictures.
    //
    // The invariant belongs here rather than in the tick order, because a morph
    // can be started from a MIDI note, a pad, a Take replay or the Looks panel,
    // and all of them deserve the same guarantee.
    if (this.active !== null && (this.progressAt(atTime) ?? 0) >= 1) {
      this.complete(atTime);
    }
    const { project } = useProjectStore.getState();
    const look = project.pinnedLooks.find((l) => l.id === targetLookId);
    const document = captureLookCore(project);
    if (!look || !document) return false;
    const { bpm, beatOffsetSec, beatsPerBar } = project.timeline;
    const startTime = nextBoundary(atTime, options.startQuantize, bpm, beatOffsetSec, beatsPerBar);
    const endTime = startTime + this.resolveDurationSec(options.duration);
    /**
     * A morph that INTERRUPTS another starts from what is on screen.
     *
     * The document is the wrong source while a morph is in flight: numeric
     * state deliberately lives in the overlay and never touches the document
     * until commit, so taking the document meant the picture snapped back to
     * where the interrupted morph began. Measured on a plain two-second morph
     * interrupted by hand at the halfway point: the value fell 5.62 to 2.00 in
     * one frame, then climbed toward the new target. Changing your mind
     * mid-morph is the most ordinary live gesture there is.
     *
     * Resolved at `startTime`, not at `atTime`, because a quantized morph
     * begins at the next boundary and the outgoing one keeps running until
     * then. `cancelKeep` already commits `resolveOverlay` for the same reason:
     * the overlay is the state a performer would say they are looking at.
     */
    const source =
      this.active !== null ? (this.resolveOverlay(startTime) ?? document) : document;
    this.active = {
      targetLookId,
      targetLabel: look.label,
      source,
      target: lookToCore(look),
      startTime,
      endTime,
      curve: options.curve,
      record: options.record ?? true,
    };
    this.transitionGeneration++;
    this.committedSide = -1;
    // A morph owns the overlay from here: drop any candidate audition so the
    // performer never has two "not the document" states at once.
    void import('@/performance/candidateRuntime').then(({ candidateRuntime }) =>
      candidateRuntime.setPreview(false),
    );
    return true;
  }

  /**
   * Progress 0..1 (pre-curve) at composition time t; null when idle OR when
   * the playhead has not reached the morph yet.
   *
   * The "not yet" case matters: a morph is a timeline event at absolute
   * times. Clamping `t < startTime` to progress 0 meant that seeking or
   * looping backwards past an armed morph pinned the composition to the
   * morph's SOURCE snapshot forever — the zombie morph. Returning null
   * instead shows the document until the playhead reaches the morph again,
   * which is exactly what the export evaluator already does (it overlays
   * only inside [startTime, endTime)).
   */
  progressAt(t: number): number | null {
    if (!this.active) return null;
    const { startTime, endTime } = this.active;
    if (t < startTime) return null;
    if (endTime <= startTime) return 1;
    return Math.min((t - startTime) / (endTime - startTime), 1);
  }

  /**
   * The interpolated core at time t, or null when idle. Pure — safe for any
   * t in any order.
   */
  resolveOverlay(t: number): LookCore | null {
    if (!this.active) return null;
    const raw = this.progressAt(t);
    if (raw === null) return null;
    const p = morphCurve(raw, this.active.curve);
    const { core, stats } = interpolateLookCore(
      this.active.source,
      this.active.target,
      p,
      switchPoint(this.hasPixelTransition),
    );
    this.lastStats = stats;
    return core;
  }

  /**
   * Called from the playback tick and before offscreen renders: keeps the
   * store's technique/material identity on the correct side of the midpoint
   * (renderer + material textures follow the store), and commits the target
   * when playback crosses the end.
   */
  tick(t: number): void {
    if (!this.active) {
      if (this.snapshotTaken) {
        this.snapshotTaken = false;
        engine.setTransition(null); // cancel/complete → release resources
      }
      return;
    }
    const raw = this.progressAt(t);
    if (raw === null) return;

    // CE1G: the snapshot is taken when the reveal is ARMED — i.e. at real
    // activation, never when a future morph is merely scheduled (that would
    // resurrect the zombie). Then the compositor drives every frame from
    // resolved progress.
    const tp = this.transitionProgressAt(t);
    if (tp !== null) {
      if (!this.snapshotTaken && tp <= 0) {
        engine.captureTransitionSnapshot();
        this.snapshotTaken = true;
      }
      if (this.snapshotTaken && tp > 0 && tp < 1) {
        engine.setTransition({ progress: tp, params: this.transition });
      } else if (tp >= 1 && this.snapshotTaken) {
        this.snapshotTaken = false;
        engine.setTransition(null);
      }
    }

    if (raw >= 1) {
      this.complete(t);
      return;
    }

    const p = morphCurve(raw, this.active.curve);
    // The identity switch sits at the reveal's OPENING when a pixel
    // transition covers it, so the snapshot (taken just above, at tp <= 0)
    // holds the outgoing frame instead of the mask popping mid-reveal.
    const side: -1 | 1 = p < switchPoint(this.hasPixelTransition) ? -1 : 1;
    if (side !== this.committedSide) {
      this.committedSide = side;
      const identity = side < 0 ? this.active.source : this.active.target;
      useProjectStore.getState().applySilent((proj) => ({
        ...proj,
        layers: proj.layers.map((l) =>
          l.id === selectedLayerOf(proj).id
            ? {
                ...l,
                technique: {
                  id: l.technique?.id ?? uid('tech'),
                  techniqueId: identity.techniqueId,
                  enabled: true,
                  params: l.technique?.params ?? identity.params,
                },
                ...(identity.techniqueChain ? {
                  techniqueChain: identity.techniqueChain.map((stage) => ({ ...stage, params: { ...stage.params } })),
                } : {}),
              }
            : l,
        ),
        material: {
          ...identity.material,
          params: proj.material.params,
        },
      }));
    }
  }

  /** Playback crossed the end: commit target as ONE undo entry + record event. */
  private complete(atTime: number): void {
    const morph = this.active;
    if (!morph) return;
    this.active = null;
    this.snapshotTaken = false;
    engine.setTransition(null);
    if (!morph.record) {
      // A Take owns this morph's record. Land the target state so the
      // composition is where the performance left it, then say nothing:
      // no history entry, no undo entry, no dirty flag (§76).
      useProjectStore.getState().applySilent((p) => {
        const target = p.pinnedLooks.find((l) => l.id === morph.targetLookId) ?? null;
        const stacked = target ? projectWithLayerLooks(p, target) : p;
        return projectWithLookCore(stacked, morph.target, morph.targetLookId);
      });
      return;
    }
    useProjectStore.getState().apply((p) => {
      // v0.6D — only the PRIMARY layer interpolates. A morph is a continuous
      // blend between two states of one material, and there is no meaningful
      // interpolation between "three layers" and "two layers": the stack is
      // structure, not a value. So the rest of the target's composition
      // arrives at the end, in the same atomic commit as the interpolated
      // layer, and the performer sees one change rather than a half-morphed
      // stack settling piece by piece.
      const target = p.pinnedLooks.find((l) => l.id === morph.targetLookId) ?? null;
      const stacked = target ? projectWithLayerLooks(p, target) : p;
      return {
      ...projectWithLookCore(stacked, morph.target, morph.targetLookId),
      morphEvents: [
        ...p.morphEvents,
        {
          id: uid('morph'),
          startTime: morph.startTime,
          endTime: morph.endTime,
          curve: morph.curve,
          sourceSnapshot: morph.source,
          targetLookId: morph.targetLookId,
          transition: { ...this.transition },
        },
      ],
      };
    });
    useUiStore.getState().pushToast('info', `Morph complete → ${morph.targetLabel}`);
    void (atTime);
  }

  /** Cancel-and-keep (§25): freeze the interpolated state as the new state. */
  cancelKeep(atTime = playback.getTime()): void {
    const morph = this.active;
    if (!morph) return;
    this.snapshotTaken = false;
    engine.setTransition(null);
    const overlay = this.resolveOverlay(atTime);
    this.active = null;
    if (!overlay) return;
    if (!morph.record) {
      useProjectStore.getState().applySilent((p) => projectWithLookCore(p, overlay, null));
      return;
    }
    useProjectStore.getState().apply((p) => ({
      ...projectWithLookCore(p, overlay, null),
      morphEvents: [
        ...p.morphEvents,
        {
          id: uid('morph'),
          startTime: morph.startTime,
          endTime: Math.min(Math.max(atTime, morph.startTime), morph.endTime),
          curve: morph.curve,
          sourceSnapshot: morph.source,
          targetLookId: morph.targetLookId,
          transition: { ...this.transition },
        },
      ],
    }));
    useUiStore.getState().pushToast('info', 'Morph cancelled — keeping current state');
  }

  /** Drop the overlay without committing (undo/redo, project switch). */
  abortSilently(): void {
    this.active = null;
  }
}

export const morphRuntime = new MorphRuntime();

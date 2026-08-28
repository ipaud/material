import { create } from 'zustand';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { engine } from '@/rendering/RenderEngine';
import { playback } from '@/playback/PlaybackController';
import { getTriggerState, liveScheduler } from '@/signals/triggerRuntime';
import { morphRuntime } from '@/performance/morphRuntime';
import { captureLookCore, projectWithLookCore } from '@/performance/lookCore';
import { mutateLookCore, type MutationIntensity, type MutationLocks, type MutationMetadata } from '@/performance/mutation';
import { getTechnique } from '@/techniques/registry';
import { uid } from '@/utils/id';
import type { LookCore, PinnedLook, TriggerMapping } from '@shared/schemas/project';

/**
 * CURRENT / CANDIDATE (Phase 16).
 *
 * CURRENT is the committed project state — the thing on output.
 * CANDIDATE is a generated mutation held ENTIRELY outside the project: it
 * lives in this runtime, never in the store, and can be auditioned,
 * regenerated, mutated further, pinned or applied.
 *
 * Preview isolation works exactly like the morph overlay: `resolveOverlay`
 * is a pure function returning the candidate's core, consumed by the
 * modulation runtime for rendering only. Nothing writes to the document, so
 * releasing preview restores CURRENT — including its freeze state — by
 * construction rather than by save/restore bookkeeping.
 *
 * Discrete trigger ACTIONS keep running against CURRENT while previewing:
 * the scheduler is fed from `project.triggers` by the engine bridge and this
 * runtime never touches it. Only the visual layers (pulses, modulation) see
 * candidate topology.
 */

export interface Candidate {
  id: string;
  /** Look the parent state came from, when CURRENT had one active. */
  parentLookId: string | null;
  parentSeed: number;
  seed: number;
  core: LookCore;
  metadata: MutationMetadata;
  thumbnail: string | null;
  /** Candidate this one was mutated from (MUTATE AGAIN lineage). */
  parentCandidateId: string | null;
  label: string;
}

interface CandidateUiState {
  candidate: Candidate | null;
  previewing: boolean;
  /** Candidate id whose apply is queued on the scheduler, if any. */
  queuedId: string | null;
  intensity: MutationIntensity;
  locks: MutationLocks;
}

const THUMB_WIDTH = 220;

export const useCandidateStore = create<CandidateUiState>(() => ({
  candidate: null,
  previewing: false,
  queuedId: null,
  intensity: 'med',
  locks: { technique: false, material: false, timing: false, signals: false, color: false },
}));

/** Deterministic label from the seed — recognisable, never "Variation 3". */
function candidateLabel(seed: number): string {
  return `MUTATION ${String(seed % 10000).padStart(4, '0')}`;
}

function renderCandidateThumbnail(core: LookCore): string | null {
  try {
    const { project } = useProjectStore.getState();
    if (!project.composition.sourceId) return null;
    const aspect = project.composition.width / project.composition.height;
    const h = Math.max(Math.round(THUMB_WIDTH / aspect), 16);
    const pixels = engine.renderStill(THUMB_WIDTH, h, core.params);
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_WIDTH;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), THUMB_WIDTH, h), 0, 0);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return null;
  }
}

class CandidateRuntime {
  private candidate: Candidate | null = null;
  private previewing = false;
  private queuedId: string | null = null;
  /** Monotonic counter so successive generates never repeat a seed. */
  private seedCounter = 1;

  get current(): Candidate | null {
    return this.candidate;
  }

  get isPreviewing(): boolean {
    return this.previewing && this.candidate !== null;
  }

  private sync(): void {
    useCandidateStore.setState({
      candidate: this.candidate,
      previewing: this.previewing,
      queuedId: this.queuedId,
    });
  }

  /** MUTATE is unavailable while a morph is running (§19). */
  get blockedReason(): string | null {
    if (morphRuntime.current) return 'MUTATE unavailable during Morph';
    const { project } = useProjectStore.getState();
    if (!project.techniques.some((t) => t.enabled)) return 'No technique to mutate';
    return null;
  }

  /**
   * Generate a candidate. Parent is CURRENT by default (§12); `fromCandidate`
   * takes the existing candidate as parent instead (MUTATE AGAIN, §13).
   */
  generate(options: { fromCandidate?: boolean } = {}): Candidate | null {
    const blocked = this.blockedReason;
    if (blocked) {
      useUiStore.getState().pushToast('info', blocked);
      return null;
    }
    const { project } = useProjectStore.getState();
    const fromCandidate = options.fromCandidate === true && this.candidate !== null;
    const parentCore = fromCandidate
      ? (this.candidate as Candidate).core
      : captureLookCore(project);
    if (!parentCore) return null;
    const definition = getTechnique(parentCore.techniqueId);
    if (!definition) return null;

    const { intensity, locks } = useCandidateStore.getState();
    const seed = deriveCandidateSeed(parentCore.seed, this.seedCounter++);
    const generation = fromCandidate ? (this.candidate as Candidate).metadata.generation + 1 : 1;
    const { core, metadata } = mutateLookCore(
      parentCore,
      definition,
      seed,
      intensity,
      locks,
      generation,
    );

    // Regenerating invalidates any queued apply of the previous candidate.
    this.cancelQueued();

    this.candidate = {
      id: uid('cand'),
      parentLookId: fromCandidate
        ? (this.candidate as Candidate).parentLookId
        : project.activeLookId,
      parentSeed: parentCore.seed,
      seed,
      core,
      metadata,
      thumbnail: renderCandidateThumbnail(core),
      parentCandidateId: fromCandidate ? (this.candidate as Candidate).id : null,
      label: candidateLabel(seed),
    };
    this.sync();
    return this.candidate;
  }

  /** Re-render the candidate thumbnail from the current playhead frame (§21). */
  rethumbnail(): void {
    if (!this.candidate) return;
    this.candidate = { ...this.candidate, thumbnail: renderCandidateThumbnail(this.candidate.core) };
    this.sync();
  }

  setPreview(on: boolean): void {
    if (on && !this.candidate) return;
    if (this.previewing === on) return;
    this.previewing = on;
    engine.invalidate();
    this.sync();
  }

  /**
   * The core to render at composition time t, or null when CURRENT should
   * render. Pure — no document access, no side effects.
   */
  resolveOverlay(): LookCore | null {
    if (!this.previewing || !this.candidate) return null;
    return this.candidate.core;
  }

  /** Candidate triggers, for VISUAL pulse evaluation during preview only. */
  previewTriggers(): TriggerMapping[] | null {
    return this.isPreviewing ? (this.candidate as Candidate).core.triggers : null;
  }

  /**
   * Apply the candidate as CURRENT. Honors the global performance
   * quantization: immediate when OFF or ungridded, otherwise queued on the
   * ONE scheduler and committed exactly on the boundary.
   */
  apply(): boolean {
    const candidate = this.candidate;
    if (!candidate) return false;
    const { project } = useProjectStore.getState();
    const quantize = project.timeline.bpm ? project.performanceQuantize : 'off';
    if (quantize === 'off') {
      this.commit(candidate.id);
      return true;
    }
    const { ctx } = getTriggerState();
    this.queuedId = candidate.id;
    liveScheduler.fireLive(
      {
        id: `perf-candidate-${candidate.id}`,
        enabled: true,
        source: 'manual',
        action: 'applyCandidate',
        targetParam: null,
        targetMappingId: null,
        lookSlot: null,
        quantize,
        cooldownSec: 0,
        attackSec: 0.01,
        holdSec: 0,
        decaySec: 0.18,
        amount: 0.35,
        curve: 'easeOut',
      },
      playback.getTime(),
      ctx,
    );
    this.sync();
    return true;
  }

  /**
   * Commit — called immediately or by the scheduler at the boundary. The
   * candidate id guard makes a STALE queued apply impossible: if the
   * candidate was regenerated or discarded meanwhile, nothing happens.
   */
  commit(candidateId?: string): void {
    const candidate = this.candidate;
    if (!candidate) return;
    if (candidateId !== undefined && candidateId !== candidate.id) return;
    if (this.queuedId !== null && candidateId !== undefined && this.queuedId !== candidate.id) {
      return;
    }
    // Atomic single-undo apply, exactly like a look apply. activeLookId is
    // preserved so the tile shows MODIFIED rather than silently rebinding.
    useProjectStore
      .getState()
      .apply((p) => projectWithLookCore(p, candidate.core, p.activeLookId));
    this.previewing = false;
    this.queuedId = null;
    this.candidate = null;
    this.sync();
    useUiStore.getState().pushToast('info', `Applied ${candidate.label}`);
  }

  /** Pin the candidate as a normal Look WITHOUT changing output (§10). */
  pin(): PinnedLook | null {
    const candidate = this.candidate;
    if (!candidate) return null;
    const { project } = useProjectStore.getState();
    let slot: number | null = null;
    for (let s = 1; s <= 9; s++) {
      if (!project.pinnedLooks.some((l) => l.slot === s)) {
        slot = s;
        break;
      }
    }
    const look: PinnedLook = {
      id: uid('look'),
      createdAt: new Date().toISOString(),
      label: candidate.label,
      note: `seed ${candidate.seed} · gen ${candidate.metadata.generation}`,
      slot,
      seed: candidate.core.seed,
      thumbnail: candidate.thumbnail,
      techniques: [
        {
          id: uid('tech'),
          techniqueId: candidate.core.techniqueId,
          enabled: true,
          params: { ...candidate.core.params },
        },
      ],
      material: candidate.core.material,
      modulations: candidate.core.modulations.map((m) => ({ ...m })),
      triggers: candidate.core.triggers.map((t) => ({ ...t })),
    };
    useProjectStore.getState().apply((p) => ({ ...p, pinnedLooks: [...p.pinnedLooks, look] }));
    useUiStore
      .getState()
      .pushToast('info', slot ? `Pinned ${look.label} → slot ${slot}` : `Pinned ${look.label}`);
    return look;
  }

  discard(): void {
    if (!this.candidate) return;
    this.cancelQueued();
    this.candidate = null;
    this.previewing = false;
    engine.invalidate();
    this.sync();
  }

  /**
   * Drop any queued apply without firing it (regenerate / discard / Esc).
   * Unconditional on purpose: the scheduler is the source of truth, and an
   * orphaned entry — left by a reset, an undo, or a project switch — must be
   * swept even when this runtime no longer thinks it queued anything.
   */
  cancelQueued(): void {
    liveScheduler.cancelPendingWhere((m) => m.action === 'applyCandidate');
    if (this.queuedId !== null) {
      this.queuedId = null;
      this.sync();
    }
  }

  /** Project switch / undo / redo: the candidate's parent state is gone. */
  reset(): void {
    this.cancelQueued();
    this.candidate = null;
    this.previewing = false;
    this.queuedId = null;
    this.sync();
  }
}

/** Stable, collision-resistant candidate seed from parent + counter. */
function deriveCandidateSeed(parentSeed: number, counter: number): number {
  let h = (parentSeed ^ (counter * 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export const candidateRuntime = new CandidateRuntime();

export function setMutationIntensity(intensity: MutationIntensity): void {
  useCandidateStore.setState({ intensity });
}

export function toggleMutationLock(key: keyof MutationLocks): void {
  useCandidateStore.setState((s) => ({ locks: { ...s.locks, [key]: !s.locks[key] } }));
}

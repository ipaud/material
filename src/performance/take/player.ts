import type { PerformanceTake } from '@shared/schemas/project';
import { modulationRuntime } from '@/modulation/runtime';
import {
  replayDiscreteBetween,
  replayDiscreteUpTo,
  resolveTakeAt,
  type ResolvedTake,
} from './evaluate';
import { livePerformer } from './livePerformer';

/**
 * v0.7B — Take playback in the editor.
 *
 * Two different questions, answered by two different functions, which is the
 * distinction the whole replay design turns on (§45/§46):
 *
 *   tick()   the playhead moved from a to b — dispatch what it CROSSED. A
 *            Look recall must fire once, not once per frame.
 *   seek()   the playhead teleported — there is no previous frame to have
 *            crossed anything, so RECONSTRUCT from the Take origin.
 *
 * Continuous lanes need neither: they are a pure function of t, resolved
 * fresh every frame and handed to the modulation runtime as the BASE, at the
 * exact seam a human drag writes to (§56). Take → macros → modulation →
 * pulses → clamp, unchanged.
 */
class TakePlayer {
  private take: PerformanceTake | null = null;
  private playing = false;
  private lastTime: number | null = null;

  get isPlaying(): boolean {
    return this.playing;
  }

  get activeTake(): PerformanceTake | null {
    return this.playing ? this.take : null;
  }

  /** Begin replaying, reconstructing state at the current playhead. */
  start(take: PerformanceTake, compositionSec: number): void {
    this.take = take;
    this.playing = true;
    this.lastTime = compositionSec;
    replayDiscreteUpTo(take, compositionSec, livePerformer);
    this.publish(compositionSec);
  }

  /**
   * Stop. The visual state STAYS where the playhead left it (§117) — the
   * performer stopped the Take to take over from there, and yanking the
   * composition back would undo the thing they were about to keep. Restoring
   * the baseline is what starting from the beginning does, not what stopping
   * does.
   */
  stop(): void {
    this.playing = false;
    this.lastTime = null;
    modulationRuntime.setTakeState(null);
  }

  /** Project switch / take deleted: drop everything, restore nothing. */
  reset(): void {
    this.take = null;
    this.stop();
  }

  seek(compositionSec: number): void {
    if (!this.playing || !this.take) return;
    replayDiscreteUpTo(this.take, compositionSec, livePerformer);
    this.lastTime = compositionSec;
    this.publish(compositionSec);
  }

  tick(compositionSec: number): void {
    if (!this.playing || !this.take) return;
    const from = this.lastTime;
    if (from === null || compositionSec < from) {
      // Backwards means a loop wrap or an un-announced seek; reconstruct
      // rather than replaying a negative interval.
      this.seek(compositionSec);
      return;
    }
    replayDiscreteBetween(this.take, from, compositionSec, livePerformer);
    this.lastTime = compositionSec;
    this.publish(compositionSec);
  }

  /** The Take's continuous state right now, for UI readouts. */
  resolvedAt(compositionSec: number): ResolvedTake | null {
    if (!this.playing || !this.take) return null;
    return resolveTakeAt(this.take, compositionSec);
  }

  private publish(compositionSec: number): void {
    if (!this.take) return;
    modulationRuntime.setTakeState(resolveTakeAt(this.take, compositionSec));
  }
}

export const takePlayer = new TakePlayer();

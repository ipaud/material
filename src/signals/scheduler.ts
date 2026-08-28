import type { QuantizeMode, TriggerMapping } from '@shared/schemas/project';
import { nextBoundary } from './quantize';
import {
  applyCooldown,
  eventTimesBetween,
  isDeterministicSource,
  type TriggerContext,
} from './triggerSources';
import { envelopeDuration, envelopeValue } from './envelope';

/**
 * Discrete trigger actions (freeze, looks, resets…) mutate state, so unlike
 * pulses they need execution. The scheduler advances through composition time
 * in intervals: every deterministic event in (lastTime, now] fires exactly
 * once. The SAME class drives preview (playback tick) and export (frame
 * loop) — only the ActionTarget differs.
 *
 * Seek safety: reset(t) drops interval state and every pending quantized
 * action — events from before a seek can never fire after it.
 */

export interface ActionTarget {
  freeze(mappingId: string | null): void; // null/'*' → all
  unfreeze(mappingId: string | null): void;
  toggleFreeze(mappingId: string | null): void;
  pinLook(): void;
  applyLook(slot: number): void;
  nextLook(): void;
  prevLook(): void;
  resetParam(paramId: string): void;
  toggleMapping(mappingId: string): void;
  /** Start a morph from the current state to the look in `slot` (§18). */
  morphToLook(slot: number, atTime: number): void;
}

interface PendingAction {
  /** The mapping object itself — live-fired (e.g. MIDI) mappings are
   * synthesized and absent from the configured trigger list. */
  mapping: TriggerMapping;
  executeAt: number;
}

export interface SchedulerDiagnostics {
  lastTriggerSource: string | null;
  lastTriggerTime: number | null;
  pendingCount: number;
}

export interface LivePulse {
  targetParam: string;
  firedAt: number;
  mapping: TriggerMapping;
}

export class TriggerScheduler {
  private lastTime: number | null = null;
  private pending: PendingAction[] = [];
  private lastFiredAt = new Map<string, number>();
  /** Envelopes from live (manual/keyboard) pulse triggers. */
  private livePulses: LivePulse[] = [];
  private diag: SchedulerDiagnostics = {
    lastTriggerSource: null,
    lastTriggerTime: null,
    pendingCount: 0,
  };

  constructor(private readonly target: ActionTarget) {}

  /** Drop everything tied to the old position (seek / loop restart / stop). */
  reset(timeSec: number | null = null): void {
    this.lastTime = timeSec;
    this.pending = [];
    this.livePulses = [];
    this.lastFiredAt.clear();
  }

  getDiagnostics(): SchedulerDiagnostics {
    return { ...this.diag, pendingCount: this.pending.length };
  }

  /** Pending quantized actions (performance UI shows what is queued). */
  getPending(): { mapping: TriggerMapping; executeAt: number }[] {
    return this.pending.map((p) => ({ mapping: p.mapping, executeAt: p.executeAt }));
  }

  /** Cancel queued quantized actions without touching interval state (Esc). */
  cancelPending(): void {
    this.pending = [];
    this.diag = { ...this.diag, pendingCount: 0 };
  }

  /** Live pulse envelopes' current contribution per target param (signed). */
  livePulseContributions(t: number): Map<string, number> {
    const out = new Map<string, number>();
    this.livePulses = this.livePulses.filter(
      (p) => t - p.firedAt <= envelopeDuration(p.mapping) && t >= p.firedAt - 1e-6,
    );
    for (const p of this.livePulses) {
      const v = envelopeValue(t - p.firedAt, p.mapping) * p.mapping.amount;
      if (v !== 0) out.set(p.targetParam, (out.get(p.targetParam) ?? 0) + v);
    }
    return out;
  }

  /**
   * Advance to composition time `now`, firing every deterministic event in
   * (lastTime, now] plus any pending quantized action that has come due.
   * Monotonic only: a backwards `now` means a seek happened — callers must
   * reset() instead (PlaybackController.seek does).
   */
  advanceTo(now: number, triggers: TriggerMapping[], ctx: TriggerContext): void {
    if (this.lastTime === null) {
      // First tick after a reset: establish the interval start; nothing from
      // an unknown past may fire.
      this.lastTime = now;
      return;
    }
    if (now < this.lastTime) {
      this.reset(now);
      return;
    }
    const t0 = this.lastTime;
    this.lastTime = now;

    // Fire due pending (quantized) actions first, in time order.
    this.pending.sort((a, b) => a.executeAt - b.executeAt);
    const stillPending: PendingAction[] = [];
    for (const p of this.pending) {
      if (p.executeAt <= now + 1e-9) {
        // Deterministic mappings re-resolve against the configured list (they
        // may have been edited/disabled); synthesized live mappings execute
        // as fired.
        const mapping = triggers.find((m) => m.id === p.mapping.id) ?? p.mapping;
        if (mapping.enabled) this.execute(mapping, p.executeAt);
      } else {
        stillPending.push(p);
      }
    }
    this.pending = stillPending;

    // Deterministic discrete events in the interval.
    for (const mapping of triggers) {
      if (!mapping.enabled || mapping.action === 'pulse') continue;
      if (!isDeterministicSource(mapping.source)) continue;
      let events = eventTimesBetween(mapping.source, t0, now, ctx);
      if (mapping.cooldownSec > 0) {
        const last = this.lastFiredAt.get(mapping.id);
        if (last !== undefined) events = events.filter((t) => t - last >= mapping.cooldownSec);
        events = applyCooldown(events, mapping.cooldownSec);
      }
      for (const eventTime of events) {
        this.scheduleOrExecute(mapping, eventTime, ctx);
      }
    }
  }

  /**
   * Live trigger (manual button now, keyboard/MIDI later): quantization
   * decides whether it runs immediately or at the next musical boundary.
   */
  fireLive(mapping: TriggerMapping, now: number, ctx: TriggerContext): void {
    if (!mapping.enabled) return;
    const last = this.lastFiredAt.get(mapping.id);
    if (last !== undefined && now - last < mapping.cooldownSec) return;
    this.scheduleOrExecute(mapping, now, ctx);
  }

  private scheduleOrExecute(mapping: TriggerMapping, eventTime: number, ctx: TriggerContext): void {
    const executeAt = nextBoundary(
      eventTime,
      mapping.quantize as QuantizeMode,
      ctx.bpm,
      ctx.beatOffsetSec,
      ctx.beatsPerBar,
    );
    if (executeAt > eventTime + 1e-9) {
      this.pending.push({ mapping, executeAt });
      this.diag = { ...this.diag, pendingCount: this.pending.length };
      return;
    }
    this.execute(mapping, eventTime);
  }

  private execute(mapping: TriggerMapping, atTime: number): void {
    this.lastFiredAt.set(mapping.id, atTime);
    this.diag = {
      lastTriggerSource: mapping.source,
      lastTriggerTime: atTime,
      pendingCount: this.pending.length,
    };
    switch (mapping.action) {
      case 'pulse':
        // Live-source pulses become tracked envelopes (deterministic-source
        // pulses never reach the scheduler — the pure evaluator owns them).
        if (mapping.targetParam) {
          this.livePulses.push({ targetParam: mapping.targetParam, firedAt: atTime, mapping });
        }
        return;
      case 'freeze':
        this.target.freeze(mapping.targetMappingId);
        return;
      case 'unfreeze':
        this.target.unfreeze(mapping.targetMappingId);
        return;
      case 'toggleFreeze':
        this.target.toggleFreeze(mapping.targetMappingId);
        return;
      case 'pinLook':
        this.target.pinLook();
        return;
      case 'applyLook':
        if (mapping.lookSlot !== null) this.target.applyLook(mapping.lookSlot);
        return;
      case 'nextLook':
        this.target.nextLook();
        return;
      case 'prevLook':
        this.target.prevLook();
        return;
      case 'resetParam':
        if (mapping.targetParam) this.target.resetParam(mapping.targetParam);
        return;
      case 'toggleMapping':
        if (mapping.targetMappingId) this.target.toggleMapping(mapping.targetMappingId);
        return;
      case 'morphToLook':
        if (mapping.lookSlot !== null) this.target.morphToLook(mapping.lookSlot, atTime);
        return;
    }
  }
}

import { describe, expect, test } from 'vitest';
import { nextBoundary } from '@/signals/quantize';
import { beatsAt, beatTimes, musicalPosition } from '@/audio/beatGrid';
import { TriggerScheduler, type ActionTarget } from '@/signals/scheduler';
import { eventTimesBetween, type TriggerContext } from '@/signals/triggerSources';
import type { TriggerMapping } from '@shared/schemas/project';

/**
 * Phase 17 §17: musical edge cases. The rule these all defend is the one the
 * whole trigger engine rests on — every deterministic event in a half-open
 * interval fires exactly once, no matter how the intervals are cut.
 */

function ctxAt(bpm: number, beatsPerBar = 4, beatOffsetSec = 0): TriggerContext {
  return { bpm, beatOffsetSec, beatsPerBar, analysis: null, markers: [] };
}

function trigger(patch: Partial<TriggerMapping> = {}): TriggerMapping {
  return {
    id: 'trig-1',
    enabled: true,
    source: 'beat',
    action: 'freeze',
    targetParam: null,
    targetMappingId: '*',
    lookSlot: null,
    quantize: 'off',
    cooldownSec: 0,
    attackSec: 0,
    holdSec: 0,
    decaySec: 0.2,
    amount: 0.3,
    curve: 'easeOut',
    ...patch,
  };
}

function recorder(): { target: ActionTarget; log: string[] } {
  const log: string[] = [];
  const target: ActionTarget = {
    freeze: () => log.push('freeze'),
    unfreeze: () => log.push('unfreeze'),
    toggleFreeze: () => log.push('toggleFreeze'),
    pinLook: () => log.push('pinLook'),
    applyLook: (slot) => log.push(`applyLook:${slot}`),
    nextLook: () => log.push('nextLook'),
    prevLook: () => log.push('prevLook'),
    resetParam: (p) => log.push(`resetParam:${p}`),
    toggleMapping: (id) => log.push(`toggleMapping:${id}`),
    applyCandidate: () => log.push('applyCandidate'),
    morphToLook: (slot) => log.push(`morphToLook:${slot}`),
  };
  return { target, log };
}

/** Fire every beat between t0 and t1, walking in `step` chunks. */
function runInterval(bpm: number, t0: number, t1: number, step: number, beatsPerBar = 4) {
  const { target, log } = recorder();
  const scheduler = new TriggerScheduler(target);
  const ctx = ctxAt(bpm, beatsPerBar);
  scheduler.reset(t0);
  for (let t = t0; t <= t1 + 1e-9; t += step) {
    scheduler.advanceTo(t, [trigger()], ctx);
  }
  return log;
}

describe('tempo extremes', () => {
  test.each([60, 78.03, 90, 120, 127.72, 200])('beats are exact and unique at %d BPM', (bpm) => {
    const beatSec = 60 / bpm;
    const span = 20;
    const expected = Math.floor(span / beatSec);
    // Walk in an irregular step so beats never align with frame boundaries.
    const log = runInterval(bpm, 0, span, 0.0173);
    expect(log.length).toBeGreaterThanOrEqual(expected - 1);
    expect(log.length).toBeLessThanOrEqual(expected + 1);
  });

  test('frame-size changes never duplicate or drop a beat', () => {
    const bpm = 127.72;
    const coarse = runInterval(bpm, 0, 12, 1 / 24);
    const fine = runInterval(bpm, 0, 12, 1 / 240);
    expect(coarse.length).toBe(fine.length);
  });

  test('fractional BPM keeps the grid stable over many bars', () => {
    const bpm = 78.03;
    const beats = beatTimes(0, 60, bpm, 0);
    for (let i = 1; i < beats.length; i++) {
      expect(beats[i]! - beats[i - 1]!).toBeCloseTo(60 / bpm, 9);
    }
  });
});

describe('time signatures', () => {
  test.each([
    [3, 'BAR 2 · BEAT 1 at three beats in'],
    [4, 'BAR 2 · BEAT 1 at four beats in'],
    [6, 'BAR 2 · BEAT 1 at six beats in'],
  ])('%d beats per bar rolls the bar correctly', (beatsPerBar) => {
    const bpm = 120;
    const beatSec = 60 / bpm;
    const atBarTwo = musicalPosition(beatsPerBar * beatSec + 1e-6, bpm, 0, beatsPerBar);
    expect(atBarTwo.bar).toBe(2);
    expect(atBarTwo.beat).toBe(1);
    const lastBeatOfBarOne = musicalPosition((beatsPerBar - 1) * beatSec + 1e-6, bpm, 0, beatsPerBar);
    expect(lastBeatOfBarOne.bar).toBe(1);
    expect(lastBeatOfBarOne.beat).toBe(beatsPerBar);
  });

  test('bar quantization follows the time signature', () => {
    const bpm = 120; // beat = 0.5s
    expect(nextBoundary(0.1, 'bar', bpm, 0, 4)).toBeCloseTo(2);
    expect(nextBoundary(0.1, 'bar', bpm, 0, 3)).toBeCloseTo(1.5);
    expect(nextBoundary(0.1, 'bar', bpm, 0, 6)).toBeCloseTo(3);
  });
});

describe('beat offset', () => {
  test('positive and negative offsets shift the grid without breaking it', () => {
    const bpm = 120;
    for (const offset of [-0.25, -0.05, 0, 0.021, 0.37]) {
      const beats = beatTimes(0, 10, bpm, offset);
      for (const t of beats) {
        // Every beat sits on the offset grid.
        const k = (t - offset) / (60 / bpm);
        expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
      }
    }
  });

  test('negative offset never yields a bar before 1', () => {
    const pos = musicalPosition(0, 120, -0.4, 4);
    expect(pos.bar).toBeGreaterThanOrEqual(1);
    expect(pos.beat).toBeGreaterThanOrEqual(1);
  });

  test('quantized boundary respects the offset', () => {
    const bpm = 120;
    const boundary = nextBoundary(0.3, 'beat', bpm, 0.1, 4);
    expect(boundary).toBeCloseTo(0.6); // 0.1 + 0.5
  });
});

describe('boundary-adjacent events', () => {
  const bpm = 120; // beat = 0.5s
  const ctx = ctxAt(bpm);

  test('an event exactly on the boundary belongs to exactly one interval', () => {
    // Half-open (t0, t1]: 0.5 belongs to the interval ending at 0.5.
    expect(eventTimesBetween('beat', 0.0, 0.5, ctx)).toContain(0.5);
    expect(eventTimesBetween('beat', 0.5, 1.0, ctx)).not.toContain(0.5);
  });

  test('one frame before and one frame after a beat', () => {
    const frame = 1 / 60;
    const justBefore = eventTimesBetween('beat', 0.5 - 2 * frame, 0.5 - frame, ctx);
    const spanning = eventTimesBetween('beat', 0.5 - frame, 0.5 + frame, ctx);
    const justAfter = eventTimesBetween('beat', 0.5 + frame, 0.5 + 2 * frame, ctx);
    expect(justBefore).toHaveLength(0);
    expect(spanning).toHaveLength(1);
    expect(justAfter).toHaveLength(0);
  });

  test('quantizing a time already on a boundary does not push it forward', () => {
    expect(nextBoundary(2, 'bar', bpm, 0, 4)).toBeCloseTo(2);
    expect(nextBoundary(0.5, 'beat', bpm, 0, 4)).toBeCloseTo(0.5);
  });

  test('seeking onto an exact boundary does not double-fire', () => {
    const { target, log } = recorder();
    const scheduler = new TriggerScheduler(target);
    scheduler.reset(0);
    scheduler.advanceTo(0.49, [trigger()], ctx);
    expect(log).toHaveLength(0);
    // Seek exactly to the beat, then continue.
    scheduler.reset(0.5);
    scheduler.advanceTo(0.51, [trigger()], ctx);
    scheduler.advanceTo(0.99, [trigger()], ctx);
    expect(log).toHaveLength(0); // the 0.5 beat was seeked ONTO, not crossed
    scheduler.advanceTo(1.01, [trigger()], ctx);
    expect(log).toHaveLength(1); // the 1.0 beat crossed exactly once
  });

  test('loop restart replays the loop start without duplicating the endpoint', () => {
    const { target, log } = recorder();
    const scheduler = new TriggerScheduler(target);
    scheduler.reset(0);
    scheduler.advanceTo(1.9, [trigger()], ctx); // beats at 0.5, 1.0, 1.5
    const beforeLoop = log.length;
    expect(beforeLoop).toBe(3);
    // Loop back to 0: reset() drops history so the pass replays cleanly.
    scheduler.reset(0);
    scheduler.advanceTo(0.6, [trigger()], ctx);
    expect(log.length).toBe(beforeLoop + 1);
  });

  test('backwards time resets instead of firing a negative interval', () => {
    const { target, log } = recorder();
    const scheduler = new TriggerScheduler(target);
    scheduler.reset(5);
    scheduler.advanceTo(5.6, [trigger()], ctx);
    const afterForward = log.length;
    scheduler.advanceTo(1, [trigger()], ctx); // seek backwards
    expect(log.length).toBe(afterForward);
    scheduler.advanceTo(1.6, [trigger()], ctx);
    expect(log.length).toBe(afterForward + 1);
  });
});

describe('tempo changes', () => {
  test('changing BPM mid-run re-grids without duplicating the current beat', () => {
    const { target, log } = recorder();
    const scheduler = new TriggerScheduler(target);
    scheduler.reset(0);
    // 120 BPM for two beats.
    scheduler.advanceTo(0.6, [trigger()], ctxAt(120));
    scheduler.advanceTo(1.1, [trigger()], ctxAt(120));
    const at120 = log.length;
    expect(at120).toBe(2);
    // Switch to 60 BPM (beat = 1s). Next beat on the new grid is 2.0.
    scheduler.advanceTo(1.6, [trigger()], ctxAt(60));
    expect(log.length).toBe(at120); // 1.5 is not a beat at 60 BPM
    scheduler.advanceTo(2.1, [trigger()], ctxAt(60));
    expect(log.length).toBe(at120 + 1);
  });

  test('beatsAt is continuous and monotonic across the grid', () => {
    let previous = -Infinity;
    for (let t = 0; t < 30; t += 0.017) {
      const beats = beatsAt(t, 78.03, 0.021);
      expect(beats).toBeGreaterThanOrEqual(previous);
      previous = beats;
    }
  });

  test('no BPM grid: quantization is a pass-through, never a stall', () => {
    expect(nextBoundary(1.234, 'bar', null, 0, 4)).toBe(1.234);
    expect(nextBoundary(1.234, 'beat', 0, 0, 4)).toBe(1.234);
  });
});

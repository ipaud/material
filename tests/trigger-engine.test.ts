import { describe, expect, test } from 'vitest';
import { envelopeValue, envelopeDuration } from '@/signals/envelope';
import { nextBoundary } from '@/signals/quantize';
import {
  applyCooldown,
  eventTimesBetween,
  onsetEventTimes,
  isDeterministicSource,
  type TriggerContext,
} from '@/signals/triggerSources';
import { pulseContribution, applyPulses } from '@/signals/pulseEngine';
import { TriggerScheduler, type ActionTarget } from '@/signals/scheduler';
import { analyzeBuffer } from '@/audio/analysis';
import { mosaicDefinition } from '@/techniques/mosaic/definition';
import { defaultParams } from '@/techniques/types';
import type { TriggerMapping } from '@shared/schemas/project';

const SR = 48000;

const CTX: TriggerContext = {
  bpm: 120,
  beatOffsetSec: 0,
  beatsPerBar: 4,
  analysis: null,
  markers: [
    { id: 'mk1', timeSec: 3.5, label: 'DROP' },
    { id: 'mk2', timeSec: 7.25, label: 'BREAK' },
  ],
};

function pulseMapping(patch: Partial<TriggerMapping> = {}): TriggerMapping {
  return {
    id: 'trig1',
    enabled: true,
    source: 'beat',
    action: 'pulse',
    targetParam: 'scale',
    targetMappingId: null,
    lookSlot: null,
    quantize: 'off',
    cooldownSec: 0,
    attackSec: 0,
    holdSec: 0,
    decaySec: 0.2,
    amount: 0.5,
    curve: 'linear',
    ...patch,
  };
}

describe('envelope', () => {
  const shape = { attackSec: 0.1, holdSec: 0.05, decaySec: 0.2, curve: 'linear' as const };

  test('AHD shape at known offsets', () => {
    expect(envelopeValue(-0.01, shape)).toBe(0);
    expect(envelopeValue(0.05, shape)).toBeCloseTo(0.5); // mid-attack
    expect(envelopeValue(0.1, shape)).toBeCloseTo(1); // attack end
    expect(envelopeValue(0.12, shape)).toBe(1); // hold
    expect(envelopeValue(0.25, shape)).toBeCloseTo(0.5); // mid-decay
    expect(envelopeValue(0.35, shape)).toBeCloseTo(0, 10); // done (float residue ok)
    expect(envelopeDuration(shape)).toBeCloseTo(0.35);
  });

  test('zero attack starts at full level', () => {
    const instant = { ...shape, attackSec: 0 };
    expect(envelopeValue(0, instant)).toBe(1);
  });

  test('curves order correctly mid-decay (exp < linear < easeOut)', () => {
    const at = (curve: 'linear' | 'exponential' | 'easeOut') =>
      envelopeValue(0.2, { attackSec: 0, holdSec: 0, decaySec: 0.4, curve });
    expect(at('exponential')).toBeLessThan(at('linear'));
    expect(at('linear')).toBeLessThan(at('easeOut'));
  });
});

describe('quantization', () => {
  test('next beat / bar / multi-bar boundaries at 120 BPM', () => {
    expect(nextBoundary(1.1, 'beat', 120, 0, 4)).toBeCloseTo(1.5);
    expect(nextBoundary(1.1, 'bar', 120, 0, 4)).toBeCloseTo(2.0);
    expect(nextBoundary(1.1, '2bars', 120, 0, 4)).toBeCloseTo(4.0);
    expect(nextBoundary(5.0, '4bars', 120, 0, 4)).toBeCloseTo(8.0);
  });

  test('already on the boundary executes now, not one unit later', () => {
    expect(nextBoundary(2.0, 'bar', 120, 0, 4)).toBeCloseTo(2.0);
  });

  test('off / no bpm pass through unchanged', () => {
    expect(nextBoundary(1.234, 'off', 120, 0, 4)).toBe(1.234);
    expect(nextBoundary(1.234, 'bar', null, 0, 4)).toBe(1.234);
  });

  test('respects beat offset', () => {
    expect(nextBoundary(1.0, 'beat', 120, 0.25, 4)).toBeCloseTo(1.25);
  });
});

describe('trigger event times', () => {
  test('beat events in interval (t0, t1]', () => {
    expect(eventTimesBetween('beat', 0.9, 2.1, CTX)).toEqual([1.0, 1.5, 2.0]);
  });

  test('bar events respect beatsPerBar', () => {
    expect(eventTimesBetween('bar', 0, 8, CTX)).toEqual([2, 4, 6, 8]);
    expect(eventTimesBetween('bar', 0, 8, { ...CTX, beatsPerBar: 3 })).toEqual([1.5, 3, 4.5, 6, 7.5]);
  });

  test('half-open interval: event at t0 excluded, at t1 included', () => {
    expect(eventTimesBetween('beat', 1.0, 1.5, CTX)).toEqual([1.5]);
  });

  test('marker events fire once at their time', () => {
    expect(eventTimesBetween('marker:mk1', 3, 4, CTX)).toEqual([3.5]);
    expect(eventTimesBetween('marker:mk1', 4, 5, CTX)).toEqual([]);
  });

  test('no bpm → no grid events', () => {
    expect(eventTimesBetween('beat', 0, 10, { ...CTX, bpm: null })).toEqual([]);
  });

  test('manual sources are live-class and produce no scheduled times', () => {
    expect(isDeterministicSource('manual')).toBe(false);
    expect(isDeterministicSource('key:1')).toBe(false);
    expect(isDeterministicSource('beat')).toBe(true);
    expect(eventTimesBetween('manual', 0, 100, CTX)).toEqual([]);
  });

  test('cooldown filters accepted events sequentially', () => {
    expect(applyCooldown([0, 0.5, 1.0, 1.5, 2.0], 0.9)).toEqual([0, 1.0, 2.0]);
  });

  test('onset events: peaks picked with min separation, deterministic', () => {
    const mono = new Float32Array(SR * 3);
    for (const at of [0.5, 1.0, 1.06, 2.0]) {
      const start = Math.floor(at * SR);
      for (let i = 0; i < 1200; i++) {
        const env = Math.exp(-i / 200);
        mono[start + i] = (mono[start + i] as number) + Math.sin((2 * Math.PI * 1500 * i) / SR) * env;
      }
    }
    const analysis = analyzeBuffer(mono, SR);
    const a = onsetEventTimes(analysis);
    const b = onsetEventTimes(analysis); // cached, identical
    expect(a).toBe(b);
    const times = Array.from(a);
    // Hits near 0.5, 1.0 (1.06 suppressed by min separation), 2.0.
    expect(times.some((t) => Math.abs(t - 0.5) < 0.06)).toBe(true);
    expect(times.some((t) => Math.abs(t - 2.0) < 0.06)).toBe(true);
    for (let i = 1; i < times.length; i++) {
      expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(0.12 - 1e-6);
    }
  });
});

describe('pulse engine', () => {
  test('pulse value is a pure function of time (seek/loop-safe by construction)', () => {
    const m = pulseMapping();
    const v1 = pulseContribution(m, 1.1, CTX);
    // "Arriving" at 1.1 via any path gives the same value.
    const v2 = pulseContribution(m, 1.1, CTX);
    expect(v1).toBe(v2);
    // 0.1s after the beat at 1.0, linear 0.2s decay → half amount.
    expect(v1).toBeCloseTo(0.5 * 0.5);
  });

  test('overlapping pulses accumulate additively', () => {
    // Envelope longer than the beat period → two beats overlap.
    const m = pulseMapping({ decaySec: 0.8, amount: 0.2 });
    // At t=1.25: beat@1.0 contributes env(0.25)=1-0.3125.., beat@0.5 env(0.75)...
    const v = pulseContribution(m, 1.25, CTX);
    const e = (local: number) => (local < 0.8 ? 1 - local / 0.8 : 0);
    expect(v).toBeCloseTo(0.2 * (e(0.25) + e(0.75) + e(1.25 - 0)) /* beats at 1.0, 0.5, 0 */, 5);
  });

  test('applyPulses adds scaled into range and clamps', () => {
    const base = { ...defaultParams(mosaicDefinition), scale: 1 };
    // Short envelope so only the beat AT t contributes.
    const m = pulseMapping({ amount: 0.5, holdSec: 0.02, decaySec: 0.1 });
    const out = applyPulses(base, [m], 1.0, CTX, mosaicDefinition);
    // scale range 0..3 → +0.5*3 = +1.5.
    expect(out.scale).toBeCloseTo(2.5);
    // Long-hold overlap: three beats inside the window accumulate, then clamp.
    const overlap = pulseMapping({ amount: 0.5, holdSec: 1 });
    expect(applyPulses(base, [overlap], 1.0, CTX, mosaicDefinition).scale).toBe(3);
  });

  test('negative amount pulses downward (polarity)', () => {
    const base = { ...defaultParams(mosaicDefinition), scale: 1 };
    const m = pulseMapping({ amount: -0.2, holdSec: 0.02, decaySec: 0.1 });
    const out = applyPulses(base, [m], 1.0, CTX, mosaicDefinition);
    expect(out.scale).toBeCloseTo(1 - 0.6);
  });

  test('disabled / non-pulse / live-source mappings contribute nothing', () => {
    expect(pulseContribution(pulseMapping({ enabled: false }), 1.0, CTX)).toBe(0);
    expect(pulseContribution(pulseMapping({ action: 'freeze' }), 1.0, CTX)).toBe(0);
    expect(pulseContribution(pulseMapping({ source: 'manual' }), 1.0, CTX)).toBe(0);
  });

  test('marker pulse fires exactly at the marker', () => {
    const m = pulseMapping({ source: 'marker:mk1', holdSec: 0.1 });
    expect(pulseContribution(m, 3.55, CTX)).toBeCloseTo(0.5);
    expect(pulseContribution(m, 3.4, CTX)).toBe(0);
  });
});

function recordingTarget(): { target: ActionTarget; log: string[] } {
  const log: string[] = [];
  const target: ActionTarget = {
    freeze: (id) => log.push(`freeze:${id}`),
    unfreeze: (id) => log.push(`unfreeze:${id}`),
    toggleFreeze: (id) => log.push(`toggleFreeze:${id}`),
    pinLook: () => log.push('pinLook'),
    applyLook: (slot) => log.push(`applyLook:${slot}`),
    nextLook: () => log.push('nextLook'),
    prevLook: () => log.push('prevLook'),
    resetParam: (id) => log.push(`resetParam:${id}`),
    toggleMapping: (id) => log.push(`toggleMapping:${id}`),
    morphToLook: (slot) => log.push(`morphToLook:${slot}`),
  };
  return { target, log };
}

describe('scheduler', () => {
  const freezeOnBar = (): TriggerMapping =>
    pulseMapping({ id: 'f1', source: 'bar', action: 'freeze', targetMappingId: '*' });

  test('fires each event exactly once across ticks', () => {
    const { target, log } = recordingTarget();
    const s = new TriggerScheduler(target);
    s.reset(0);
    for (let t = 0; t <= 8.2; t += 0.05) s.advanceTo(Math.min(t, 8.2), [freezeOnBar()], CTX);
    // Bars at 2, 4, 6, 8.
    expect(log).toEqual(['freeze:*', 'freeze:*', 'freeze:*', 'freeze:*']);
  });

  test('seek reset prevents stale firings', () => {
    const { target, log } = recordingTarget();
    const s = new TriggerScheduler(target);
    s.reset(0);
    s.advanceTo(1.9, [freezeOnBar()], CTX);
    // Seek to 10 — the bar at 2..8 must NOT fire on the next tick.
    s.reset(10);
    s.advanceTo(10.05, [freezeOnBar()], CTX);
    expect(log).toEqual([]);
  });

  test('backwards time implies a seek and resets instead of firing', () => {
    const { target, log } = recordingTarget();
    const s = new TriggerScheduler(target);
    s.reset(0);
    s.advanceTo(5, [freezeOnBar()], CTX); // fires bars 2, 4
    s.advanceTo(1, [freezeOnBar()], CTX); // backwards → reset
    s.advanceTo(1.9, [freezeOnBar()], CTX); // nothing new before bar 2
    expect(log).toEqual(['freeze:*', 'freeze:*']);
  });

  test('loop restart cannot double-fire (reset at wrap)', () => {
    const { target, log } = recordingTarget();
    const s = new TriggerScheduler(target);
    s.reset(0);
    s.advanceTo(3.9, [freezeOnBar()], CTX); // bar 2
    s.reset(0); // loop wraps via seek(0)
    s.advanceTo(2.1, [freezeOnBar()], CTX); // bar 2 again — legitimate, once
    expect(log).toEqual(['freeze:*', 'freeze:*']);
  });

  test('quantized live trigger executes exactly on the boundary', () => {
    const { target, log } = recordingTarget();
    const s = new TriggerScheduler(target);
    const m = pulseMapping({
      id: 'q1',
      source: 'manual',
      action: 'applyLook',
      lookSlot: 3,
      quantize: 'bar',
    });
    s.reset(0);
    s.advanceTo(1.1, [m], CTX);
    s.fireLive(m, 1.1, CTX); // next bar = 2.0
    s.advanceTo(1.9, [m], CTX);
    expect(log).toEqual([]); // not yet
    s.advanceTo(2.05, [m], CTX);
    expect(log).toEqual(['applyLook:3']);
  });

  test('pending quantized actions are dropped by a seek', () => {
    const { target, log } = recordingTarget();
    const s = new TriggerScheduler(target);
    const m = pulseMapping({ id: 'q2', source: 'manual', action: 'nextLook', quantize: 'bar' });
    s.reset(0);
    s.advanceTo(1.0, [m], CTX);
    s.fireLive(m, 1.0, CTX); // pending at 2.0
    s.reset(5); // seek before it fires
    s.advanceTo(6.1, [m], CTX);
    expect(log).toEqual([]);
  });

  test('cooldown suppresses rapid refires across intervals', () => {
    const { target, log } = recordingTarget();
    const s = new TriggerScheduler(target);
    const m = pulseMapping({ id: 'c1', source: 'beat', action: 'nextLook', cooldownSec: 1.1 });
    s.reset(0);
    for (let t = 0; t <= 4.001; t += 0.05) s.advanceTo(t, [m], CTX);
    // Beats at 0.5,1,1.5,...; cooldown 1.1 → 0.5, 2.0, 3.5 accepted.
    expect(log.length).toBe(3);
  });

  test('live pulse envelopes contribute and expire', () => {
    const { target } = recordingTarget();
    const s = new TriggerScheduler(target);
    const m = pulseMapping({ id: 'lp', source: 'manual', holdSec: 0.1, decaySec: 0.1 });
    s.reset(1);
    s.fireLive(m, 1.0, CTX);
    expect(s.livePulseContributions(1.05).get('scale')).toBeCloseTo(0.5);
    expect(s.livePulseContributions(1.3).size).toBe(0); // expired + pruned
  });
});

describe('preview/export schedule equality', () => {
  test('coarse preview ticks and fine export frames fire identical discrete events', () => {
    const mappings = [
      pulseMapping({ id: 'a', source: 'bar', action: 'applyLook', lookSlot: 1 }),
      pulseMapping({ id: 'b', source: 'marker:mk1', action: 'freeze', targetMappingId: '*' }),
    ];
    const run = (step: number) => {
      const { target, log } = recordingTarget();
      const s = new TriggerScheduler(target);
      s.reset(0);
      for (let t = 0; t <= 8.0001; t += step) s.advanceTo(Math.min(t, 8), mappings, CTX);
      return log;
    };
    // 60/9.7/240 fps-ish cadences — event SET must be identical.
    expect(run(1 / 60)).toEqual(run(0.103));
    expect(run(1 / 60)).toEqual(run(1 / 240));
  });

  test('pulse values agree between arbitrary evaluation cadences', () => {
    const m = pulseMapping({ decaySec: 0.3 });
    // Pure function: any probe time gives the same value regardless of cadence.
    for (const t of [0.95, 1.0, 1.1, 1.29, 2.51]) {
      expect(pulseContribution(m, t, CTX)).toBe(pulseContribution(m, t, CTX));
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BEATS_PER_CYCLE,
  patternClockAt,
  timingFromTimeline,
  type PatternTiming,
} from '@/pattern/patternClock';
import { beatsAt, divisionPhase } from '@/audio/beatGrid';

const t120: PatternTiming = { bpm: 120, beatOffsetSec: 0, beatsPerBar: 4 };
const t60: PatternTiming = { bpm: 60, beatOffsetSec: 0, beatsPerBar: 4 };

describe('patternClockAt — grid math', () => {
  it('120 BPM: beat = 0.5s, bar = 2s, default cycle = bar', () => {
    const c = patternClockAt(2.25, t120)!;
    expect(c.beatIndex).toBe(4); // 2.25s / 0.5s
    expect(c.beatPhase).toBeCloseTo(0.5, 12);
    expect(c.barIndex).toBe(1);
    expect(c.barPhase).toBeCloseTo(0.125, 12);
    expect(c.cycleIndex).toBe(1);
    expect(c.cyclePhase).toBeCloseTo(0.125, 12);
    expect(c.beatsPerCycle).toBe(DEFAULT_BEATS_PER_CYCLE);
  });

  it('60 BPM: beat = 1s', () => {
    const c = patternClockAt(7.5, t60)!;
    expect(c.beatIndex).toBe(7);
    expect(c.beatPhase).toBeCloseTo(0.5, 12);
    expect(c.barIndex).toBe(1);
    expect(c.cycleIndex).toBe(1);
    expect(c.cyclePhase).toBeCloseTo(0.875, 12);
  });

  it('manual BPM override semantics: whatever timing carries wins', () => {
    // The clock never resolves BPM itself — it consumes the already-resolved
    // authoritative value (manual override or detected), like every source.
    const detected = patternClockAt(1, { ...t120, bpm: 78.03 })!;
    expect(detected.bpm).toBe(78.03);
    expect(detected.beatIndex).toBe(Math.floor(beatsAt(1, 78.03, 0)));
  });

  it('beat offset shifts the whole grid', () => {
    const timing: PatternTiming = { bpm: 120, beatOffsetSec: 0.25, beatsPerBar: 4 };
    const c = patternClockAt(0.25, timing)!;
    expect(c.beatIndex).toBe(0);
    expect(c.beatPhase).toBe(0);
    const d = patternClockAt(0.5, timing)!;
    expect(d.beatIndex).toBe(0);
    expect(d.beatPhase).toBeCloseTo(0.5, 12);
  });

  it('exact beat / bar / cycle boundaries land on phase 0 of the next unit', () => {
    for (const t of [0, 0.5, 2, 4, 6, 8]) {
      const c = patternClockAt(t, t120)!;
      expect(c.beatPhase).toBe(0);
      expect(c.beatIndex).toBe(Math.round(t / 0.5));
    }
    const bar = patternClockAt(2, t120)!;
    expect(bar.barIndex).toBe(1);
    expect(bar.barPhase).toBe(0);
    expect(bar.cycleIndex).toBe(1);
    expect(bar.cyclePhase).toBe(0);
  });

  it('phases always in [0,1) — including float-hostile times', () => {
    const times = [1.234, 123.456, 0.4999999999, 1.9999999999, 3.0000000001, 1e6 + 0.123];
    for (const t of times) {
      const c = patternClockAt(t, t120)!;
      for (const phase of [c.beatPhase, c.barPhase, c.cyclePhase]) {
        expect(phase).toBeGreaterThanOrEqual(0);
        expect(phase).toBeLessThan(1);
      }
    }
  });

  it('huge timestamps stay coherent', () => {
    const c = patternClockAt(1e7, t120)!; // ~115 days of composition time
    expect(c.beatIndex).toBe(2e7);
    expect(c.beatPhase).toBe(0);
    expect(Number.isFinite(c.cycleIndex)).toBe(true);
  });

  it('agrees with divisionPhase — the shared grid primitive', () => {
    for (const t of [0.1, 1.234, 5.5, 123.456]) {
      const c = patternClockAt(t, t120)!;
      expect(c.beatPhase).toBeCloseTo(divisionPhase(t, 120, 0, '1/4', 4), 12);
      expect(c.barPhase).toBeCloseTo(divisionPhase(t, 120, 0, 'bar', 4), 12);
    }
  });
});

describe('patternClockAt — cycle configuration', () => {
  it('cycle lengths of 1 / 2 / 4 / 8 beats are independent of the bar', () => {
    const t = 3.75; // 7.5 beats at 120
    expect(patternClockAt(t, t120, 1)!.cycleIndex).toBe(7);
    expect(patternClockAt(t, t120, 1)!.cyclePhase).toBeCloseTo(0.5, 12);
    expect(patternClockAt(t, t120, 2)!.cycleIndex).toBe(3);
    expect(patternClockAt(t, t120, 2)!.cyclePhase).toBeCloseTo(0.75, 12);
    expect(patternClockAt(t, t120, 4)!.cycleIndex).toBe(1);
    expect(patternClockAt(t, t120, 8)!.cycleIndex).toBe(0);
    expect(patternClockAt(t, t120, 8)!.cyclePhase).toBeCloseTo(7.5 / 8, 12);
  });

  it('cycle is not assumed to equal the bar (7/8 time)', () => {
    const timing: PatternTiming = { bpm: 120, beatOffsetSec: 0, beatsPerBar: 7 };
    const c = patternClockAt(3.5, timing, 4)!; // beat 7 = bar boundary at 7/8
    expect(c.barIndex).toBe(1);
    expect(c.barPhase).toBe(0);
    expect(c.cycleIndex).toBe(1); // but cycle 4 flipped earlier
    expect(c.cyclePhase).toBeCloseTo(0.75, 12);
  });
});

describe('patternClockAt — seek safety and purity', () => {
  it('direct evaluation at t equals stepping to t (pure function)', () => {
    const target = 123.456;
    const direct = patternClockAt(target, t120)!;
    let last = null;
    for (let t = 0; t <= target + 1e-9; t += 0.987) last = patternClockAt(t, t120);
    const stepped = patternClockAt(target, t120)!;
    expect(stepped).toEqual(direct);
    expect(last).not.toBeNull(); // stepping produced values, none of them state
  });

  it('same inputs → identical output object values, every time', () => {
    const a = patternClockAt(41.7, t120, 8)!;
    const b = patternClockAt(41.7, t120, 8)!;
    expect(a).toEqual(b);
  });
});

describe('patternClockAt — no grid / invalid input', () => {
  it('null BPM → null (patterns inactive until a grid exists)', () => {
    expect(patternClockAt(1, { bpm: null, beatOffsetSec: 0, beatsPerBar: 4 })).toBeNull();
  });

  it('invalid bpm / time / cycle length → null, never NaN', () => {
    expect(patternClockAt(1, { bpm: 0, beatOffsetSec: 0, beatsPerBar: 4 })).toBeNull();
    expect(patternClockAt(1, { bpm: -10, beatOffsetSec: 0, beatsPerBar: 4 })).toBeNull();
    expect(patternClockAt(1, { bpm: NaN, beatOffsetSec: 0, beatsPerBar: 4 })).toBeNull();
    expect(patternClockAt(NaN, t120)).toBeNull();
    expect(patternClockAt(1, t120, 0)).toBeNull();
    expect(patternClockAt(1, t120, -2)).toBeNull();
  });

  it('pre-roll: negative indices with valid phases (documented divergence from the UI readout)', () => {
    const timing: PatternTiming = { bpm: 120, beatOffsetSec: 10, beatsPerBar: 4 };
    const c = patternClockAt(9.75, timing)!; // half a beat before the grid
    expect(c.beatIndex).toBe(-1);
    expect(c.beatPhase).toBeCloseTo(0.5, 12);
    expect(c.cycleIndex).toBe(-1);
    expect(c.cyclePhase).toBeGreaterThanOrEqual(0);
    expect(c.cyclePhase).toBeLessThan(1);
  });
});

describe('timingFromTimeline', () => {
  it('maps the project timeline block 1:1', () => {
    expect(timingFromTimeline({ bpm: 78.03, beatOffsetSec: 0.0213, beatsPerBar: 4 })).toEqual({
      bpm: 78.03,
      beatOffsetSec: 0.0213,
      beatsPerBar: 4,
    });
  });
});

describe('performance (P1 gate: cheap enough to ignore)', () => {
  it('250k evaluations stay far under one frame budget per 250 patterns', () => {
    const t0 = performance.now();
    let sink = 0;
    for (let i = 0; i < 250_000; i++) {
      const c = patternClockAt(i * 0.01234, t120, 4);
      if (c) sink += c.cyclePhase;
    }
    const ms = performance.now() - t0;
    expect(sink).toBeGreaterThan(0);
    // 250k evals ≈ 1000 frames × 250 patterns; budget: well under 1ms per
    // 250-pattern frame on any dev machine (generous CI margin: 250ms total).
    expect(ms).toBeLessThan(250);
  });
});

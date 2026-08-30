import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_PREROLL_SEC,
  LUMINANCE_CALIBRATION,
  calibratorStep,
  calibratorValue,
  newCalibratorState,
  type CalibratorState,
} from '@/signals/visual/calibration';
import { pixelOriginKey } from '@/signals/visual/originKey';
import type { SourceRef } from '@shared/schemas/project';

/**
 * v0.4A A5 — calibration. Every requirement in the spec is a test here, and
 * the finite-memory bound is asserted numerically rather than trusted.
 */

const P = LUMINANCE_CALIBRATION;
const DT = 1 / 30;

function drive(values: number[], dt = DT, state = newCalibratorState()): CalibratorState {
  let s = state;
  for (const v of values) s = calibratorStep(s, v, dt, P);
  return s;
}
const steady = (v: number, n: number) => Array.from({ length: n }, () => v);

describe('envelope invariants', () => {
  it('lo <= hi survives an adversarial random walk', () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    let s = newCalibratorState();
    let x = 0.5;
    for (let i = 0; i < 10000; i++) {
      x = Math.min(Math.max(x + (rnd() - 0.5) * 0.3, 0), 1);
      s = calibratorStep(s, x, DT, P);
      expect(s.lo).toBeLessThanOrEqual(s.hi + 1e-12);
      expect(Number.isFinite(s.lo) && Number.isFinite(s.hi)).toBe(true);
    }
  });

  it('never uses instant min/max — one sample cannot pin the range', () => {
    const s = drive([...steady(0.4, 100), 1.0]);
    // A single extreme moves the envelope by at most alpha_expand of its gap.
    expect(s.hi).toBeLessThan(0.45);
  });
});

describe('the failure modes this exists to prevent', () => {
  it('a flash does not compress the range for half a minute', () => {
    const flashed = drive([...steady(0.4, 300), 1.0]);
    const after5s = drive(steady(0.4, 150), DT, flashed);
    // Recovered to within 1% of the pre-flash envelope.
    expect(after5s.hi).toBeLessThan(0.41);
  });

  it('a static noisy source is not amplified to full scale', () => {
    let seed = 99;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const jitter = Array.from({ length: 600 }, () => 0.3 + (rnd() - 0.5) * 0.001);
    const s = drive(jitter);
    for (const x of jitter.slice(-50)) {
      const y = calibratorValue(s, x, P);
      expect(y).not.toBeNull();
      // Span floor keeps a 0.001 wobble from becoming 0..1.
      expect(Math.abs((y as number) - 0.5)).toBeLessThan(0.05);
    }
  });

  it('a dark clip gets real travel — the whole point', () => {
    // Raw luminance 0.08..0.25, exactly the case that kills a naive mapping.
    const cycle: number[] = [];
    for (let i = 0; i < 900; i++) cycle.push(0.165 + 0.085 * Math.sin(i / 20));
    const s = drive(cycle);
    const ys = cycle.slice(-200).map((x) => calibratorValue(s, x, P) as number);
    const span = Math.max(...ys) - Math.min(...ys);
    expect(span).toBeGreaterThan(0.7);
  });

  it('a bright clip gets the same travel from the same mapping', () => {
    const cycle: number[] = [];
    for (let i = 0; i < 900; i++) cycle.push(0.8 + 0.085 * Math.sin(i / 20));
    const s = drive(cycle);
    const ys = cycle.slice(-200).map((x) => calibratorValue(s, x, P) as number);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.7);
  });

  it('warming publishes nothing rather than a wrong number', () => {
    const s = drive(steady(0.5, 5));
    expect(calibratorValue(s, 0.5, P)).toBeNull();
    const warm = drive(steady(0.5, Math.ceil(P.warmupSec * 30) + 5));
    expect(calibratorValue(warm, 0.5, P)).not.toBeNull();
  });
});

describe('finite memory — the bound the export preroll relies on', () => {
  it('two states started anywhere converge as exp(-T/tauContract)', () => {
    let seed = 4242;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const signal = Array.from({ length: 30 * 40 }, () => rnd());
    for (const T of [8, 16, 24, 32]) {
      let a: CalibratorState = { lo: 0, hi: 0, elapsedSec: 99, seeded: true };
      let b: CalibratorState = { lo: 1, hi: 1, elapsedSec: 99, seeded: true };
      for (let i = 0; i < T * 30; i++) {
        const x = signal[i] as number;
        a = calibratorStep(a, x, DT, P);
        b = calibratorStep(b, x, DT, P);
      }
      const bound = Math.exp(-T / P.tauContractSec);
      expect(Math.abs(a.lo - b.lo)).toBeLessThanOrEqual(bound + 1e-9);
      expect(Math.abs(a.hi - b.hi)).toBeLessThanOrEqual(bound + 1e-9);
    }
  });

  it('the chosen preroll bounds the calibrated difference at 0.025', () => {
    // The export contract: a subrange replaying CALIBRATION_PREROLL_SEC must
    // agree with a full replay to within this, worst case at the span floor.
    const stateError = Math.exp(-CALIBRATION_PREROLL_SEC / P.tauContractSec);
    expect(stateError).toBeLessThan(0.0026);
    expect(stateError / (2 * P.minHalfSpan)).toBeLessThan(0.026);
  });

  it('is rate-independent, which is what lets the preroll stride', () => {
    const at30: number[] = [];
    for (let i = 0; i < 30 * 30; i++) at30.push(0.4 + 0.2 * Math.sin(i / 30));
    const s30 = drive(at30, 1 / 30);
    const at7 = at30.filter((_, i) => i % 4 === 0);
    const s7 = drive(at7, 4 / 30);
    const x = at30[at30.length - 1] as number;
    const y30 = calibratorValue(s30, x, P) as number;
    const y7 = calibratorValue(s7, x, P) as number;
    expect(Math.abs(y30 - y7)).toBeLessThan(0.02);
  });
});

describe('pixel origin key (§A5)', () => {
  const gen = (over: Partial<Record<string, unknown>> = {}): SourceRef =>
    ({ id: 'g1', kind: 'generator', generator: 'noise', params: {}, seed: 1, ...over }) as SourceRef;

  it('a generator param edit keeps the key; kind and seed change it', () => {
    expect(pixelOriginKey(gen())).toBe(pixelOriginKey(gen({ params: { scale: 9 } })));
    expect(pixelOriginKey(gen())).not.toBe(pixelOriginKey(gen({ seed: 2 })));
    expect(pixelOriginKey(gen())).not.toBe(pixelOriginKey(gen({ generator: 'waves' })));
  });

  it('the record id never enters the key — two entries on one origin share it', () => {
    expect(pixelOriginKey(gen({ id: 'other' }))).toBe(pixelOriginKey(gen()));
    const a = { id: 'a', kind: 'video', path: '/clip.mp4', metadata: null } as unknown as SourceRef;
    const b = { id: 'b', kind: 'video', path: '/clip.mp4', metadata: null } as unknown as SourceRef;
    expect(pixelOriginKey(a)).toBe(pixelOriginKey(b));
  });

  it('a camera device swap DOES change the key', () => {
    const cam = (deviceId: string | null) =>
      ({ id: 'c1', kind: 'camera', deviceId }) as unknown as SourceRef;
    expect(pixelOriginKey(cam('webcam'))).not.toBe(pixelOriginKey(cam('capture-card')));
    // engineBridge's sourceKey is `camera:${id}` and would MISS this.
    expect(pixelOriginKey(cam(null), { activeCameraDeviceId: 'live-dev' })).toContain('live-dev');
  });

  it('a re-chosen window changes the key', () => {
    const win = { id: 'w1', kind: 'window', titleHint: 'Safari' } as unknown as SourceRef;
    expect(pixelOriginKey(win, { chosenWindowId: '11' })).not.toBe(
      pixelOriginKey(win, { chosenWindowId: '22' }),
    );
  });

  it('no source has no key', () => {
    expect(pixelOriginKey(null)).toBeNull();
  });
});

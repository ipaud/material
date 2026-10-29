import { describe, expect, it } from 'vitest';
import { CalibrationStore } from '@/signals/visual/calibrationStore';
import type { RawVisualStats } from '@/signals/visual/types';

/**
 * Per-origin calibration of visual signals: which signals are calibrated, warmup, LOCK, and that
 * two pixel origins never share an envelope.
 */

const stats = (patch: Partial<RawVisualStats> = {}): RawVisualStats =>
  ({ n: 64, luminance: 0.5, contrast: 0.2, edgeEnergy: 0.1, motionAmount: 0.3, hasFlow: true, ...patch }) as RawVisualStats;

/** Feed one origin a second of alternating dark and bright frames. */
function warm(store: CalibrationStore, origin: string, seconds = 2): void {
  for (let i = 0; i < seconds * 30; i++) {
    store.advance(origin, stats({ luminance: i % 2 ? 0.8 : 0.2, motionAmount: i % 2 ? 0.6 : 0.1 }), 1 / 30);
  }
}

describe('calibration store', () => {
  it('only some signals are calibrated; the rest pass straight through', () => {
    const store = new CalibrationStore();
    expect(store.params('image.luminance')).not.toBeNull();
    expect(store.params('motion.x')).toBeNull();
    expect(store.value(null, 'motion.x', 0.37)).toBe(0.37);
  });

  it('a calibrated signal is absent until its origin has been seen, and warms before it settles', () => {
    const store = new CalibrationStore();
    expect(store.value('cam', 'image.luminance', 0.5)).toBeNull();
    expect(store.value(null, 'image.luminance', 0.5)).toBeNull();
    store.advance('cam', stats(), 1 / 30);
    expect(store.inspect('cam', 'image.luminance')?.warming).toBe(true);
    warm(store, 'cam');
    const range = store.inspect('cam', 'image.luminance')!;
    expect(range.warming).toBe(false);
    expect(range.lo).toBeLessThan(range.hi);
    const bright = store.value('cam', 'image.luminance', 0.8)!;
    const dark = store.value('cam', 'image.luminance', 0.2)!;
    expect(bright).toBeGreaterThan(dark);
  });

  it('motion is calibrated only when there is flow', () => {
    const store = new CalibrationStore();
    store.advance('cam', stats({ hasFlow: false }), 1 / 30);
    expect(store.inspect('cam', 'motion.amount')).toBeNull();
    expect(store.size).toBe(3);
  });

  it('origins are separate, and resetting one leaves the others', () => {
    const store = new CalibrationStore();
    warm(store, 'cam');
    warm(store, 'file:/a.mp4');
    expect(store.size).toBe(8);
    store.resetOrigin('cam');
    expect(store.inspect('cam', 'image.luminance')).toBeNull();
    expect(store.inspect('file:/a.mp4', 'image.luminance')).not.toBeNull();
    store.resetOrigin(null);
    expect(store.size).toBe(4);
  });

  it('LOCK stops the envelopes adapting; replacing the document clears ranges and lock', () => {
    const store = new CalibrationStore();
    warm(store, 'cam');
    const before = store.inspect('cam', 'image.luminance');
    store.locked = true;
    for (let i = 0; i < 90; i++) store.advance('cam', stats({ luminance: 0.99 }), 1 / 30);
    expect(store.inspect('cam', 'image.luminance')).toEqual(before);
    store.advance(null, stats(), 1 / 30);
    store.advance('cam', null, 1 / 30);
    store.reset();
    expect(store.size).toBe(0);
    expect(store.locked).toBe(false);
  });
});

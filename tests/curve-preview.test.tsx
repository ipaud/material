import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { envelopePoints, transferPoints, EnvelopePreview, TransferPreview } from '@/inspector/CurvePreview';
import type { ModulationMapping, TriggerMapping } from '@shared/schemas/project';

afterEach(cleanup);

const mapping = (over: Partial<ModulationMapping> = {}): ModulationMapping =>
  ({
    id: 'm', enabled: true, source: 'bass', target: 'scale', amount: 1, min: 0, max: 1,
    invert: false, smoothing: 0, curve: 'linear', frozenValue: null, ...over,
  }) as ModulationMapping;

describe('transferPoints (source → output, before smoothing)', () => {
  it('identity for defaults', () => {
    const p = transferPoints(mapping(), 4);
    expect(p.map((q) => q.y)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('the input window clips: nothing below inMin, full above inMax', () => {
    const p = transferPoints(mapping({ inMin: 0.5, inMax: 1 }), 4);
    expect(p.map((q) => q.y)).toEqual([0, 0, 0, 0.5, 1]);
  });

  it('invert, curve and the output range all show', () => {
    expect(transferPoints(mapping({ invert: true }), 2).map((q) => q.y)).toEqual([1, 0.5, 0]);
    expect(transferPoints(mapping({ curve: 'exponential' }), 2).map((q) => q.y)).toEqual([0, 0.25, 1]);
    expect(transferPoints(mapping({ min: 0.2, max: 0.6 }), 2).map((q) => q.y)).toEqual([0.2, 0.4, 0.6]);
  });
});

const trigger = (over: Partial<TriggerMapping> = {}): TriggerMapping =>
  ({
    id: 't', enabled: true, source: 'beat', action: 'pulse', targetParam: 'scale',
    attackSec: 0.1, holdSec: 0.2, decaySec: 0.3, amount: 0.5, curve: 'linear',
    cooldownSec: 0, quantize: 'off', targetMappingId: null, lookSlot: null, ...over,
  }) as TriggerMapping;

describe('envelopePoints (attack / hold / decay)', () => {
  it('rises over the attack, holds, then decays to zero, scaled by amount', () => {
    const p = envelopePoints(trigger(), 60);
    expect(p[0]).toMatchObject({ x: 0, y: 0 });
    const peak = Math.max(...p.map((q) => q.y));
    expect(peak).toBeCloseTo(0.5, 2);
    expect(p[p.length - 1]!.y).toBeCloseTo(0, 2);
    expect(p[p.length - 1]!.x).toBeCloseTo(0.6, 6); // 0.1 + 0.2 + 0.3
  });

  it('a negative amount pulses downward', () => {
    const p = envelopePoints(trigger({ amount: -0.5 }), 60);
    expect(Math.min(...p.map((q) => q.y))).toBeCloseTo(-0.5, 2);
  });
});

describe('the previews render', () => {
  it('draw a polyline each', () => {
    const a = render(<TransferPreview mapping={mapping()} />);
    expect(a.container.querySelector('svg polyline')).not.toBeNull();
    cleanup();
    const b = render(<EnvelopePreview trigger={trigger()} />);
    expect(b.container.querySelector('svg polyline')).not.toBeNull();
  });
});

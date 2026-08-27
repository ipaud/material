import { describe, expect, test } from 'vitest';
import { adjustSample, luminance, sampleToScale } from '@/rendering/sampling';

describe('sampling math (CPU mirror of GLSL)', () => {
  test('luminance uses Rec. 709 weights', () => {
    expect(luminance(1, 1, 1)).toBeCloseTo(1);
    expect(luminance(0, 0, 0)).toBe(0);
    expect(luminance(1, 0, 0)).toBeCloseTo(0.2126);
    expect(luminance(0, 1, 0)).toBeCloseTo(0.7152);
  });

  test('contrast pivots around 0.5', () => {
    expect(adjustSample(0.5, 2, 1, false)).toBeCloseTo(0.5);
    expect(adjustSample(0.75, 2, 1, false)).toBeCloseTo(1);
    expect(adjustSample(0.25, 2, 1, false)).toBeCloseTo(0);
  });

  test('gamma brightens midtones when > 1', () => {
    expect(adjustSample(0.25, 1, 2, false)).toBeCloseTo(Math.pow(0.25, 0.5));
  });

  test('invert flips the sample', () => {
    expect(adjustSample(0.2, 1, 1, true)).toBeCloseTo(0.8);
  });

  test('zero contrast collapses to mid gray', () => {
    expect(adjustSample(0.1, 0, 1, false)).toBeCloseTo(0.5);
    expect(adjustSample(0.9, 0, 1, false)).toBeCloseTo(0.5);
  });

  test('sampleToScale amount=0 keeps base scale', () => {
    expect(sampleToScale(0.2, 1.5, 0, 0, 4)).toBeCloseTo(1.5);
  });

  test('sampleToScale amount=1 is fully sample-driven', () => {
    expect(sampleToScale(0.5, 1, 1, 0, 4)).toBeCloseTo(0.5);
    expect(sampleToScale(1, 1, 1, 0, 4)).toBeCloseTo(1);
  });

  test('sampleToScale clamps to min/max', () => {
    expect(sampleToScale(0, 1, 1, 0.25, 4)).toBe(0.25);
    expect(sampleToScale(1, 3, 1, 0, 2)).toBe(2);
  });
});

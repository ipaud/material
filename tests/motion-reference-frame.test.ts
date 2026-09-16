import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOTION_REFERENCE_FPS, referenceMotionScale } from '@/rendering/analysis/reductionLadder';

/**
 * v0.8.3 — motion.amount is a velocity, not a per-frame displacement.
 *
 * A generator's flow pair spans one DISPLAY frame in preview and one EXPORT
 * frame in export. The same figure moving at the same speed read 0.27
 * calibrated in preview and 0.00 in export for the same two seconds of a
 * piece, because the raw number was 2-4x larger in export and the envelope
 * floor put the two paths in different regimes. Found by differencing a
 * Look's echo rotation: 11 degrees live, 1.5 exported.
 */
describe('reference-frame motion scale', () => {
  it('is the identity at the reference rate', () => {
    expect(referenceMotionScale(1 / MOTION_REFERENCE_FPS)).toBeCloseTo(1, 12);
  });

  it('doubles a 60 Hz displacement and quadruples a 120 Hz one', () => {
    expect(referenceMotionScale(1 / 60)).toBeCloseTo(2, 12);
    expect(referenceMotionScale(1 / 120)).toBeCloseTo(4, 12);
  });

  it('halves a 15 fps export — a slow export is not a fast source', () => {
    expect(referenceMotionScale(1 / 15)).toBeCloseTo(0.5, 12);
  });

  it('leaves the value alone when the spacing is unknown or degenerate', () => {
    expect(referenceMotionScale(null)).toBe(1);
    expect(referenceMotionScale(undefined)).toBe(1);
    expect(referenceMotionScale(0)).toBe(1);
    expect(referenceMotionScale(-1)).toBe(1);
    expect(referenceMotionScale(Number.NaN)).toBe(1);
  });
});

describe('the runtime tells the field WHEN each frame is', () => {
  const runtime = readFileSync(resolve(process.cwd(), 'src/rendering/layers/LayerRuntimeImpl.ts'), 'utf8');
  const flow = readFileSync(resolve(process.cwd(), 'src/rendering/flow/OpticalFlowField.ts'), 'utf8');

  it('on the preview path, from the source clock', () => {
    expect((runtime.match(/updateFlowService\(renderer, undefined, this\.sourceClock\(\)\)/g) ?? []).length).toBe(2);
  });

  it('on the export path, both taps of the constructed pair', () => {
    expect(runtime).toMatch(/updateFlowService\(renderer, `\$\{frameKey\}:pre`, this\.exportPrevSourceSec\)/);
    expect(runtime).toMatch(/updateFlowService\(renderer, frameKey, compositionTime\)/);
  });

  it('rescales what it PUBLISHES, never what the reducer cached', () => {
    // The reducer returns the same object for the same frame key; comparing
    // a rescaled copy against it would republish every frame.
    expect(runtime).toMatch(/if \(next !== this\.latestRaw\)/);
    expect(runtime).toMatch(/referenceMotionScale\(this\.flow\?\.pairDtSec\)/);
  });

  it('a reset forgets the spacing along with the pair', () => {
    const reset = flow.slice(flow.indexOf('reset(pairWillBeConstructed'));
    expect(reset).toMatch(/this\.lastAtSec = null;/);
    expect(reset).toMatch(/this\.pairDt = null;/);
  });
});

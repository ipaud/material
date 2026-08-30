import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  VISUAL_SIGNALS,
  VISUAL_SIGNAL_IDS,
  isVisualSignalId,
  visualSignalDef,
} from '@/signals/visual/types';

const src = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

/**
 * v0.4A A1/A2 — the signal contract and the reducer's structural rules.
 */

describe('signal contract (§A1)', () => {
  it('publishes exactly the vertical slice, with dotted family ids', () => {
    expect(VISUAL_SIGNAL_IDS).toEqual(['image.luminance', 'motion.amount', 'motion.x']);
    for (const s of VISUAL_SIGNALS) expect(s.id.startsWith(`${s.family}.`)).toBe(true);
  });

  it('every signal states its RAW unit — never a bare "amount"', () => {
    for (const s of VISUAL_SIGNALS) {
      expect(s.unit.length, `${s.id} has no unit`).toBeGreaterThan(4);
      expect(s.label.length).toBeGreaterThan(0);
    }
  });

  it('motion.x is centred and needs no calibration', () => {
    const x = visualSignalDef('motion.x')!;
    expect(x.domain).toBe('centred');
    // It is a magnitude-weighted mean of the UNIT direction, so the weight
    // cancels analytically and the value is bounded to ±1 by construction.
    // Calibrating it would only add lag.
    expect(x.calibrated).toBe(false);
    // A centred signal must default to a mapping where "still" contributes 0.
    expect(x.defaultMapping).toEqual({ min: -1, max: 1 });
  });

  it('the unipolar signals are the calibrated ones', () => {
    for (const id of ['image.luminance', 'motion.amount'] as const) {
      const d = visualSignalDef(id)!;
      expect(d.domain).toBe('unipolar');
      expect(d.calibrated).toBe(true);
      expect(d.defaultMapping).toEqual({ min: 0, max: 1 });
    }
  });

  it('rejects unknown ids', () => {
    expect(isVisualSignalId('image.luminance')).toBe(true);
    expect(isVisualSignalId('bass')).toBe(false);
    expect(visualSignalDef('nope')).toBeNull();
  });
});

describe('reducer structural rules (§A2)', () => {
  const reducer = src('src', 'rendering', 'analysis', 'ImageStatsReducer.ts');

  it('never sets viewport or pixel ratio in a render-target pass', () => {
    // setViewport multiplies by pixelRatio and would confine the pass to a
    // quadrant; setPixelRatio in a per-frame pass forces a canvas resize
    // (measured at 77ms stalls in CE1B).
    expect(reducer).not.toContain('setViewport(');
    expect(reducer).not.toContain('setPixelRatio(');
  });

  it('reads back only the final tile, never the frame', () => {
    const reads = reducer.match(/readRenderTargetPixels/g) ?? [];
    expect(reads.length).toBe(1);
    expect(reducer).toContain('this.levels[this.levels.length - 1]');
  });

  it('validates the readback with glGetError', () => {
    expect(reducer).toContain('gl.getError()');
    expect(reducer).toContain('throw new Error');
  });

  it('uses data-safe float targets', () => {
    expect(reducer).toContain('type: THREE.FloatType');
    expect(reducer).toContain('colorSpace: THREE.NoColorSpace');
    expect(reducer).toContain('minFilter: THREE.NearestFilter');
  });

  it('reuses the shared luminance chunk rather than a second constant', () => {
    expect(reducer).toContain('GLSL_LUMINANCE');
    expect(reducer).not.toContain('0.2126');
  });

  it('skips out-of-range children instead of clamping', () => {
    // Clamp-to-edge would duplicate edge texels and bias the mean.
    expect(reducer).toContain('p.x < uSrcSize.x && p.y < uSrcSize.y');
  });

  it('is registered as a geometry owner so the leak check sees it', () => {
    const lifecycle = src('tests', 'gpu-lifecycle.test.ts');
    expect(lifecycle).toContain('ImageStatsReducer.ts');
  });
});

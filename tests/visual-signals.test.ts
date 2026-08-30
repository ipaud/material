import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  VISUAL_SIGNALS,
  VISUAL_SIGNAL_IDS,
  isVisualSignalId,
  visualSignalDef,
  type RawVisualStats,
  type VisualSignalId,
} from '@/signals/visual/types';
import { publishVisualSignals } from '@/signals/visual/publish';
import { MOTION_SATURATION_TEXELS, decodeStats } from '@/rendering/analysis/reductionLadder';
import { demandNeedsFlow, visualDemand } from '@/signals/visual/demand';

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

describe('publication uses absence as the neutral (§A1)', () => {
  const demandAll = new Set<VisualSignalId>(['image.luminance', 'motion.amount', 'motion.x']);
  const stats = (over: Partial<RawVisualStats> = {}): RawVisualStats => ({
    n: 100,
    luminance: 0.4,
    motionAmount: 2,
    motionX: 0.7,
    motionValid: true,
    hasFlow: true,
    ...over,
  });

  it('omits motion entirely when there is no flow — never publishes zero motion', () => {
    // Publishing 0 would drive every motion mapping to its `min` instead of
    // leaving it alone, because 0 is a value and absence is the neutral.
    const out = publishVisualSignals(stats({ hasFlow: false }), demandAll, (_, raw) => raw);
    expect('motion.amount' in out).toBe(false);
    expect('motion.x' in out).toBe(false);
    expect(out['image.luminance']).toBeCloseTo(0.4, 6);
  });

  it('omits a signal that is still warming', () => {
    const out = publishVisualSignals(stats(), demandAll, (id) =>
      id === 'image.luminance' ? null : 1,
    );
    expect('image.luminance' in out).toBe(false);
    expect('motion.amount' in out).toBe(true);
  });

  it('publishes nothing at all before the first analysis', () => {
    expect(publishVisualSignals(null, demandAll, (_, raw) => raw)).toEqual({});
  });

  it('only publishes what is demanded', () => {
    const out = publishVisualSignals(stats(), new Set(['motion.x']), (_, raw) => raw);
    expect(Object.keys(out)).toEqual(['motion.x']);
  });

  it('motion.x bypasses calibration — it is already normalised', () => {
    const out = publishVisualSignals(stats({ motionX: 0.7 }), demandAll, () => 0.123);
    expect(out['motion.x']).toBeCloseTo(0.7, 6);
    expect(out['motion.amount']).toBeCloseTo(0.123, 6);
  });
});

describe('demand drives the analyser and the flow field (§A4)', () => {
  const map = (source: string, enabled = true) =>
    ({ id: source, enabled, source, target: 'scale' }) as never;

  it('collects enabled visual mappings only', () => {
    const d = visualDemand([map('image.luminance'), map('motion.x', false), map('bass')]);
    expect([...d]).toEqual(['image.luminance']);
  });

  it('an open scope keeps a signal alive with no mapping', () => {
    expect([...visualDemand([], new Set(['motion.amount']))]).toEqual(['motion.amount']);
  });

  it('a motion signal demands the flow field; luminance does not', () => {
    // Without this the flow service would dispose the very field motion
    // measures, whenever the active technique did not want flow itself.
    expect(demandNeedsFlow(visualDemand([map('motion.amount')]))).toBe(true);
    expect(demandNeedsFlow(visualDemand([map('image.luminance')]))).toBe(false);
  });

  it('the engine widens its flow gate to include signal demand', () => {
    const engine = src('src', 'rendering', 'RenderEngine.ts');
    expect(engine).toContain('demandNeedsFlow(this.visualDemand)');
    expect(engine).toMatch(/flowIsNeeded\(\)/);
  });
});

describe('export path (§A8)', () => {
  const runner = src('src', 'export', 'exportRunner.ts');

  it('analyses every exported frame, keyed by GLOBAL frame', () => {
    expect(runner).toContain('engine.updateVisualStatsForExport(`export:${startFrame + i}`)');
  });

  it('uses its own canonical calibration, never the preview session state', () => {
    expect(runner).toContain('new CalibrationStore()');
    expect(runner).toContain('exportCalibration');
  });

  it('prerolls a BOUNDED window rather than the whole timeline', () => {
    // The estimator has provably finite memory, so six time constants suffice.
    expect(runner).toContain('CALIBRATION_PREROLL_SEC');
    expect(runner).toContain('Math.max(0, startFrame - Math.ceil(CALIBRATION_PREROLL_SEC');
  });

  it('feeds the snapshot into the evaluator rather than a second context', () => {
    // The first attempt wired ctx.visual only on the preview path; export built
    // its own SourceContext, so every visual signal was silently absent from
    // the render. Determinism passed 12/12 anyway — an absent signal is
    // perfectly reproducible. The anti-noop gate is what caught it.
    expect(runner).toContain('createFrameEvaluator(0, request.fps, visualSnapshot)');
  });
});

describe('measured live defects (§A6)', () => {
  it('analyses inside the preview frame, not only the transition snapshot', () => {
    // First wiring put the call in captureTransitionSnapshot, which runs only
    // when a transition opens. Measured: demand set, texture present, grid
    // valid, and zero reductions in 2.5 s of preview.
    const engine = src('src', 'rendering', 'RenderEngine.ts');
    const frame = engine.slice(engine.indexOf('private renderFrame()'));
    expect(frame).toMatch(/this\.syncScene\(\);[\s\S]{0,400}?this\.updateVisualStats\(renderer\)/);
  });

  it('advances calibration on wall time, never on transport time', () => {
    // Feeding playback.getTime() pinned dt at 0 whenever the transport was
    // stopped, so warmupSec never elapsed and every signal stayed `warming`
    // forever — the analyser runs on produced pixels, not on transport.
    const bridge = src('src', 'rendering', 'engineBridge.ts');
    expect(bridge).toMatch(/setVisualSink\(\(stats\) =>\s*modulationRuntime\.setVisualStats\(stats, performance\.now\(\) \/ 1000\)\)/);
    expect(bridge).not.toContain('setVisualStats(stats, playback.getTime())');
  });

  it('ignores the flow field until a real solve has run', () => {
    // The priming update CLEARS the targets, so its zero is not a measurement.
    // Measured before the fix: calibrated motion.amount sat at 0.894 mean and
    // saturated at 1.0 on a source whose raw span was 0.42-0.59, because the
    // priming zero pinned the low envelope and τ_contract gives it back slowly.
    const engine = src('src', 'rendering', 'RenderEngine.ts');
    expect(engine).toContain('this.flow?.ready');
    const flow = src('src', 'rendering', 'flow', 'OpticalFlowField.ts');
    expect(flow).toMatch(/get ready\(\): boolean \{\s*return this\.solves > 0;/);
    // A discontinuity must make the field un-ready again, or a seek would
    // publish the cleared field as measured motion.
    const reset = flow.slice(flow.indexOf('reset(): void'));
    expect(reset.slice(0, 200)).toContain('this.solves = 0');
  });
});

describe('saturation is reported, not swallowed (§A9)', () => {
  it('caps the amount at the field ceiling and still publishes it', () => {
    // Suppressing saturated frames deleted motion from 59 of 61 frames of a
    // 12 fps export, where 5-8 texels/frame is the real displacement. The
    // ceiling is the shader's own clamp: 8 per component, so 8*sqrt(2) on the
    // diagonal. Reporting more than the instrument can express is inventing.
    const demand = new Set<VisualSignalId>(['motion.amount', 'motion.x']);
    const saturated = decodeStats(new Float32Array([0.5 * 64, (40 / 320) * 64, 0, 64]), 320, true);
    expect(saturated.motionAmount).toBeCloseTo(MOTION_SATURATION_TEXELS, 6);
    expect(saturated.motionValid).toBe(false);
    expect(publishVisualSignals(saturated, demand, () => 0.9)).toEqual({
      'motion.amount': 0.9,
      'motion.x': 0.5,
    });

    const measured = decodeStats(new Float32Array([0.5 * 64, (1.5 / 320) * 64, 0, 64]), 320, true);
    expect(measured.motionAmount).toBeCloseTo(1.5, 4);
    expect(measured.motionValid).toBe(true);
  });

  it('an absent field still omits motion entirely', () => {
    // The companion: the guard above must not become a licence to publish 0.
    const demand = new Set<VisualSignalId>(['motion.amount', 'motion.x']);
    const none = decodeStats(new Float32Array([0.5 * 64, 0, 0, 64]), 320, false);
    expect(none.hasFlow).toBe(false);
    expect(publishVisualSignals(none, demand, () => 0.5)).toEqual({});
  });
});

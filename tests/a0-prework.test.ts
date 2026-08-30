import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SmoothingState, shapeMappingValue, shapedUnitValue } from '@/modulation/evaluator';
import type { ModulationMapping } from '@shared/schemas/project';

/**
 * v0.4A A0 — pre-work. Four defects found while mapping the codebase for
 * image/motion signals. Each blocks a later phase, and each is the same shape:
 * a system that looks fine because the thing it stopped doing is perfectly
 * reproducible.
 */

const src = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

const mapping = (over: Partial<ModulationMapping> = {}): ModulationMapping => ({
  id: 'm1',
  enabled: true,
  source: 'bass',
  target: 'scale',
  amount: 1,
  min: 0,
  max: 1,
  invert: false,
  smoothing: 0,
  curve: 'linear',
  frozenValue: null,
  ...over,
});

describe('R1 — a generator has frame identity (§A0)', () => {
  it('the frame key includes a generator revision', () => {
    // `sourceFrameCounter` only ticks from requestVideoFrameCallback, which
    // exists only on HTMLVideoElement. A generator's texture is one stable
    // object, so the key was constant and every frame-gated consumer
    // early-returned forever. MEASURED before the fix: 3s of preview at 120fps
    // over a noise generator with Motion Mosh produced 0 flow updates; after,
    // 360. Export was never affected because it passes explicit keys — which
    // is exactly why the determinism matrix read 12/12 throughout.
    const engine = src('src', 'rendering', 'RenderEngine.ts');
    expect(engine).toContain('private generatorRevision = 0;');
    expect(engine).toMatch(/sourceFrameKey\(\)[\s\S]{0,200}this\.generatorRevision/);
    expect(engine).toContain('this.generatorRevision++;');
  });
});

describe('R2 — FREEZE stores one quantity, not two (§A0)', () => {
  it('a frozen mapping still respects its output range', () => {
    const s = new SmoothingState();
    const m = mapping({ min: 0.2, max: 0.8, frozenValue: 0.5 });
    // Before: the frozen branch returned clamp(frozenValue,0,1) and skipped
    // the range entirely, so freezing jumped the contribution to the full span.
    expect(shapeMappingValue(m, {}, s, 1 / 60)).toBeCloseTo(0.5, 10);
    expect(shapedUnitValue(m, {}, s, 1 / 60)).toBeCloseTo(0.5, 10);
  });

  it('a centred signal frozen while still stays centred', () => {
    // The case that would break bipolar motion: min -1 / max 1, signal 0.5.
    const s = new SmoothingState();
    const live = shapeMappingValue(mapping({ min: -1, max: 1 }), { bass: 0.5 }, s, 1 / 60);
    const frozen = shapeMappingValue(
      mapping({ min: -1, max: 1, frozenValue: 0.5 }),
      {},
      new SmoothingState(),
      1 / 60,
    );
    expect(live).toBeCloseTo(0, 10);
    expect(frozen).toBeCloseTo(live, 10);
  });

  it('preview and export capture the same quantity', () => {
    // Preview stores smoothing.peek (pre-range); export stored
    // shapeMappingValue (post-range) and then re-clamped it to 0..1.
    const runner = src('src', 'export', 'exportRunner.ts');
    expect(runner).toContain('shapedUnitValue(m, lastSources, smoothing, 0)');
    expect(runner).not.toContain('shapeMappingValue(m, lastSources');
  });
});

describe('R3 — the Output receives what the replica reads (§A0)', () => {
  it('toFrameMsg forwards sourceParams and transition', () => {
    // Both are declared on FrameStateMsg and read by replica.ts, but were
    // never copied — so generators rendered with unmodulated params on the
    // Output and morph transitions never appeared there at all.
    const bridge = src('src', 'output', 'outputBridge.ts');
    expect(bridge).toContain('sourceParams: frame.sourceParams');
    expect(bridge).toContain('transition: frame.transition');
  });

  it('still forwards only resolved values — the replica evaluates nothing', () => {
    const bridge = src('src', 'output', 'outputBridge.ts');
    for (const banned of ['evalSources', 'SourceContext', 'analysis', 'applyModulations']) {
      expect(bridge).not.toContain(banned);
    }
  });
});

describe('R4 — source params can tell "not yet" from "nothing" (§A0)', () => {
  it('lastSourceValues starts null so the fallback is reachable', () => {
    // `{} ?? x` is `{}`, so an empty-object initialiser made the fallback dead
    // code and skipped every source.* mapping on the first frame.
    const runtime = src('src', 'modulation', 'runtime.ts');
    expect(runtime).toMatch(/lastSourceValues: Record<string, number> \| null = null;/);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FeedbackClock, FeedbackSurface, FEEDBACK_STEP_RATE } from '@/rendering/feedback/FeedbackSurface';
import { feedbackDefinitions } from '@/techniques/feedback/definitions';
import { getTechnique } from '@/techniques/registry';

/** CE1B — feedback primitive semantics + structural gates. */

describe('FeedbackSurface (ping-pong)', () => {
  it('read and write are always distinct targets, before and after swap', () => {
    const s = new FeedbackSurface(64, 36);
    expect(s.read).not.toBe(s.write);
    const r0 = s.read;
    const w0 = s.write;
    s.swap();
    expect(s.read).toBe(w0);
    expect(s.write).toBe(r0);
    expect(s.read).not.toBe(s.write);
    s.dispose();
  });

  it('reset marks unprimed and bumps generation; resize reallocates + resets', () => {
    const s = new FeedbackSurface(64, 36);
    s.primed = true;
    const g = s.generation;
    s.reset();
    expect(s.primed).toBe(false);
    expect(s.generation).toBe(g + 1);
    s.primed = true;
    s.resize(64, 36); // same size — no-op
    expect(s.primed).toBe(true);
    s.resize(128, 72);
    expect(s.primed).toBe(false);
    expect(s.width).toBe(128);
    expect(s.bytes).toBe(128 * 72 * 4 * 2);
    s.dispose();
  });
});

describe('FeedbackClock (the CE1B clock decision)', () => {
  it('advances at the fixed step rate regardless of render rate', () => {
    // 120fps render for one second → ~60 steps, never 120.
    const c = new FeedbackClock();
    let clock = 10;
    let steps = c.advance(clock); // prime step
    for (let i = 0; i < 120; i++) {
      clock += 1 / 120;
      steps += c.advance(clock);
    }
    expect(steps).toBeGreaterThanOrEqual(59);
    expect(steps).toBeLessThanOrEqual(62);

    // 60fps render for one second → same evolution.
    const c2 = new FeedbackClock();
    let clock2 = 10;
    let steps2 = c2.advance(clock2);
    for (let i = 0; i < 60; i++) {
      clock2 += 1 / 60;
      steps2 += c2.advance(clock2);
    }
    expect(Math.abs(steps2 - steps)).toBeLessThanOrEqual(2);
  });

  it('caps interactive catch-up so a stall cannot burst', () => {
    const c = new FeedbackClock();
    c.advance(0);
    expect(c.advance(10)).toBe(4); // 600 owed, capped
  });

  it('export stepping is exact and range-splittable (preroll gate §85)', () => {
    // Full range 0→2s must equal 0→0.7s plus 0.7→2s step-for-step.
    const whole = FeedbackClock.stepsBetween(0, 2);
    const a = FeedbackClock.stepsBetween(0, 0.7);
    const b = FeedbackClock.stepsBetween(0.7, 2);
    expect(a + b).toBe(whole);
    expect(whole).toBe(2 * FEEDBACK_STEP_RATE);
    // Deterministic: same inputs, same answer.
    expect(FeedbackClock.stepsBetween(17.381, 20)).toBe(
      FeedbackClock.stepsBetween(17.381, 20),
    );
  });
});

describe('feedback techniques', () => {
  it('all seven are registered with curated playable ranges', () => {
    expect(feedbackDefinitions).toHaveLength(7);
    for (const d of feedbackDefinitions) {
      expect(getTechnique(d.id)).not.toBeNull();
      expect(d.category).toBe('feedback');
      const params = d.sections.flatMap((s) => s.params);
      // Shared state vocabulary present with one meaning (§42-43).
      for (const id of ['persistence', 'injection', 'mix']) {
        expect(params.some((p) => p.id === id), `${d.id} missing ${id}`).toBe(true);
      }
      const zoom = params.find((p) => p.id === 'zoom');
      if (zoom && zoom.type === 'number') {
        expect(zoom.min).toBeGreaterThan(0.9); // curated, not 0–10 (§41)
        expect(zoom.max).toBeLessThan(1.2);
      }
      const persistence = params.find((p) => p.id === 'persistence');
      expect(persistence?.type).toBe('number');
      if (persistence?.type === 'number') {
        expect(persistence.default).toBeGreaterThan(0.85); // visible by default (§40)
        expect(persistence.max).toBeLessThan(1); // 1.0 would never decay
      }
    }
  });
});

describe('structural gates (§5, §16, §86-87)', () => {
  const read = (...parts: string[]) => readFileSync(join(__dirname, '..', ...parts), 'utf8');
  const code = (...parts: string[]) =>
    read(...parts)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('feedback is GPU-only: no readback, no CPU frame arrays', () => {
    for (const file of [
      ['src', 'rendering', 'feedback', 'FeedbackSurface.ts'],
      ['src', 'rendering', 'feedback', 'feedbackStep.ts'],
      ['src', 'techniques', 'feedback', 'FeedbackRenderer.ts'],
    ] as const) {
      const src = code(...file);
      for (const banned of ['readPixels', 'ImageData', 'toDataURL', 'getImageData', 'Blob']) {
        expect(src.includes(banned), `${file.join('/')}: ${banned}`).toBe(false);
      }
    }
  });

  it('feedback state never reaches the output channel or the project schema', () => {
    const channel = code('shared', 'outputChannel.ts').toLowerCase();
    const schema = code('shared', 'schemas', 'project.ts').toLowerCase();
    for (const banned of ['feedback']) {
      expect(channel.includes(banned), 'outputChannel must not carry feedback').toBe(false);
      expect(schema.includes(banned), 'project schema must not carry feedback state').toBe(false);
    }
  });

  it('reset matrix is wired: source change, context restore, candidate release', () => {
    const engine = code('src', 'rendering', 'RenderEngine.ts');
    const setSource = engine.slice(engine.indexOf('setSource(texture'), engine.indexOf('setComposition('));
    expect(setSource.includes('resetFeedback()')).toBe(true);
    const restored = engine.slice(engine.indexOf('onContextRestored'));
    expect(restored.slice(0, 400).includes('resetFeedback()')).toBe(true);
    const candidate = code('src', 'performance', 'candidateRuntime.ts');
    expect(candidate.includes('engine.resetFeedback()')).toBe(true);
  });

  it('export path steps feedback deterministically', () => {
    const runner = code('src', 'export', 'exportRunner.ts');
    expect(runner.includes('prepareFeedbackForExport(timeSec, i === 0, params)')).toBe(true);
  });

  it('preview prepass runs on wall time; export never runs the preview prepass', () => {
    const engine = code('src', 'rendering', 'RenderEngine.ts');
    expect(engine.includes('feedbackPrepass?.(renderer, performance.now() / 1000)')).toBe(true);
    // feedbackActive is false in exportMode, and the loop gates on it.
    expect(engine.includes('!this.exportMode')).toBe(true);
    expect(
      engine.includes('!this.dirty && !this.liveSourceActive && !this.feedbackActive'),
    ).toBe(true);
  });
});

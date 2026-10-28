import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LayerHost } from '@/rendering/layers/LayerHost';
import type { LayerRuntime } from '@/rendering/layers/layerRuntime';
import type { LayerRenderState } from '@/rendering/layers/layerTypes';

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');

/**
 * v0.6.1 — LayerHost takes its runtime factory as a constructor argument, so
 * the layer set can be tested for real instead of by reading source text.
 *
 * That matters beyond convenience: every one of these was a source-text gate
 * in v0.6, which meant it asserted that a line existed rather than that the
 * behaviour held. A fake runtime asserts the behaviour.
 */
function fakeRuntime(over: Partial<LayerRuntime> = {}): LayerRuntime {
  const base = {
    initBranch: vi.fn(),
    disposeBranch: vi.fn(),
    handleContextRestored: vi.fn(),
    setComposition: vi.fn(),
    setSeed: vi.fn(),
    setTime: vi.fn(),
    setParamTransform: vi.fn(),
    setTechniqueChain: vi.fn(),
    setTechniqueScratchTargets: vi.fn(),
    setSource: vi.fn(),
    setLiveSourceActive: vi.fn(),
    renderLayerTo: vi.fn(),
    renderLayerToWithParams: vi.fn(),
    renderLayerToCanvas: vi.fn(),
    liveSourceActive: false,
    generatorActive: false,
    isFeedbackTechnique: false,
    feedbackActive: false,
    isTemporalActive: false,
    hasGenerator: false,
    hasTechniqueChain: false,
    beginExportMode: vi.fn(),
    endExportMode: vi.fn(),
    prepareGeneratorForExport: vi.fn(),
    prepareFlowForExport: vi.fn(),
    prepareFeedbackForExport: vi.fn(),
    prepareTemporalForExport: vi.fn(async () => []),
    updateVisualStatsForExport: vi.fn(),
    setExportPreviousTime: vi.fn(),
    resetTemporal: vi.fn(),
    setVisualDemand: vi.fn(),
    setVisualSink: vi.fn(),
    visualSignalStats: null,
    visualDiagnostics: null,
    lastResolved: null,
    resolvedSourceParams: vi.fn(() => ({})),
  };
  return { ...base, ...over } as unknown as LayerRuntime;
}

const state = (id: string, over: Partial<LayerRenderState> = {}): LayerRenderState => ({
  id,
  enabled: true,
  opacity: 1,
  blendMode: 'normal',
  selected: false,
  ...over,
});

/** A host whose runtimes are handed back so a test can inspect them. */
function hostWith(runtimes: Record<string, LayerRuntime>) {
  const made: LayerRuntime[] = [];
  const host = new LayerHost(() => {
    const next = Object.values(runtimes)[made.length] ?? fakeRuntime();
    made.push(next);
    return next;
  });
  return { host, made };
}

describe('v0.6.1 — LayerHost owns identity and lifetime', () => {
  it('allocates, resizes, reuses and releases shared technique scratch targets', () => {
    const runtime = fakeRuntime({ hasTechniqueChain: true });
    const { host } = hostWith({ a: runtime });
    host.sync([state('a')]);
    host.adoptRenderer({} as never);

    const initial = (runtime.setTechniqueScratchTargets as ReturnType<typeof vi.fn>).mock.lastCall?.[0];
    expect(initial).toHaveLength(2);
    expect(initial[0].width).toBe(1920);
    expect(initial[0].height).toBe(1080);
    const disposeInitial = vi.spyOn(initial[0], 'dispose');
    const lastTargets = () => (runtime.setTechniqueScratchTargets as ReturnType<typeof vi.fn>).mock.lastCall?.[0];

    host.setComposition(1280, 720, '#000');
    const resized = lastTargets();
    expect(resized).toHaveLength(2);
    expect(resized[0].width).toBe(1280);
    expect(resized[0].height).toBe(720);
    const disposeResized = vi.spyOn(resized[0], 'dispose');

    host.setComposition(1280, 720, '#fff');
    expect(lastTargets()).toBe(resized);

    // renderStill flips export size ↔ preview size every frame: both pairs are
    // reused, nothing is reallocated or disposed.
    for (let frame = 0; frame < 3; frame++) {
      host.setComposition(1920, 1080, '#000');
      expect(lastTargets()).toBe(initial);
      host.setComposition(1280, 720, '#000');
      expect(lastTargets()).toBe(resized);
    }
    expect(disposeInitial).not.toHaveBeenCalled();

    // A third size evicts the least recently used pair (1920×1080 here).
    host.setComposition(640, 360, '#000');
    expect(disposeInitial).toHaveBeenCalledOnce();
    expect(disposeResized).not.toHaveBeenCalled();
    expect(lastTargets()[0].width).toBe(640);

    (runtime as { hasTechniqueChain: boolean }).hasTechniqueChain = false;
    host.setTechniqueChain('a', []);
    expect(disposeResized).toHaveBeenCalledOnce();
    expect((runtime.setTechniqueScratchTargets as ReturnType<typeof vi.fn>).mock.lastCall?.[0]).toBeNull();
  });

  it('keys runtimes by layer id, so reordering rebuilds nothing', () => {
    const a = fakeRuntime();
    const b = fakeRuntime();
    const { host } = hostWith({ a, b });
    host.sync([state('a', { selected: true }), state('b')]);
    const beforeA = host.runtimeFor('a');
    const beforeB = host.runtimeFor('b');
    host.sync([state('b'), state('a', { selected: true })]);
    expect(host.runtimeFor('a')).toBe(beforeA);
    expect(host.runtimeFor('b')).toBe(beforeB);
    expect(a.disposeBranch).not.toHaveBeenCalled();
    expect(b.disposeBranch).not.toHaveBeenCalled();
    expect(host.layerIds).toEqual(['b', 'a']);
  });

  it('disposes a runtime when its layer goes away, and only that one', () => {
    const a = fakeRuntime();
    const b = fakeRuntime();
    const { host } = hostWith({ a, b });
    host.sync([state('a', { selected: true }), state('b')]);
    host.sync([state('a', { selected: true })]);
    expect(b.disposeBranch).toHaveBeenCalledTimes(1);
    expect(a.disposeBranch).not.toHaveBeenCalled();
    expect(host.layerCount).toBe(1);
  });

  it('a new renderer is adopted by every surviving runtime', () => {
    // The v0.6 bug: a runtime kept the renderer it was built with, so a
    // remount left it drawing into framebuffers the host could not read —
    // every layer black, deterministically, with no error.
    const a = fakeRuntime();
    const { host } = hostWith({ a });
    const first = { id: 1 } as never;
    const second = { id: 2 } as never;
    host.adoptRenderer(first);
    host.sync([state('a', { selected: true })]);
    expect(a.initBranch).toHaveBeenLastCalledWith(first);
    const gen = host.currentRendererGeneration;
    host.adoptRenderer(second);
    expect(a.initBranch).toHaveBeenLastCalledWith(second);
    expect(host.currentRendererGeneration).toBeGreaterThan(gen);
    expect(host.staleRuntimeCount).toBe(0);
  });

  it('adopting the same renderer twice is a no-op', () => {
    // StrictMode calls the effect twice with the same object in production
    // builds; re-binding every runtime for nothing would drop live targets.
    const a = fakeRuntime();
    const { host } = hostWith({ a });
    const r = { id: 1 } as never;
    host.adoptRenderer(r);
    const gen = host.currentRendererGeneration;
    host.adoptRenderer(r);
    expect(host.currentRendererGeneration).toBe(gen);
  });
});

describe('v0.6.1 — every question carries its scope', () => {
  it('anyLayerUsesFeedback is true for a NON-selected layer', () => {
    // This is the export-preroll bug, as a unit test. Asking the host, or the
    // selected layer, answered "no" while layer 3 ran Feedback Zoom, so the
    // preroll was skipped and every export inherited the previous history.
    const plain = fakeRuntime();
    const feedback = fakeRuntime({ isFeedbackTechnique: true });
    const { host } = hostWith({ plain, feedback });
    host.sync([state('a', { selected: true }), state('b')]);
    expect(host.anyLayerUsesFeedback()).toBe(true);
    expect(host.exportRequirements().needsFeedbackPreroll).toBe(true);
    // ...and scoped to one layer it is still answered per layer.
    expect(host.requirementsFor('a')?.needsFeedbackPreroll).toBe(false);
    expect(host.requirementsFor('b')?.needsFeedbackPreroll).toBe(true);
  });

  it('anyLayerNeedsContinuousRender covers live, feedback and simulation', () => {
    for (const flag of ['liveSourceActive', 'feedbackActive', 'generatorActive'] as const) {
      const { host } = hostWith({ a: fakeRuntime(), b: fakeRuntime({ [flag]: true }) });
      host.sync([state('a', { selected: true }), state('b')]);
      expect(host.anyLayerNeedsContinuousRender(), `${flag} must keep the loop awake`).toBe(true);
    }
    const { host } = hostWith({ a: fakeRuntime(), b: fakeRuntime() });
    host.sync([state('a', { selected: true }), state('b')]);
    expect(host.anyLayerNeedsContinuousRender()).toBe(false);
  });

  it('export requirements aggregate across every layer, not the selected one', () => {
    const { host } = hostWith({
      a: fakeRuntime(),
      b: fakeRuntime({ isTemporalActive: true }),
      c: fakeRuntime({ hasGenerator: true }),
    });
    host.sync([state('a', { selected: true }), state('b'), state('c')]);
    const req = host.exportRequirements();
    expect(req.needsTemporalHistory).toBe(true);
    expect(req.needsGenerator).toBe(true);
  });

  it('a live device is counted by consumers, not by layers', () => {
    const { host } = hostWith({ a: fakeRuntime(), b: fakeRuntime(), c: fakeRuntime() });
    host.sync([state('a', { selected: true }), state('b'), state('c')]);
    host.setLiveLayerKinds(new Map([['a', 'camera'], ['b', 'camera'], ['c', 'capture']]));
    expect(host.consumerCountFor('camera')).toBe(2);
    expect(host.consumerCountFor('capture')).toBe(1);
  });

  it('one acquisition reaches every layer showing it', () => {
    const a = fakeRuntime();
    const b = fakeRuntime();
    const { host } = hostWith({ a, b });
    host.sync([state('a', { selected: true }), state('b')]);
    host.setLiveLayerKinds(new Map([['a', 'camera'], ['b', 'camera']]));
    const tex = { id: 'cam' } as never;
    host.setLiveSource('camera', tex);
    expect(a.setSource).toHaveBeenLastCalledWith(tex);
    expect(b.setSource).toHaveBeenLastCalledWith(tex);
    expect(a.setLiveSourceActive).toHaveBeenLastCalledWith(true);
  });
});

describe('v0.6.1 — authority beats anything the host could re-derive', () => {
  it('an authority opacity wins over the live sink', () => {
    // The Output replica has no sink and was falling through to the stored
    // value, so it ignored the opacity it had just been sent.
    const { host } = hostWith({ a: fakeRuntime() });
    host.sync([state('a', { selected: true, opacity: 1 })]);
    host.setOpacitySink(() => ({ opacity: 0.25 }));
    expect(host.resolvedOpacityFor('a')).toBe(0.25);
    host.setAuthorityOpacity(new Map([['a', 0.8]]));
    expect(host.resolvedOpacityFor('a')).toBe(0.8);
  });

  it('leaving export mode drops authority values', () => {
    // Or a layer keeps rendering the last exported frame's parameters.
    const { host } = hostWith({ a: fakeRuntime() });
    host.sync([state('a', { selected: true, opacity: 1 })]);
    host.setAuthorityOpacity(new Map([['a', 0.1]]));
    host.endExportMode();
    expect(host.resolvedOpacityFor('a')).toBe(1);
  });

  it('with no sink and no authority the stored value stands', () => {
    const { host } = hostWith({ a: fakeRuntime() });
    host.sync([state('a', { selected: true, opacity: 0.42 })]);
    expect(host.resolvedOpacityFor('a')).toBe(0.42);
  });
});

describe('v0.6.1 — analysis follows demand, per layer', () => {
  it('a layer nobody routes from is told to analyse nothing', () => {
    const a = fakeRuntime();
    const b = fakeRuntime();
    const { host } = hostWith({ a, b });
    host.sync([state('a', { selected: true }), state('b')]);
    host.setVisualSink(() => undefined);
    host.setVisualDemandByLayer(
      new Map([
        ['a', new Set(['motion.amount'])],
        ['b', new Set()],
      ] as never),
    );
    expect((a.setVisualDemand as never as { mock: { calls: unknown[][] } }).mock.calls.at(-1)?.[0]).toEqual(
      new Set(['motion.amount']),
    );
    expect((b.setVisualDemand as never as { mock: { calls: unknown[][] } }).mock.calls.at(-1)?.[0]).toEqual(
      new Set(),
    );
    // And a layer with no demand gets no sink, so it cannot publish either.
    expect((b.setVisualSink as never as { mock: { calls: unknown[][] } }).mock.calls.at(-1)?.[0]).toBeNull();
  });

  it('without a per-layer split the selected layer carries the demand', () => {
    const a = fakeRuntime();
    const b = fakeRuntime();
    const { host } = hostWith({ a, b });
    host.sync([state('a'), state('b', { selected: true })]);
    host.setVisualSink(() => undefined);
    host.setFlatVisualDemand(new Set(['image.luminance']) as never);
    expect((b.setVisualDemand as never as { mock: { calls: unknown[][] } }).mock.calls.at(-1)?.[0]).toEqual(
      new Set(['image.luminance']),
    );
    expect((a.setVisualDemand as never as { mock: { calls: unknown[][] } }).mock.calls.at(-1)?.[0]).toEqual(
      new Set(),
    );
  });
});

describe('v0.6.1 — the API makes scope unmissable', () => {
  it('no host-scoped creative predicate survives on RenderEngine', () => {
    // The v0.6 defect family, forbidden structurally: the engine must not
    // answer a question about the layer set from its own fields.
    const engine = read('src', 'rendering', 'RenderEngine.ts');
    const host = engine.slice(engine.indexOf('private readonly layerHost'));
    for (const banned of ['this.branches', 'this.layerStates', 'this.selectedLayerIndex']) {
      expect(host.includes(banned), `RenderEngine must not reach for ${banned}`).toBe(false);
    }
  });

  it('every set-scoped question on LayerHost says so in its name', () => {
    const src = read('src', 'rendering', 'layers', 'LayerHost.ts');
    const setScoped = [...src.matchAll(/^  (\w+)\(/gm)]
      .map((m) => m[1] as string)
      .filter((n) => /^(any|all|has|consumer|export)/.test(n));
    expect(setScoped.length).toBeGreaterThan(3);
    // A bare creative predicate with no scope in its name is the thing that
    // went wrong nine times in v0.6.
    for (const banned of ['generatorActive(', 'feedbackActive(', 'liveSourceActive(']) {
      expect(src.includes(banned), `LayerHost must not expose ${banned}`).toBe(false);
    }
  });
});

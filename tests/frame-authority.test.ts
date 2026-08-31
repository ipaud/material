import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { modulationRuntime } from '@/modulation/runtime';
import type { ModulationMapping } from '@shared/schemas/project';

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');

const mapping = (over: Partial<ModulationMapping> = {}): ModulationMapping =>
  ({
    id: 'm',
    enabled: true,
    source: 'beat:1/4',
    target: 'scale',
    amount: 1,
    min: 0,
    max: 1,
    invert: false,
    smoothing: 0.4,
    curve: 'linear',
    frozenValue: null,
    mode: 'replace',
    ...over,
  }) as ModulationMapping;

/** Configure N layers, all driven by the same single mapping on layer 0. */
function configure(nLayers: number) {
  modulationRuntime.reset();
  modulationRuntime.configureLayers(
    Array.from({ length: nLayers }, (_, i) => ({
      layerId: 'L' + i,
      techniqueId: 'mosaic',
      mappings: i === 0 ? [mapping()] : [],
      signalSource: new Map(i === 0 ? [['m', 'L0']] : []),
    })),
    'L0',
  );
  modulationRuntime.configure([mapping()], 'mosaic', {
    analysis: null,
    durationSec: 10,
    bpm: 120,
    beatOffsetSec: 0,
    beatsPerBar: 4,
  });
}

/** Resolve the same timeline, marking exactly one frame per step. */
function sequence(nLayers: number): number[] {
  configure(nLayers);
  const out: number[] = [];
  for (let i = 0; i < 24; i++) {
    const t = i * 0.05;
    modulationRuntime.markFrame();
    // Every layer resolves within the frame, exactly as the render loop does.
    for (let l = 0; l < nLayers; l++) modulationRuntime.transformFor('L' + l, { scale: 1 }, t);
    out.push(Math.round((modulationRuntime.transformFor('L0', { scale: 1 }, t).scale as number) * 1e6) / 1e6);
  }
  return out;
}

describe('v0.6.1 — one frame, one dt', () => {
  beforeEach(() => modulationRuntime.reset());

  it('smoothing is layer-count invariant', () => {
    // The v0.6C bug: previewDt advanced its own clock on every call, and the
    // runtime is asked for a step by the primary layer, by every secondary
    // layer and by every layer's opacity. One frame's dt was split between
    // them, so smoothing ran slower in proportion to the layer count.
    const one = sequence(1);
    const four = sequence(4);
    expect(four).toEqual(one);
  });

  it('...and the sequence it compares actually moves', () => {
    // Two constant sequences agree trivially. This is the companion that
    // fails when the timeline is dead, so the test above cannot pass on a
    // frozen mapping.
    const one = sequence(1);
    expect(new Set(one).size).toBeGreaterThan(12);
    expect(Math.max(...one) - Math.min(...one)).toBeGreaterThan(0.05);
  });

  it('dt is computed once and reused inside a frame', () => {
    const src = read('src', 'modulation', 'runtime.ts');
    const fn = src.slice(src.indexOf('private previewDt('));
    expect(fn.slice(0, 900)).toContain('if (this.frameDt !== null) return this.frameDt;');
    // ...and the engine is what opens the frame.
    const engine = read('src', 'rendering', 'RenderEngine.ts');
    const loop = engine.slice(engine.indexOf('private loop = ()'));
    expect(loop.slice(0, 1400)).toContain('this.frameSink?.()');
    const bridge = read('src', 'rendering', 'engineBridge.ts');
    expect(bridge).toContain('engine.setFrameSink(() => modulationRuntime.markFrame())');
  });
});

describe('v0.6.1 — one frame, one publication', () => {
  it('a layer runtime never publishes; only the host does', () => {
    // Four layers each publishing meant the Output received one message per
    // layer per frame and showed whichever arrived last.
    //
    // v0.6.1 makes this structural rather than guarded: the runtime class has
    // no bus import and no emit call, so there is exactly ONE emitFrame site
    // in the whole tree and it is the host's.
    const runtime = read('src', 'rendering', 'layers', 'LayerRuntimeImpl.ts');
    expect(runtime.includes('runtimeBus'), 'a runtime must not reach the bus').toBe(false);
    const engine = read('src', 'rendering', 'RenderEngine.ts');
    expect((engine.match(/runtimeBus\.emitFrame\(/g) ?? []).length).toBe(1);
    expect(engine).toContain('private publishComposition()');
  });

  it('the host publishes after compositing, on every path that draws', () => {
    const engine = read('src', 'rendering', 'RenderEngine.ts');
    // Both the direct fast path and the composite path publish.
    const frame = engine.slice(engine.indexOf('  private renderFrame()'));
    expect((frame.match(/this\.publishComposition\(\)/g) ?? []).length).toBe(2);
  });
});

describe('v0.6.1 — the frame order is documented and followed', () => {
  it('the authority order is written down', () => {
    const doc = read('docs', 'RENDER_RUNTIME.md');
    for (const stage of ['clock', 'sources', 'signals', 'mappings', 'resolved state', 'composite', 'publish']) {
      expect(doc.includes(stage), `frame order must document "${stage}"`).toBe(true);
    }
  });

  it('a branch in export mode never falls back to the live transform', () => {
    // The live transform reads wall time. A branch syncing its scene through
    // it mid-render made two runs of the same export disagree.
    const runtime = read('src', 'rendering', 'layers', 'LayerRuntimeImpl.ts');
    const sync = runtime.slice(runtime.indexOf('private syncScene('));
    expect(sync.slice(0, 1200)).toContain('this.paramTransform && !this.exportMode');
  });
});

describe('v0.6.1 — a rebuilt runtime is configured from scratch', () => {
  it('the bridge memo is invalidated when the runtime object changes', () => {
    // A remount rebuilds every layer runtime. The bridge memo is keyed on
    // SOURCE identity, so an unchanged source short-circuited the whole
    // reconciliation and nothing was ever attached to the new runtime: the
    // composition went black and stayed black, with no error.
    //
    // Confirmed present in v0.6.0 by running the same dispose/init/resync
    // sequence against a v0.6.0 worktree, so this is a fix rather than a
    // refactor artefact. Recorded as a behavioural change in DECISIONS.md.
    const bridge = read('src', 'rendering', 'engineBridge.ts');
    expect(bridge).toContain('configuredRuntime: unknown;');
    const sync = bridge.slice(bridge.indexOf('function syncLayerSource('));
    const body = sync.slice(0, 1200);
    expect(body).toContain('state.configuredRuntime !== branch');
    // Both memos have to go, not just the source one.
    expect(body).toContain('state.sourceKey = null');
    expect(body).toContain('state.techniqueId = null');
    // ...and the invalidation must happen BEFORE the unchanged-source
    // short-circuit, or it can never run.
    expect(body.indexOf('state.configuredRuntime !== branch')).toBeLessThan(
      body.indexOf('if (key === state.sourceKey)'),
    );
  });

  it('a cached render is keyed on every input that changes the picture', () => {
    // The generator bug: ensure() rebuilds the target when the size changes,
    // but the redraw cache was keyed on params and time, neither of which
    // moves when only the size does — so it served a blank texture.
    const gen = read('src', 'sources', 'generators', 'GeneratorSource.ts');
    expect(gen).toContain('const reallocated = this.ensure(');
    expect(gen).toContain('if (!force && !reallocated &&');
  });
});

describe('v0.6.1 — authority values have exactly one owner', () => {
  it('the engine keeps no second copy of the resolved layer params', () => {
    // Caught by the v0.6.0 reference comparison, not by the suite: the engine
    // still had its own authorityLayerParams field while the export prerolls
    // read the host's. The prerolls were handed undefined, so a feedback or
    // motion layer prerolled from live state and full-vs-subrange dropped to
    // 4/12 and 0/12 — while repeat determinism stayed a perfect 12/12, which
    // is precisely how a self-referential baseline would have missed it.
    const engine = read('src', 'rendering', 'RenderEngine.ts');
    expect(engine.includes('private authorityLayerParams'), 'no second copy').toBe(false);
    expect(engine).toContain('this.layerHost.setAuthorityParams(params)');
    // Everything that reads them reads the host.
    const still = engine.slice(engine.indexOf('renderStill('));
    expect(still).toContain('this.layerHost.authorityParamsSnapshot');
  });

  it('export preroll asks the SET, never the selected technique', () => {
    // A stateful system on a non-selected layer must still be prerolled.
    const engine = read('src', 'rendering', 'RenderEngine.ts');
    const feedback = engine.slice(engine.indexOf('get isFeedbackTechnique()'));
    expect(feedback.slice(0, 400)).toContain('this.layerHost.anyLayerUsesFeedback()');
    const host = read('src', 'rendering', 'layers', 'LayerHost.ts');
    const req = host.slice(host.indexOf('exportRequirements(): LayerRequirements {'));
    // Aggregated with `some` across every layer, not read off one of them.
    expect(req.slice(0, 800)).toContain('all.some((r) => r.needsFeedbackPreroll)');
    expect(req.slice(0, 800)).toContain('all.some((r) => r.needsTemporalHistory)');
  });
});

describe('v0.6.1 — the transport follows the CURRENT first video layer', () => {
  it('the binding is re-evaluated, not latched on the first video ever seen', () => {
    // Found by building a real four-layer scene on real footage. The guard
    // was `if (!playback.hasVideo)`, which only asks "is anything attached" —
    // so once a video was bound the transport kept it even after the layer
    // that owned it had been replaced. Measured: the composition clock
    // advanced to 15 s while all three video layers sat paused at 0.02 s,
    // driving an orphaned decoder from an earlier import. Optical flow saw no
    // new frames, so every motion signal read exactly zero and every
    // cross-layer route into them was silently inert.
    const bridge = read('src', 'rendering', 'engineBridge.ts');
    expect(bridge).toContain('function syncTransportVideo()');
    const fn = bridge.slice(bridge.indexOf('function syncTransportVideo()'));
    const body = fn.slice(0, 1200);
    // It picks the FIRST video layer in stack order...
    expect(body).toContain('for (const layer of project.layers)');
    expect(body).toContain('runtime instanceof FileVideoSource');
    expect(body).toContain('break;');
    // ...compares against what is currently attached...
    expect(body).toContain('if (first === playback.currentVideo) return;');
    // ...and detaches when no layer holds a video at all.
    expect(body).toContain('playback.detachVideo()');

    // The old latch must be gone: no attach guarded only by hasVideo.
    expect(bridge.includes('if (!playback.hasVideo) {'), 'the latch is gone').toBe(false);

    // And it runs on every reconcile, plus after each async load resolves,
    // because loads finish out of order.
    const sync = bridge.slice(bridge.indexOf('  for (const layer of project.layers) {'));
    expect(sync.slice(0, 400)).toContain('syncTransportVideo()');
    expect((bridge.match(/syncTransportVideo\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

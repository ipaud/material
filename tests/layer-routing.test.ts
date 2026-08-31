import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createEmptyProject,
  emptyLayer,
  type ModulationMapping,
  type Project,
} from '@shared/schemas/project';
import {
  crossLayerRoutes,
  feedbackLoops,
  mappingsByTarget,
  sourceLayerOf,
  targetLayerOf,
} from '@/modulation/layerRouting';

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');

function map(id: string, over: Partial<ModulationMapping> = {}): ModulationMapping {
  return {
    id,
    enabled: true,
    source: 'motion.amount',
    target: 'scale',
    amount: 1,
    min: 0,
    max: 1,
    invert: false,
    smoothing: 0,
    curve: 'linear',
    frozenValue: null,
    ...over,
  } as ModulationMapping;
}

/** Camera → Reaction Diffusion → Video, the shape v0.6 exists for. */
function stack(mappings: ModulationMapping[]): Project {
  const p = createEmptyProject('routing');
  return {
    ...p,
    layers: [
      { ...p.layers[0]!, id: 'cam', name: 'Camera' },
      { ...emptyLayer('rd', 'Reaction Diffusion') },
      { ...emptyLayer('vid', 'Video') },
    ],
    selectedLayerId: 'cam',
    modulations: mappings,
  };
}

describe('v0.6B — where a mapping reads from and writes to', () => {
  it('a mapping with neither id drives the bottom layer from its own signals', () => {
    // This is what every v0.4 and v0.5 project looks like after migration, and
    // it has to keep meaning "the project's one technique, driven by the
    // project's one image".
    const p = stack([map('m1')]);
    expect(targetLayerOf(p, p.modulations[0]!)).toBe('cam');
    expect(sourceLayerOf(p, p.modulations[0]!)).toBe('cam');
  });

  it('the source defaults to the target, not to the bottom layer', () => {
    const p = stack([map('m1', { targetLayerId: 'rd' })]);
    expect(sourceLayerOf(p, p.modulations[0]!)).toBe('rd');
  });

  it('target never follows the SELECTED layer', () => {
    // Selection is UI state. A stored mapping that followed it would render
    // differently depending on what happened to be selected at open time.
    const a = stack([map('m1')]);
    const b: Project = { ...a, selectedLayerId: 'vid' };
    expect(targetLayerOf(b, b.modulations[0]!)).toBe(targetLayerOf(a, a.modulations[0]!));
  });

  it('routes survive reordering, because they are ids and not indices', () => {
    const p = stack([map('m1', { targetLayerId: 'rd', sourceLayerId: 'cam' })]);
    const reordered: Project = { ...p, layers: [...p.layers].reverse() };
    expect(targetLayerOf(reordered, p.modulations[0]!)).toBe('rd');
    expect(sourceLayerOf(reordered, p.modulations[0]!)).toBe('cam');
  });

  it('a route to a deleted layer falls back instead of throwing', () => {
    const p = stack([map('m1', { targetLayerId: 'gone', sourceLayerId: 'alsogone' })]);
    expect(targetLayerOf(p, p.modulations[0]!)).toBe('cam');
    expect(sourceLayerOf(p, p.modulations[0]!)).toBe('cam');
  });

  it('groups every mapping under exactly one target, and names every layer', () => {
    const p = stack([map('m1'), map('m2', { targetLayerId: 'rd' }), map('m3', { targetLayerId: 'rd' })]);
    const by = mappingsByTarget(p);
    expect([...by.keys()].sort()).toEqual(['cam', 'rd', 'vid']);
    expect(by.get('cam')!.map((m) => m.id)).toEqual(['m1']);
    expect(by.get('rd')!.map((m) => m.id)).toEqual(['m2', 'm3']);
    expect(by.get('vid')).toEqual([]);
    expect([...by.values()].reduce((n, v) => n + v.length, 0)).toBe(p.modulations.length);
  });

  it('reports the flagship routing and does not call own-layer a route', () => {
    // Camera motion drives the RD centre and the video's opacity.
    const p = stack([
      map('own', { targetLayerId: 'cam', target: 'scale' }),
      map('centre', { targetLayerId: 'rd', sourceLayerId: 'cam', source: 'motion.centroidX', target: 'centerX' }),
      map('fade', { targetLayerId: 'vid', sourceLayerId: 'cam', source: 'motion.amount', target: 'opacity' }),
    ]);
    const routes = crossLayerRoutes(p);
    expect(routes.map((r) => `${r.from}->${r.to}`)).toEqual(['cam->rd', 'cam->vid']);
    expect(routes.some((r) => r.mappingId === 'own')).toBe(false);
  });

  it('a disabled mapping is not a route', () => {
    const p = stack([map('m1', { targetLayerId: 'rd', sourceLayerId: 'cam', enabled: false })]);
    expect(crossLayerRoutes(p)).toEqual([]);
  });

  it('reports a two-layer loop rather than forbidding it', () => {
    // Legal and desirable: each hop samples frame N-1, so a loop settles at
    // one frame of latency instead of deadlocking.
    const p = stack([
      map('a', { targetLayerId: 'rd', sourceLayerId: 'vid' }),
      map('b', { targetLayerId: 'vid', sourceLayerId: 'rd' }),
    ]);
    const loops = feedbackLoops(p);
    expect(loops).toHaveLength(1);
    expect([...loops[0]!].sort()).toEqual(['rd', 'vid']);
  });

  it('an acyclic stack reports no loop', () => {
    const p = stack([
      map('a', { targetLayerId: 'rd', sourceLayerId: 'cam' }),
      map('b', { targetLayerId: 'vid', sourceLayerId: 'rd' }),
    ]);
    expect(feedbackLoops(p)).toEqual([]);
  });

  it('each branch resolves its own parameters and publishes its own analysis', () => {
    const engine = read('src', 'rendering', 'RenderEngine.ts');
    expect(engine).toContain('setLayerParamTransform');
    expect(engine).toContain('setVisualDemandByLayer');
    // A layer nobody routes from must release its reduction targets.
    const apply = engine.slice(engine.indexOf('private applyBranchVisualDemand()'));
    expect(apply.slice(0, 700)).toContain('EMPTY_VISUAL_DEMAND');
    const bridge = read('src', 'rendering', 'engineBridge.ts');
    expect(bridge).toContain('modulationRuntime.transformFor(layerId, base, t)');
    expect(bridge).toContain('modulationRuntime.setLayerVisualStats(layerId, stats');
  });

  it('calibration is scoped per layer, so two layers on one camera share it', () => {
    const bridge = read('src', 'rendering', 'engineBridge.ts');
    const block = bridge.slice(bridge.indexOf('const originCtx ='));
    expect(block.slice(0, 600)).toContain('modulationRuntime.setLayerVisualOrigin(l.id, pixelOriginKey(src');
  });
  it('export resolves every layer, not only the primary', () => {
    // The main evaluator covers the layer morphs and Look replay apply to.
    // Without this, every other layer rendered its stored base parameters and
    // a cross-layer route drove the preview but vanished from the render.
    const runner = read('src', 'export', 'exportRunner.ts');
    expect(runner).toContain('createSecondaryLayerEvaluator');
    expect(runner).toContain('engine.setAuthorityLayerParams(');
    // Walked in the preroll too, or a subrange enters with no smoothing
    // history and disagrees with a full export.
    const preroll = runner.slice(runner.indexOf('for (let f = 0; f < startFrame; f++)'));
    expect(preroll.slice(0, 900)).toContain('evaluateLayers.paramsAt(frame.timeSec)');
    // Opacity carries smoothing state of its own and must be walked too.
    expect(preroll.slice(0, 900)).toContain('evaluateLayers.opacityAt(frame.timeSec)');
  });

  it('resolved layer params are published before anything reads them', () => {
    // The feedback prepass primes each branch from that branch's parameters.
    // Publishing them afterwards primed frame N from frame N-1.
    const runner = read('src', 'export', 'exportRunner.ts');
    const loop = runner.slice(runner.indexOf('for (let i = 0; i < totalFrames; i++)'));
    const publish = loop.indexOf('engine.setAuthorityLayerParams(');
    const feedback = loop.indexOf('engine.prepareFeedbackForExport(');
    const flow = loop.indexOf('engine.prepareFlowForExport(');
    expect(publish).toBeGreaterThan(-1);
    expect(publish).toBeLessThan(feedback);
    expect(publish).toBeLessThan(flow);
  });

  it('a branch in export mode never falls back to the live transform', () => {
    // The live transform reads wall time. A branch syncing its scene through
    // it mid-render made two runs of the same export disagree.
    const engine = read('src', 'rendering', 'RenderEngine.ts');
    const sync = engine.slice(engine.indexOf('private syncScene('));
    expect(sync.slice(0, 900)).toContain('this.paramTransform && !this.exportMode');
  });

  it('feedback history anywhere in the stack counts as feedback', () => {
    // The host holds no technique in layer mode. Asking only about itself
    // skipped the feedback preroll while still setting `prerolled`, so the
    // first real frame declared itself not-first and the surface was never
    // reset: every export inherited the previous one's history.
    const engine = read('src', 'rendering', 'RenderEngine.ts');
    const getter = engine.slice(engine.indexOf('get isFeedbackTechnique()'));
    expect(getter.slice(0, 400)).toContain('this.branches.some((b) => b.engine.isFeedbackTechnique)');
  });

  it('the Output still receives resolved values and no signals', () => {
    // Layers add routing, which is an EDITOR concern. Nothing about it may
    // reach the replica: it renders from resolved values or not at all.
    const channel = read('shared', 'outputChannel.ts');
    const frame = channel.slice(channel.indexOf('export interface FrameStateMsg'));
    const body = frame.slice(0, frame.indexOf('}'));
    for (const forbidden of ['sourceValues', 'visualStats', 'modulations', 'signal', 'pixels']) {
      expect(body.includes(forbidden), `FrameStateMsg must not carry ${forbidden}`).toBe(false);
    }
    expect(body).toContain('finalParams');
  });

  it('smoothing advances on wall time while the transport is parked', () => {
    // A live camera with the transport stopped is THE v0.6 performance case,
    // and transport dt is exactly zero there: every smoothed mapping froze at
    // its first sample. Export is untouched — it runs its own evaluator.
    const runtime = read('src', 'modulation', 'runtime.ts');
    expect(runtime).toContain('private previewDt(');
    const fn = runtime.slice(runtime.indexOf('private previewDt('));
    expect(fn.slice(0, 900)).toContain('transportDt > 0 ? transportDt : wallDt');
    // And computed once per frame, or each layer would consume a share of it.
    expect(fn.slice(0, 900)).toContain('if (this.frameDt !== null) return this.frameDt;');
  });
});

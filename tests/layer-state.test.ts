import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createEmptyProject,
  emptyLayer,
  renderedLayers,
  type Layer,
  type ModulationMapping,
} from '@shared/schemas/project';
import { SmoothingState } from '@/modulation/evaluator';
import {
  LAYER_OPACITY_TARGET,
  applyLayerModulations,
  isLayerTarget,
} from '@/modulation/layerState';
import { BLEND_MODE_INDEX, blendChannel, compositeChannel } from '@/rendering/layers/LayerCompositor';

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');

function map(over: Partial<ModulationMapping> = {}): ModulationMapping {
  return {
    id: 'm',
    enabled: true,
    source: 'motion.amount',
    target: LAYER_OPACITY_TARGET,
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

const layer = (over: Partial<Layer> = {}): Layer => ({ ...emptyLayer('L', 'L'), ...over });

describe('v0.6C — modulating the layer, not the technique inside it', () => {
  it('a signal moves layer opacity in both directions', () => {
    const out = applyLayerModulations(
      { opacity: 0 },
      [map({ mode: 'replace' } as Partial<ModulationMapping>)],
      { 'motion.amount': 1 },
      new SmoothingState(),
      1 / 60,
    );
    expect(out.opacity).toBeGreaterThan(0.9);
    // And back down: the mode is spelled 'replace' in the schema even though
    // the UI and the docs call it Set, and an Add mapping with a zero signal
    // correctly leaves the stored value alone — which looks identical to a
    // broken route unless both directions are asserted.
    const down = applyLayerModulations(
      { opacity: 1 },
      [map({ mode: 'replace', amount: 0.5 } as Partial<ModulationMapping>)],
      { 'motion.amount': 0 },
      new SmoothingState(),
      1 / 60,
    );
    expect(down.opacity).toBeCloseTo(0.5, 3);
  });

  it('a signal with nothing behind it leaves opacity exactly as stored', () => {
    // Absence is the neutral, project-wide: a missing signal must not be
    // read as zero, or invert or a non-zero min would manufacture a fade.
    const out = applyLayerModulations(
      { opacity: 0.42 },
      [map({ invert: true, min: 0.3 })],
      {},
      new SmoothingState(),
      1 / 60,
    );
    expect(out.opacity).toBe(0.42);
  });

  it('resolved opacity stays inside 0..1', () => {
    const out = applyLayerModulations(
      { opacity: 1 },
      [map({ amount: 8, min: 0, max: 1 })],
      { 'motion.amount': 1 },
      new SmoothingState(),
      1 / 60,
    );
    expect(out.opacity).toBeLessThanOrEqual(1);
    expect(out.opacity).toBeGreaterThanOrEqual(0);
  });

  it('no mappings means no work and the stored value back', () => {
    const stored = { opacity: 0.7 };
    expect(applyLayerModulations(stored, [], {}, new SmoothingState(), 1 / 60)).toBe(stored);
  });

  it('only the layer namespace is a layer target', () => {
    expect(isLayerTarget(LAYER_OPACITY_TARGET)).toBe(true);
    expect(isLayerTarget('scale')).toBe(false);
    expect(isLayerTarget('source.frequency')).toBe(false);
  });

  it('blend mode is not modulatable, and nothing pretends it is', () => {
    // A choice from a list has no continuum to interpolate along. If this ever
    // becomes a target it has to be a trigger action, not a mapping.
    const src = read('src', 'modulation', 'layerState.ts');
    expect(src.includes("'layer.blendMode'")).toBe(false);
    expect(src.includes("'layer.enabled'")).toBe(false);
  });
});

describe('v0.6C — enabled, opacity and solo are three different things', () => {
  it('a disabled layer does not render', () => {
    const ls = [layer({ id: 'a' }), layer({ id: 'b', enabled: false })];
    expect(renderedLayers(ls).map((l) => l.id)).toEqual(['a']);
  });

  it('a layer at zero opacity still renders', () => {
    // It costs, deliberately: a feedback or simulation branch that stopped
    // would lose what it has been accumulating, and fading back up would start
    // from nothing instead of resuming.
    const ls = [layer({ id: 'a', opacity: 0 })];
    expect(renderedLayers(ls).map((l) => l.id)).toEqual(['a']);
    const host = read('src', 'rendering', 'layers', 'LayerHost.ts');
    const at = host.indexOf('private visibleIndices()');
    expect(host.slice(at - 400, at + 400)).toContain('Opacity 0 still RENDERS');
  });

  it('solo overrides enabled without touching it', () => {
    const ls = [
      layer({ id: 'a' }),
      layer({ id: 'b', solo: true }),
      layer({ id: 'c', enabled: false }),
    ];
    expect(renderedLayers(ls).map((l) => l.id)).toEqual(['b']);
    // The others are untouched, so releasing solo restores the stack exactly.
    expect(ls[0]!.enabled).toBe(true);
    expect(ls[2]!.enabled).toBe(false);
    expect(renderedLayers(ls.map((l) => ({ ...l, solo: false }))).map((l) => l.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('a soloed but disabled layer renders nothing at all', () => {
    const ls = [layer({ id: 'a' }), layer({ id: 'b', solo: true, enabled: false })];
    expect(renderedLayers(ls)).toEqual([]);
  });

  it('solo is exclusive', () => {
    const src = read('src', 'projects', 'layerActions.ts');
    const fn = src.slice(src.indexOf('export function toggleLayerSolo'));
    expect(fn.slice(0, 600)).toContain('solo: l.id === layerId ? next : false');
  });

  it('solo is resolved once, in the bridge, and never written to the store', () => {
    const bridge = read('src', 'rendering', 'engineBridge.ts');
    expect(bridge).toContain('renderedLayers(project.layers)');
    const engine = read('src', 'rendering', 'RenderEngine.ts');
    expect(engine.includes('solo'), 'the engine must not know the solo rule').toBe(false);
  });

  it('a new project has no solo and full opacity', () => {
    const p = createEmptyProject('c');
    expect(p.layers[0]!.solo).toBe(false);
    expect(p.layers[0]!.opacity).toBe(1);
  });
});

describe('v0.6C — blend', () => {
  it('every blend mode in the schema is implemented', () => {
    const src = read('shared', 'schemas', 'project.ts');
    const declared = src
      .slice(src.indexOf('export const blendModeSchema'))
      .slice(0, 200)
      .match(/'([a-z]+)'/g)!
      .map((s) => s.replaceAll("'", ''));
    for (const mode of declared) expect(BLEND_MODE_INDEX).toHaveProperty(mode);
    expect(Object.keys(BLEND_MODE_INDEX).sort()).toEqual([...declared].sort());
  });

  it('normal returns the source, and the maths matches per channel', () => {
    expect(blendChannel('normal', 0.2, 0.8)).toBeCloseTo(0.8, 6);
    expect(blendChannel('multiply', 0.5, 0.5)).toBeCloseTo(0.25, 6);
    expect(blendChannel('screen', 0.5, 0.5)).toBeCloseTo(0.75, 6);
    expect(blendChannel('difference', 0.8, 0.3)).toBeCloseTo(0.5, 6);
    expect(blendChannel('lighten', 0.3, 0.7)).toBeCloseTo(0.7, 6);
    expect(blendChannel('darken', 0.3, 0.7)).toBeCloseTo(0.3, 6);
    // blendChannel is the RAW blend function; clamping belongs to the
    // compositor, which is also what the shader does (clamp after blend).
    expect(blendChannel('add', 0.6, 0.7)).toBeCloseTo(1.3, 6);
    expect(compositeChannel('add', 0.6, 0.7, 1)).toBeCloseTo(1, 6);
  });

  it('the fast path checks RESOLVED opacity, not the stored value', () => {
    // A layer faded by a signal must go through the compositor even though the
    // project still says 1.
    const host = read('src', 'rendering', 'layers', 'LayerHost.ts');
    const fn = host.slice(host.indexOf('private singleOpaqueIndex()'));
    expect(fn.slice(0, 600)).toContain('this.effectiveOpacityAt(only) < 1');
  });

  it('export resolves layer opacity from authority, never from the live sink', () => {
    // MIGRATED v0.6.1: "an authority opacity wins over the live sink" is now
    // a behavioural test in tests/layer-host.test.ts.
    const host = read('src', 'rendering', 'layers', 'LayerHost.ts');
    const fn = host.slice(host.indexOf('private effectiveOpacityAt('));
    expect(fn.slice(0, 500)).toContain('this.authorityOpacity');
    const runner = read('src', 'export', 'exportRunner.ts');
    expect(runner).toContain('engine.setAuthorityLayerOpacity(');
  });
});

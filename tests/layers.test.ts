import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_LAYERS,
  MIGRATED_LAYER_ID,
  blendModeSchema,
  createEmptyProject,
  emptyLayer,
  layerSchema,
  parseProject,
  projectSchema,
  selectedLayerOf,
  withSelectedSource,
  type Project,
} from '@shared/schemas/project';
import { PROJECT_FORMAT_VERSION } from '@shared/constants/app';
import { blendChannel, compositeChannel } from '@/rendering/layers/LayerCompositor';

/**
 * v0.6A — the layer model and the migration that has to be invisible.
 *
 * The product rule these defend: MULTIPLE VISUAL MATERIALS CAN COEXIST AND BE
 * PLAYED TOGETHER. Not a timeline, not a node graph — a small, bounded number
 * of complete branches and one place that blends them.
 */

const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')) as Record<string, unknown>;

describe('the layer cap is a product decision, not an array length', () => {
  it('is bounded, and the schema enforces it', () => {
    expect(MAX_LAYERS).toBeLessThanOrEqual(4);
    expect(MAX_LAYERS).toBeGreaterThanOrEqual(3);
    const base = createEmptyProject();
    const tooMany = {
      ...base,
      layers: Array.from({ length: MAX_LAYERS + 1 }, (_, i) => emptyLayer(`l${i}`)),
    };
    expect(projectSchema.safeParse(tooMany).success).toBe(false);
  });

  it('a composition always has at least one layer', () => {
    const base = createEmptyProject();
    expect(projectSchema.safeParse({ ...base, layers: [] }).success).toBe(false);
    expect(base.layers).toHaveLength(1);
  });

  it('a layer is a BRANCH, not a stack — exactly one technique', () => {
    // An effect chain inside a layer is deliberately out of scope: that is the
    // road to a compositor, and the product is an instrument.
    const shape = layerSchema.shape;
    expect('technique' in shape).toBe(true);
    expect('techniques' in shape).toBe(false);
    expect('effects' in shape).toBe(false);
    expect('children' in shape).toBe(false);
  });

  it('a layer carries CONFIG only — no runtime ever reaches a file', () => {
    const serialized = JSON.stringify(layerSchema.shape);
    for (const forbidden of ['texture', 'renderTarget', 'runtime', 'framebuffer', 'program']) {
      expect(serialized.toLowerCase().includes(forbidden)).toBe(false);
    }
  });
});

describe('v3 → v4 migration is invisible (§14, §16, §17)', () => {
  it('the format version moved, because the change could not be additive', () => {
    // v3 has exactly ONE place to say what renders. A parallel `layers` field
    // beside it would have left two sources of truth.
    expect(PROJECT_FORMAT_VERSION).toBe(4);
  });

  it('a v3 project becomes exactly one layer holding its whole branch', () => {
    const v3 = {
      ...createEmptyProject(),
      version: 3,
      sources: [{ id: 'src_a', kind: 'image', path: '/tmp/a.png', metadata: null }],
      composition: {
        sourceId: 'src_a',
        audioSourceId: null,
        width: 1920,
        height: 1080,
        background: '#101010',
      },
      techniques: [{ id: 'tech_1', techniqueId: 'mosaic', enabled: true, params: { columns: 18 } }],
      material: { materialId: 'circle', colorMode: 'mono', params: { aspect: 1 }, assetPath: null },
    } as unknown as Record<string, unknown>;
    delete v3.layers;
    delete v3.selectedLayerId;

    const parsed = parseProject(v3);
    expect(parsed.version).toBe(4);
    expect(parsed.layers).toHaveLength(1);
    const layer = parsed.layers[0]!;
    expect(layer.id).toBe(MIGRATED_LAYER_ID);
    expect(layer.sourceId).toBe('src_a');
    expect(layer.technique?.techniqueId).toBe('mosaic');
    expect(layer.technique?.params.columns).toBe(18);
    expect(layer.material.materialId).toBe('circle');
    // Full opacity, Normal blend: the composite of one such layer IS the layer,
    // which is why a migrated project renders identically.
    expect(layer.opacity).toBe(1);
    expect(layer.blendMode).toBe('normal');
    expect(layer.enabled).toBe(true);
    expect(parsed.selectedLayerId).toBe(MIGRATED_LAYER_ID);
  });

  it('the migrated layer id is DETERMINISTIC', () => {
    // Two machines migrating the same file must agree, or a route stored
    // against that id would resolve differently on each.
    const make = () => {
      const v3 = { ...createEmptyProject(), version: 3 } as unknown as Record<string, unknown>;
      delete v3.layers;
      delete v3.selectedLayerId;
      return parseProject(v3).layers[0]!.id;
    };
    expect(make()).toBe(make());
    expect(make()).toBe(MIGRATED_LAYER_ID);
  });

  it('global state is untouched by the migration', () => {
    const v3 = {
      ...createEmptyProject(),
      version: 3,
      timeline: { inSec: null, outSec: null, loop: true, bpm: 128, beatOffsetSec: 0.25, beatsPerBar: 4, markers: [] },
      modulations: [
        {
          id: 'm1',
          enabled: true,
          source: 'bass',
          target: 'scale',
          amount: 0.5,
          min: 0,
          max: 1,
          invert: false,
          smoothing: 0.25,
          curve: 'linear',
          frozenValue: null,
        },
      ],
    } as unknown as Record<string, unknown>;
    delete v3.layers;
    delete v3.selectedLayerId;
    const parsed = parseProject(v3);
    expect(parsed.timeline.bpm).toBe(128);
    expect(parsed.timeline.beatOffsetSec).toBe(0.25);
    expect(parsed.modulations).toHaveLength(1);
    expect(parsed.modulations[0]!.source).toBe('bass');
    // A pre-v0.6 mapping names no layer: it belongs to the one that exists.
    expect(parsed.modulations[0]!.targetLayerId).toBeUndefined();
    expect(parsed.modulations[0]!.sourceLayerId).toBeUndefined();
  });

  it('every committed fixture still opens, at v4', () => {
    const parsed = parseProject(fixture('project-v2-pattern.json'));
    expect(parsed.version).toBe(4);
    expect(parsed.layers).toHaveLength(1);
  });

  it('a v4 project round-trips unchanged', () => {
    const base = createEmptyProject();
    const withLayers = {
      ...base,
      layers: [
        { ...emptyLayer('a', 'Back'), opacity: 0.5, blendMode: 'screen' as const },
        emptyLayer('b', 'Front'),
      ],
      selectedLayerId: 'b',
    };
    const reparsed = parseProject(JSON.parse(JSON.stringify(withLayers)));
    expect(reparsed.layers.map((l) => l.id)).toEqual(['a', 'b']);
    expect(reparsed.layers[0]!.opacity).toBe(0.5);
    expect(reparsed.layers[0]!.blendMode).toBe('screen');
    expect(reparsed.selectedLayerId).toBe('b');
  });
});

describe('blend math is one documented formula (§73)', () => {
  const B = 0.6;
  const S = 0.4;

  it('every mode matches its stated definition exactly', () => {
    expect(blendChannel('normal', B, S)).toBe(S);
    expect(blendChannel('add', B, S)).toBeCloseTo(1.0, 10);
    expect(blendChannel('screen', B, S)).toBeCloseTo(1 - 0.4 * 0.6, 10);
    expect(blendChannel('multiply', B, S)).toBeCloseTo(0.24, 10);
    expect(blendChannel('difference', B, S)).toBeCloseTo(0.2, 10);
    expect(blendChannel('lighten', B, S)).toBe(0.6);
    expect(blendChannel('darken', B, S)).toBe(0.4);
  });

  it('opacity 0 is EXACTLY the backdrop, in every mode', () => {
    // The property that makes opacity a safe performance control: a layer can
    // be faded out without its mode leaking any contribution.
    for (const mode of blendModeSchema.options) {
      expect(compositeChannel(mode, B, S, 0)).toBe(B);
    }
  });

  it('opacity 1 is exactly the blend, in every mode', () => {
    for (const mode of blendModeSchema.options) {
      expect(compositeChannel(mode, B, S, 1)).toBeCloseTo(
        Math.min(Math.max(blendChannel(mode, B, S), 0), 1),
        10,
      );
    }
  });

  it('half opacity is half way there', () => {
    expect(compositeChannel('normal', 1, 0, 0.5)).toBeCloseTo(0.5, 10);
    expect(compositeChannel('multiply', 0.8, 0.5, 0.5)).toBeCloseTo(0.8 + (0.4 - 0.8) * 0.5, 10);
  });

  it('the curated list stays small (§71)', () => {
    expect(blendModeSchema.options.length).toBeLessThanOrEqual(7);
    expect(blendModeSchema.options).toContain('normal');
  });
});

describe('structural — layers reuse the branch, they do not fork it (§7)', () => {
  it('a layer runtime IS a RenderEngine in branch mode', () => {
    const engine = read('src', 'rendering', 'RenderEngine.ts');
    expect(engine).toContain('initBranch(renderer: THREE.WebGLRenderer)');
    expect(engine).toContain('renderLayerTo(');
    expect(engine).toContain('disposeBranch()');
    // No parallel implementation of the branch behaviours.
    expect(read('src', 'rendering', 'layers', 'LayerCompositor.ts').includes('OpticalFlowField')).toBe(false);
    expect(read('src', 'rendering', 'layers', 'LayerCompositor.ts').includes('TemporalFrameProvider')).toBe(false);
  });

  it('branch identity is the layer ID, so reordering rebuilds nothing', () => {
    // MIGRATED v0.6.1: the behaviour is asserted for real in
    // tests/layer-host.test.ts ("keys runtimes by layer id, so reordering
    // rebuilds nothing"). What remains here is the structural half — reuse is
    // decided by id, and the only index computed is which layer is SELECTED,
    // which is editing focus and changes no runtime.
    const host = read('src', 'rendering', 'layers', 'LayerHost.ts');
    const sync = host.slice(host.indexOf('sync(states: readonly LayerRenderState[])'));
    expect(sync.slice(0, 1400)).toContain('this.slots.find((s) => s.id === state.id)');
    expect(sync.slice(0, 1400)).not.toContain('states[');
    expect(sync.slice(0, 1400)).not.toContain('this.slots[i]');
  });

  it('the compositor holds exactly two accumulators, whatever the layer count', () => {
    const comp = read('src', 'rendering', 'layers', 'LayerCompositor.ts');
    expect(comp).toContain('accumulators: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null');
  });

  it('compositing lives in ONE place, never inside a technique', () => {
    // A technique that knew what was beneath it would be a second compositor,
    // and the same blend would end up written once per technique.
    for (const f of [
      ['mosaic', 'definition.ts'],
      ['feedback', 'definitions.ts'],
      ['time-field', 'definition.ts'],
      ['motion', 'definitions.ts'],
    ]) {
      const src = read('src', 'techniques', f[0] as string, f[1] as string);
      expect(src.includes('blendMode'), `${f[0]} knows about blend modes`).toBe(false);
      expect(src.includes('LayerCompositor')).toBe(false);
    }
  });

  it('the bridge reconciles per layer, so one source change cannot reset another', () => {
    const bridge = read('src', 'rendering', 'engineBridge.ts');
    expect(bridge).toContain('function syncLayerSource(');
    expect(bridge).toContain('const state = bridgeState(layer.id)');
    // The old module-wide singletons are gone.
    expect(bridge.includes('let activeSourceRuntime')).toBe(false);
    expect(bridge.includes('let activeTechniqueId')).toBe(false);
  });
  it('choosing a source puts it on the SELECTED layer, not only on the composition', () => {
    // A layer whose sourceId stays null renders nothing, so a UI path that
    // only moved composition.sourceId produced a black layer with no error.
    const p = createEmptyProject('src-routing');
    const withSrc: Project = {
      ...p,
      sources: [{ id: 'g1', kind: 'generator', generator: 'noise', params: {}, seed: 1 }],
    };
    const after = withSelectedSource(withSrc, 'g1');
    expect(selectedLayerOf(after).sourceId).toBe('g1');
    expect(after.composition.sourceId).toBe('g1');
  });

  it('every UI path that selects a source goes through withSelectedSource', () => {
    for (const f of [
      ['src', 'library', 'LibraryPanel.tsx'],
      ['src', 'projects', 'projectActions.ts'],
    ]) {
      const src = read(...(f as [string, string, string]));
      expect(src).toContain('withSelectedSource');
      // No bare composition-only source assignment survives.
      expect(/composition:\s*\{[^}]*[^Audio]sourceId: id/.test(src), `${f[2]} assigns sourceId directly`).toBe(
        false,
      );
    }
  });
  it('a remount adopts surviving branches instead of orphaning them', () => {
    // A branch caches the renderer it was built with. StrictMode's double
    // effect, a workspace switch and a restored context all build a NEW
    // WebGLRenderer on the same canvas, and a branch still holding the old one
    // draws into framebuffers the host cannot read: every layer goes black,
    // deterministically and with no error. Caught only by looking at pixels.
    // MIGRATED v0.6.1: adoption is LayerHost's explicit job and is tested
    // behaviourally in tests/layer-host.test.ts. What stays here is that the
    // engine actually asks for it on init and tears down on dispose.
    const src = read('src', 'rendering', 'RenderEngine.ts');
    const init = src.slice(src.indexOf('init(canvas: HTMLCanvasElement)'));
    expect(init.slice(0, 1600)).toContain('this.layerHost.adoptRenderer(this.renderer)');
    const dispose = src.slice(src.indexOf('  dispose(): void {'));
    expect(dispose.slice(0, 900)).toContain('this.layerHost.disposeAll()');
    const host = read('src', 'rendering', 'layers', 'LayerHost.ts');
    const adopt = host.slice(host.indexOf('adoptRenderer(renderer'));
    // A target allocated by the previous renderer is unreadable by the new one.
    expect(adopt.slice(0, 600)).toContain('slot.target = null');
  });

  it('bindTarget sets no viewport and no pixel ratio', () => {
    // setViewport multiplies by the renderer pixel ratio, so on a 2x display
    // it installs a 2x viewport and every offscreen pass renders zoomed into
    // its own target (measured: the generator produced 175 335 non-black
    // pixels instead of 192 588). setPixelRatio is setSize() and reallocates
    // the drawing buffer. setRenderTarget already installs the right viewport.
    const src = read('src', 'rendering', 'bindTarget.ts');
    const body = src.slice(src.indexOf('export function bindTarget'));
    expect(body).toContain('renderer.setRenderTarget(target)');
    expect(body.includes('setViewport'), 'bindTarget must not set a viewport').toBe(false);
    expect(body.includes('setPixelRatio'), 'bindTarget must not set a pixel ratio').toBe(false);
  });

  it('a reallocated generator target is redrawn, not served empty', () => {
    // ensure() disposes and rebuilds the target when the size changes, but the
    // redraw cache is keyed on params and time — neither of which moves — so
    // the early return handed back a blank texture nothing ever filled.
    const src = read('src', 'sources', 'generators', 'GeneratorSource.ts');
    expect(src).toContain('const reallocated = this.ensure(');
    expect(src).toContain('if (!force && !reallocated &&');
  });
  it('the render loop stays awake for a layer that is still animating', () => {
    // A live source, feedback and a simulation generator are the three things
    // that keep the loop rendering without an explicit invalidate. All three
    // moved onto the branches, so the host's own flags read false forever and
    // it went back to sleep after each invalidation: 19 rendered frames per
    // second where rAF was running at 120, with nothing in the UI to show it.
    // MIGRATED v0.6.1: the three flags are covered behaviourally in
    // tests/layer-host.test.ts "anyLayerNeedsContinuousRender covers live,
    // feedback and simulation". What stays here is that the LOOP asks.
    const src = read('src', 'rendering', 'RenderEngine.ts');
    const loop = src.slice(src.indexOf('private loop = ()'));
    expect(loop.slice(0, 1200)).toContain('!this.layerHost.anyLayerNeedsContinuousRender()');
  });

  it('one opaque Normal layer bypasses the compositor in preview', () => {
    // The common case must not pay for a layer target, a background clear, a
    // blend pass and a blit. Export already had this path; preview did not.
    const src = read('src', 'rendering', 'RenderEngine.ts');
    const preview = src.slice(src.indexOf('if (!this.layerHost.isEmpty) {', src.indexOf('private renderFrame')));
    expect(preview.slice(0, 1600)).toContain('this.layerHost.renderSingleOpaqueToCanvas(renderer)');
    // And the rule itself, where it now lives.
    const host = read('src', 'rendering', 'layers', 'LayerHost.ts');
    const fn = host.slice(host.indexOf('private singleOpaqueIndex()'));
    expect(fn.slice(0, 600)).toContain("state.blendMode !== 'normal'");
  });
});

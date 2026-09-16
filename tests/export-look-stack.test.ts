import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyProject, type PinnedLook, type Project } from '@shared/schemas/project';
import { useProjectStore } from '@/state/projectStore';
import { createFrameEvaluator } from '@/export/exportRunner';

/**
 * v0.8.3 — an export follows a Look that changes what a layer is MADE OF.
 *
 * v0.6D made a Look recall restore the whole stack in preview. Export only
 * ever applied the primary layer's core, so a Look that pointed a layer at a
 * different generator changed the mosaic parameters and left the picture on
 * the old source. Found by making a piece whose three Looks were three Chladni
 * plates: preview showed three figures, export showed one figure dressed
 * three ways. Nothing in the suite had ever recalled a Look that switched a
 * source.
 */

const L1 = 'layer_1';
const L2 = 'layer_2';

function look(id: string, slot: number, stack: { l1: string; l2: string }): PinnedLook {
  const base = createEmptyProject();
  const tech = (n: number) => ({ id: `t${n}`, techniqueId: 'mosaic', enabled: true, params: { scale: n } });
  return {
    id,
    createdAt: '',
    label: id,
    note: '',
    slot,
    seed: 1,
    thumbnail: null,
    techniques: [tech(1)],
    // The stack a v0.6D Look carries: which source each layer reads.
    layers: [
      { id: L1, name: 'A', enabled: true, opacity: 1, blendMode: 'normal', sourceId: stack.l1, technique: tech(1), material: base.layers[0]!.material },
      { id: L2, name: 'B', enabled: true, opacity: 0.5, blendMode: 'screen', sourceId: stack.l2, technique: tech(2), material: base.layers[0]!.material },
    ],
    selectedLayerId: L1,
    material: base.layers[0]!.material,
    modulations: [],
    triggers: [],
  };
}

function project(): Project {
  const base = createEmptyProject();
  const gen = (id: string, modeX: number) => ({
    id, kind: 'generator' as const, generator: 'chladni', params: { modeX, modeY: 3 }, seed: 11,
  });
  return {
    ...base,
    sources: [gen('gA', 2), gen('gB', 7)],
    layers: [
      { ...base.layers[0]!, id: L1, sourceId: 'gA', technique: { id: 't1', techniqueId: 'mosaic', enabled: true, params: { scale: 1 } } },
      { ...base.layers[0]!, id: L2, sourceId: 'gA', opacity: 0.3, blendMode: 'normal', technique: { id: 't2', techniqueId: 'mosaic', enabled: true, params: { scale: 2 } } },
    ],
    selectedLayerId: L1,
    pinnedLooks: [look('look_a', 1, { l1: 'gA', l2: 'gA' }), look('look_b', 2, { l1: 'gB', l2: 'gB' })],
    // A bar trigger recalls slot 2 at the first bar — the same path a Take's
    // look.recall or a pad takes into the working copy.
    triggers: [{
      id: 'trg', enabled: true, source: 'bar', action: 'applyLook', targetParam: null,
      targetMappingId: null, lookSlot: 2, quantize: 'off', cooldownSec: 0,
      attackSec: 0.01, holdSec: 0, decaySec: 0.18, amount: 1, curve: 'easeOut',
    }],
    timeline: { ...base.timeline, bpm: 120, beatOffsetSec: 0, beatsPerBar: 4, loop: false },
  };
}

beforeEach(() => {
  useProjectStore.setState({ project: project(), past: [], future: [], dirty: false, silent: false });
});

describe('the export working copy carries the layer stack', () => {
  it('starts as the document', () => {
    const evaluate = createFrameEvaluator(0, 30);
    evaluate(0);
    expect(evaluate.layerStack().map((l) => l.sourceId)).toEqual(['gA', 'gA']);
    expect(evaluate.layerStack().map((l) => l.blendMode)).toEqual(['normal', 'normal']);
  });

  it('a recalled Look moves EVERY layer to the source the Look says', () => {
    const evaluate = createFrameEvaluator(0, 30);
    for (let f = 0; f <= 2 * 30; f++) evaluate(f); // the bar at 2s recalls look_b
    expect(evaluate.layerStack().map((l) => l.sourceId)).toEqual(['gB', 'gB']);
    // …and the rest of the stack came with it, the way it does live.
    expect(evaluate.layerStack()[1]).toMatchObject({ opacity: 0.5, blendMode: 'screen' });
  });

  it('the stack is a new object only when a Look changed it', () => {
    // The export loop uses array identity as its "did anything change" — so
    // an unchanged stack must be the SAME array, or the bridge is asked to
    // reconcile on every frame of every export.
    const evaluate = createFrameEvaluator(0, 30);
    evaluate(0);
    const before = evaluate.layerStack();
    evaluate(1);
    expect(evaluate.layerStack()).toBe(before);
    for (let f = 2; f <= 2 * 30; f++) evaluate(f);
    expect(evaluate.layerStack()).not.toBe(before);
  });

  it('applies the core to the layer the Look selects, in that order', () => {
    const evaluate = createFrameEvaluator(0, 30);
    let last = evaluate(0);
    for (let f = 1; f <= 2 * 30; f++) last = evaluate(f);
    // look_b's core is scale 1 on its selected layer; the recall landed.
    expect(last.params.scale).toBe(1);
  });
});

describe('the export loop follows the stack, and puts it back', () => {
  const runner = readFileSync(resolve(process.cwd(), 'src/export/exportRunner.ts'), 'utf8');
  const bridge = readFileSync(resolve(process.cwd(), 'src/rendering/engineBridge.ts'), 'utf8');

  it('reconciles sources on both the preroll walk and the real frames', () => {
    expect((runner.match(/followStack\(\);/g) ?? []).length).toBe(2);
  });

  it('goes through the SAME reconciliation the store path uses', () => {
    // Not a parallel source loader: the bridge's own syncLayerSource, so its
    // memo of what it configured stays truthful through the export.
    expect(bridge).toMatch(/export function syncLayersForExport/);
    expect(bridge).toMatch(/syncLayerSource\(project, layer, null, null\);/);
  });

  it('re-keys visual-signal calibration to the source the layer now reads', () => {
    // A calibration envelope is keyed by pixel origin. The static map from the
    // document would keep calibrating a layer moved to another generator
    // against the old one's range.
    const follow = runner.slice(runner.indexOf('const followStack'), runner.indexOf('syncLayersForExport({'));
    expect(follow).toMatch(/layerOrigins = originsOf\(stack\);/);
  });

  it('restores the document stack when the export ends, success or not', () => {
    const finallyBlock = runner.slice(runner.lastIndexOf('} finally {'));
    expect(finallyBlock).toMatch(/resyncFromStore\(\);/);
  });

  it('leaves a file or live source where it was — those cannot swap mid-frame', () => {
    expect(bridge).toMatch(/if \(source && source\.kind !== 'generator'\) continue;/);
  });
});

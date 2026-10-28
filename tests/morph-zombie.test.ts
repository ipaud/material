import { describe, expect, it, beforeEach } from 'vitest';
import { morphRuntime } from '@/performance/morphRuntime';
import { useProjectStore } from '@/state/projectStore';
import { createEmptyProject, type PinnedLook, type Project } from '@shared/schemas/project';
import { getTechnique } from '@/techniques/registry';
import { defaultParams } from '@/techniques/types';
import { modulationRuntime } from '@/modulation/runtime';

const mosaic = getTechnique('mosaic')!;
function project(): Project {
  const p = createEmptyProject('zombie');
  const look: PinnedLook = {
    id: 'look-1', createdAt: '2026-01-01T00:00:00.000Z', label: 'T', note: '', slot: 1, seed: 1,
    thumbnail: null,
    techniques: [{ id: 't1', techniqueId: 'mosaic', enabled: true, params: { ...defaultParams(mosaic), scale: 2.5 } }],
    material: p.material, modulations: [], triggers: [],
  };
  return { ...p,
    layers: [{ ...p.layers[0]!, technique: { id: 't1', techniqueId: 'mosaic', enabled: true, params: defaultParams(mosaic) } }],
    timeline: { ...p.timeline, bpm: 120 }, pinnedLooks: [look] };
}
beforeEach(() => { morphRuntime.abortSilently(); useProjectStore.setState({ project: project(), past: [], future: [] }); });

describe('morph zombie regression (P9 hotfix)', () => {
  it('a morph armed in the future does not pin the composition after a backward loop', () => {
    morphRuntime.start('look-1', { startQuantize: 'off', duration: { mode: 'seconds', seconds: 4 }, curve: 'linear' }, 9);
    expect(morphRuntime.current).not.toBeNull();
    // Playhead loops back to t=2 — before the morph's start.
    morphRuntime.tick(2);
    expect(morphRuntime.resolveOverlay(2)).toBeNull();
    expect(morphRuntime.resolveOverlay(0)).toBeNull();
    // Still armed; it runs normally once time reaches it again.
    morphRuntime.tick(11);
    const mid = morphRuntime.resolveOverlay(11);
    expect(mid).not.toBeNull();
    morphRuntime.tick(13);
    expect(morphRuntime.current).toBeNull();
  });

  it('seeking back inside a running morph still interpolates normally', () => {
    morphRuntime.start('look-1', { startQuantize: 'off', duration: { mode: 'seconds', seconds: 4 }, curve: 'linear' }, 0);
    expect(morphRuntime.progressAt(2)).toBeCloseTo(0.5, 10);
    expect(morphRuntime.progressAt(1)).toBeCloseTo(0.25, 10); // backward inside the interval
    expect(morphRuntime.progressAt(0)).toBe(0);
    expect(morphRuntime.progressAt(-0.001)).toBeNull(); // before the start
    expect(morphRuntime.progressAt(99)).toBe(1);
  });

  it('preview stage transform uses interpolated Morph parameters by stable stage ID', () => {
    const p = project();
    const layer = p.layers[0]!;
    const from = { id: 'shared-stage', techniqueId: 'mosaic', enabled: true, params: { scale: 2 } };
    const to = { ...from, params: { scale: 10 } };
    p.layers = [{ ...layer, techniqueChain: [from] }];
    const baseLook = p.pinnedLooks[0]!;
    p.pinnedLooks = [{
      ...baseLook,
      selectedLayerId: layer.id,
      layers: [{ ...p.layers[0]!, techniqueChain: [to] }],
    }];
    useProjectStore.setState({ project: p, past: [], future: [] });
    morphRuntime.start('look-1', { startQuantize: 'off', duration: { mode: 'seconds', seconds: 4 }, curve: 'linear' }, 0);

    expect(modulationRuntime.transformStageFor(layer.id, 'shared-stage', { scale: 2 }, 2).scale).toBeCloseTo(6);
  });

  it('a pattern-driven composition is not frozen by an armed future morph', () => {
    // The historical failure mode: an armed morph plus a loop made every
    // later QA look like a Pattern bug because the overlay pinned params.
    morphRuntime.start('look-1', { startQuantize: 'off', duration: { mode: 'seconds', seconds: 4 }, curve: 'linear' }, 9);
    for (const t of [0, 1.5, 3, 8.999]) {
      expect(morphRuntime.resolveOverlay(t), `t=${t}`).toBeNull();
    }
  });
});

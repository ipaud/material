import { beforeEach, describe, expect, it } from 'vitest';
import {
  createExportRendererSync,
  createFrameEvaluator,
  type ExportRendererHost,
} from '@/export/exportRunner';
import { useProjectStore } from '@/state/projectStore';
import { getTechnique, techniqueNeedsTemporal } from '@/techniques/registry';
import { defaultParams, type TechniqueRenderer } from '@/techniques/types';
import { morphCurve } from '@/performance/interpolate';
import { createEmptyProject, type PinnedLook, type Project } from '@shared/schemas/project';
import { uid } from '@/utils/id';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lookFor(techniqueId: string, slot: number, params = {}): PinnedLook {
  const definition = getTechnique(techniqueId);
  if (!definition) throw new Error(`missing ${techniqueId}`);
  return {
    id: `look_${techniqueId}_${slot}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    label: techniqueId.toUpperCase(),
    note: '',
    slot,
    seed: slot,
    thumbnail: null,
    techniques: [
      {
        id: uid('tech'),
        techniqueId,
        enabled: true,
        params: { ...defaultParams(definition), ...params },
      },
    ],
    material: { materialId: 'square', colorMode: 'source', params: {}, assetPath: null },
    modulations: [],
    triggers: [],
  };
}

/**
 * Project: technique A live, one morph event A→B over [2, 4] seconds.
 * The technique block flips where the CURVED progress crosses 0.5 —
 * for easeInOut that is raw p = 0.5, i.e. t = 3.0 exactly.
 */
function projectWithMorph(fromId: string, toId: string): Project {
  const from = lookFor(fromId, 1);
  const to = lookFor(toId, 2, {});
  const base = createEmptyProject('Switch test');
  return {
    ...base,
    techniques: from.techniques.map((t) => ({ ...t, id: uid('tech') })),
    material: from.material,
    pinnedLooks: [from, to],
    morphEvents: [
      {
        id: 'mv1',
        startTime: 2,
        endTime: 4,
        curve: 'easeInOut',
        sourceSnapshot: {
          techniqueId: fromId,
          params: { ...from.techniques[0]!.params },
          material: from.material,
          modulations: [],
          triggers: [],
          seed: 1,
        },
        targetLookId: to.id,
      },
    ],
  };
}

class FakeHost implements ExportRendererHost {
  renderers: (TechniqueRenderer | null)[] = [];
  temporal: boolean[] = [];
  isTemporalActive = false;

  setTechniqueRenderer(renderer: TechniqueRenderer | null): void {
    this.renderers.push(renderer);
  }
  setTemporalEnabled(enabled: boolean): void {
    this.temporal.push(enabled);
    this.isTemporalActive = enabled;
  }
}

const FPS = 24;
const frameAt = (t: number) => Math.round(t * FPS);

beforeEach(() => {
  useProjectStore.setState({ project: createEmptyProject('reset') });
});

// ---------------------------------------------------------------------------
// Evaluator: techniqueId per frame
// ---------------------------------------------------------------------------

describe('frame evaluator technique boundary', () => {
  it('A: mosaic → slit-scan flips exactly where curved progress crosses 0.5', () => {
    useProjectStore.setState({ project: projectWithMorph('mosaic', 'slit-scan') });
    const evaluate = createFrameEvaluator(0, FPS);

    expect(evaluate(frameAt(1.0)).techniqueId).toBe('mosaic'); // before morph
    expect(evaluate(frameAt(2.5)).techniqueId).toBe('mosaic'); // in morph, p<0.5
    // one frame before the midpoint
    expect(evaluate(frameAt(3.0) - 1).techniqueId).toBe('mosaic');
    // exact midpoint frame: raw p = 0.5 → curved 0.5 → flips (p >= 0.5 rule)
    expect(evaluate(frameAt(3.0)).techniqueId).toBe('slit-scan');
    expect(evaluate(frameAt(3.5)).techniqueId).toBe('slit-scan'); // in morph, p>0.5
    expect(evaluate(frameAt(5.0)).techniqueId).toBe('slit-scan'); // after morph
    // sanity: the flip rule matches the shared curve helper
    expect(morphCurve(0.5, 'easeInOut')).toBeCloseTo(0.5, 9);
  });

  it('B: slit-scan → mosaic flips the other way at the same boundary', () => {
    useProjectStore.setState({ project: projectWithMorph('slit-scan', 'mosaic') });
    const evaluate = createFrameEvaluator(0, FPS);
    expect(evaluate(frameAt(2.9)).techniqueId).toBe('slit-scan');
    expect(evaluate(frameAt(3.0)).techniqueId).toBe('mosaic');
    expect(evaluate(frameAt(5.0)).techniqueId).toBe('mosaic');
  });

  it('16: after the switch the params consumed are the NEW technique’s', () => {
    useProjectStore.setState({ project: projectWithMorph('mosaic', 'slit-scan') });
    const evaluate = createFrameEvaluator(0, FPS);
    const after = evaluate(frameAt(5.0));
    // slit-scan owns 'strips'; mosaic owns 'columns'. Post-morph the working
    // copy IS look B, so its params must be slit-scan's, not mosaic defaults.
    expect(after.params).toHaveProperty('strips');
    expect(after.params).not.toHaveProperty('columns');
  });

  it('D: two evaluators over the same cross-technique morph agree frame-for-frame', () => {
    useProjectStore.setState({ project: projectWithMorph('mosaic', 'slit-scan') });
    const a = createFrameEvaluator(0, FPS);
    const b = createFrameEvaluator(0, FPS);
    for (let i = 0; i < frameAt(6); i++) {
      const fa = a(i);
      const fb = b(i);
      expect(fa.techniqueId).toBe(fb.techniqueId);
      expect(fa.params).toEqual(fb.params);
    }
  });
});

// ---------------------------------------------------------------------------
// Renderer sync seam
// ---------------------------------------------------------------------------

describe('createExportRendererSync', () => {
  it('switches renderer + temporal exactly once per technique change', () => {
    const host = new FakeHost();
    const sync = createExportRendererSync(host, 'mosaic');
    const slitParams = defaultParams(getTechnique('slit-scan')!);

    // frames before the boundary: nothing happens
    expect(sync.sync('mosaic', {})).toBe(false);
    expect(sync.sync('mosaic', {})).toBe(false);
    expect(host.renderers).toHaveLength(0);

    // boundary: one switch, temporal newly active → re-prime requested
    expect(sync.sync('slit-scan', slitParams)).toBe(true);
    expect(host.renderers).toHaveLength(1);
    expect(host.renderers[0]).not.toBeNull();
    expect(host.temporal).toEqual([true]);
    expect(techniqueNeedsTemporal('slit-scan', slitParams)).toBe(true);

    // subsequent frames of the same technique: no further switches
    expect(sync.sync('slit-scan', slitParams)).toBe(false);
    expect(host.renderers).toHaveLength(1);
  });

  it('C: same-technique morph (params only) never switches', () => {
    const host = new FakeHost();
    const sync = createExportRendererSync(host, 'mosaic');
    for (let i = 0; i < 50; i++) {
      expect(sync.sync('mosaic', { columns: 10 + i })).toBe(false);
    }
    expect(host.renderers).toHaveLength(0);
    expect(host.temporal).toHaveLength(0);
  });

  it('9: A → B → A switches each time with fresh renderer instances', () => {
    const host = new FakeHost();
    const sync = createExportRendererSync(host, 'mosaic');
    sync.sync('slit-scan', defaultParams(getTechnique('slit-scan')!));
    sync.sync('mosaic', defaultParams(getTechnique('mosaic')!));
    sync.sync('echo', defaultParams(getTechnique('echo')!));
    expect(host.renderers).toHaveLength(3);
    // distinct fresh instances, not a cached/stale renderer
    expect(new Set(host.renderers).size).toBe(3);
  });

  it('switching INTO temporal re-primes; switching between temporal techniques does not', () => {
    const host = new FakeHost();
    const sync = createExportRendererSync(host, 'mosaic'); // tile off → not temporal
    expect(sync.sync('slit-scan', defaultParams(getTechnique('slit-scan')!))).toBe(true);
    // slit-scan → echo: temporal stays active, grid times remain valid
    expect(sync.sync('echo', defaultParams(getTechnique('echo')!))).toBe(false);
    expect(host.isTemporalActive).toBe(true);
  });

  it('restore rebuilds the live technique renderer only if a switch happened', () => {
    const host = new FakeHost();
    const sync = createExportRendererSync(host, 'mosaic');
    sync.restore('mosaic', {});
    expect(host.renderers).toHaveLength(0); // nothing to restore

    sync.sync('slit-scan', defaultParams(getTechnique('slit-scan')!));
    sync.restore('mosaic', { tileMode: 'off' });
    expect(host.renderers).toHaveLength(2);
    expect(host.renderers[1]).not.toBe(host.renderers[0]);
    expect(host.temporal).toEqual([true, false]); // temporal handed back off
  });

  it('unknown technique id is ignored, renderer untouched', () => {
    const host = new FakeHost();
    const sync = createExportRendererSync(host, 'mosaic');
    expect(sync.sync('does-not-exist', {})).toBe(false);
    expect(host.renderers).toHaveLength(0);
  });
});

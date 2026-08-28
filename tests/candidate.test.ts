import { beforeEach, describe, expect, test } from 'vitest';
import { createEmptyProject } from '@shared/schemas/project';
import type { LookCore, ModulationMapping, Project } from '@shared/schemas/project';
import { getTechnique } from '@/techniques/registry';
import { emptyMutationLocks, mutateLookCore, type MutationLocks } from '@/performance/mutation';
import { captureLookCore } from '@/performance/lookCore';
import { candidateRuntime, useCandidateStore } from '@/performance/candidateRuntime';
import { useProjectStore } from '@/state/projectStore';
import { liveScheduler } from '@/signals/triggerRuntime';
import { morphRuntime } from '@/performance/morphRuntime';
import { createFrameEvaluator } from '@/export/exportRunner';
import { allParams } from '@/techniques/types';

const mosaic = getTechnique('mosaic')!;

function mod(patch: Partial<ModulationMapping> = {}): ModulationMapping {
  return {
    id: 'mod-1',
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
    ...patch,
  };
}

function core(patch: Partial<LookCore> = {}): LookCore {
  return {
    techniqueId: 'mosaic',
    params: { columns: 48, rows: 27, scale: 1, threshold: 0.1, depth: 100, maxOffsetSec: 0.5 },
    material: createEmptyProject().material,
    modulations: [mod()],
    triggers: [],
    seed: 7,
    ...patch,
  };
}

function perfProject(patch: Partial<Project> = {}): Project {
  const p = createEmptyProject('CandidateTest');
  return {
    ...p,
    techniques: [
      {
        id: 'tech-1',
        techniqueId: 'mosaic',
        enabled: true,
        params: { columns: 48, rows: 27, scale: 1, threshold: 0.1, depth: 100 },
      },
    ],
    modulations: [mod()],
    timeline: { ...p.timeline, bpm: 120 },
    ...patch,
  };
}

function locks(patch: Partial<MutationLocks> = {}): MutationLocks {
  return { ...emptyMutationLocks(), ...patch };
}

describe('mutation determinism (§26)', () => {
  test('same core + seed + intensity + locks → identical candidate', () => {
    const a = mutateLookCore(core(), mosaic, 12345, 'med', locks());
    const b = mutateLookCore(core(), mosaic, 12345, 'med', locks());
    expect(a.core).toEqual(b.core);
    expect(a.metadata.changedParams).toBe(b.metadata.changedParams);
  });

  test('different seeds diverge', () => {
    const a = mutateLookCore(core(), mosaic, 1, 'med', locks());
    const b = mutateLookCore(core(), mosaic, 2, 'med', locks());
    expect(a.core.params).not.toEqual(b.core.params);
  });

  test('mutation never leaves the explore range', () => {
    const defs = new Map(allParams(mosaic).map((d) => [d.id, d]));
    for (let seed = 1; seed <= 60; seed++) {
      const { core: out } = mutateLookCore(core(), mosaic, seed, 'high', locks());
      for (const [id, value] of Object.entries(out.params)) {
        const def = defs.get(id);
        if (!def || def.type !== 'number' || typeof value !== 'number') continue;
        const lo = def.explore?.min ?? def.min;
        const hi = def.explore?.max ?? def.max;
        // Untouched params may sit outside the explore band; mutated ones may not.
        if (value !== core().params[id]) {
          expect(value).toBeGreaterThanOrEqual(lo - 1e-6);
          expect(value).toBeLessThanOrEqual(hi + 1e-6);
        }
      }
      for (const m of out.modulations) {
        expect(m.amount).toBeGreaterThanOrEqual(-1);
        expect(m.amount).toBeLessThanOrEqual(1);
        expect(m.smoothing).toBeGreaterThanOrEqual(0);
        expect(m.smoothing).toBeLessThanOrEqual(1);
      }
    }
  });

  test('parent is never mutated in place', () => {
    const parent = core();
    const snapshot = JSON.parse(JSON.stringify(parent));
    mutateLookCore(parent, mosaic, 99, 'high', locks());
    expect(parent).toEqual(snapshot);
  });

  test('modulation topology (source/target) never moves', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const { core: out } = mutateLookCore(core(), mosaic, seed, 'high', locks());
      expect(out.modulations[0]!.source).toBe('bass');
      expect(out.modulations[0]!.target).toBe('scale');
      expect(out.modulations[0]!.id).toBe('mod-1');
    }
  });
});

describe('mutation intensity (§14)', () => {
  test('higher intensity moves values further on average', () => {
    const base = core().params.scale as number;
    const spread = (intensity: 'low' | 'med' | 'high') => {
      let total = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const { core: out } = mutateLookCore(core(), mosaic, seed, intensity, locks());
        total += Math.abs((out.params.scale as number) - base);
      }
      return total / 40;
    };
    const low = spread('low');
    const med = spread('med');
    const high = spread('high');
    expect(low).toBeLessThan(med);
    expect(med).toBeLessThan(high);
  });
});

describe('mutation locks (§15)', () => {
  test('technique lock freezes every technique param', () => {
    const { core: out } = mutateLookCore(core(), mosaic, 42, 'high', locks({ technique: true }));
    expect(out.params).toEqual(core().params);
  });

  test('signals lock freezes modulation shaping', () => {
    const { core: out } = mutateLookCore(core(), mosaic, 42, 'high', locks({ signals: true }));
    expect(out.modulations).toEqual(core().modulations);
  });

  test('timing lock freezes temporal params but leaves geometry free', () => {
    let anyGeometryMoved = false;
    for (let seed = 1; seed <= 30; seed++) {
      const { core: out } = mutateLookCore(core(), mosaic, seed, 'high', locks({ timing: true }));
      expect(out.params.maxOffsetSec).toBe(core().params.maxOffsetSec);
      if (out.params.columns !== core().params.columns) anyGeometryMoved = true;
    }
    expect(anyGeometryMoved).toBe(true);
  });

  test('color lock freezes sampling params (threshold) but not geometry', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { core: out } = mutateLookCore(core(), mosaic, seed, 'high', locks({ color: true }));
      expect(out.params.threshold).toBe(core().params.threshold);
    }
  });

  test('macros are never part of a candidate core (§16)', () => {
    const { core: out } = mutateLookCore(core(), mosaic, 5, 'high', locks());
    expect(Object.keys(out)).not.toContain('macros');
  });
});

describe('candidate runtime — non-destructive (§1, §4)', () => {
  beforeEach(() => {
    candidateRuntime.reset();
    morphRuntime.abortSilently();
    useCandidateStore.setState({ intensity: 'med', locks: emptyMutationLocks() });
    useProjectStore.getState().loadProject('', perfProject());
    liveScheduler.reset(0);
  });

  test('generate never touches CURRENT', () => {
    const before = JSON.parse(JSON.stringify(useProjectStore.getState().project));
    const candidate = candidateRuntime.generate();
    expect(candidate).not.toBeNull();
    expect(useProjectStore.getState().project).toEqual(before);
  });

  test('preview does not write to the document and restores on release', () => {
    candidateRuntime.generate();
    const before = JSON.parse(JSON.stringify(useProjectStore.getState().project));
    candidateRuntime.setPreview(true);
    expect(candidateRuntime.isPreviewing).toBe(true);
    expect(candidateRuntime.resolveOverlay()).not.toBeNull();
    expect(useProjectStore.getState().project).toEqual(before);
    candidateRuntime.setPreview(false);
    expect(candidateRuntime.resolveOverlay()).toBeNull();
    expect(useProjectStore.getState().project).toEqual(before);
  });

  test('freeze state is restored exactly after preview (§18)', () => {
    useProjectStore.getState().loadProject(
      '',
      perfProject({ modulations: [mod({ frozenValue: 0.42 })] }),
    );
    candidateRuntime.generate();
    const frozenBefore = useProjectStore.getState().project.modulations[0]!.frozenValue;
    candidateRuntime.setPreview(true);
    candidateRuntime.setPreview(false);
    expect(useProjectStore.getState().project.modulations[0]!.frozenValue).toBe(frozenBefore);
  });

  test('candidate triggers are visual-only: the scheduler keeps CURRENT topology (§17)', () => {
    const candidateTrigger = {
      id: 'cand-trig',
      enabled: true,
      source: 'beat',
      action: 'applyLook' as const,
      targetParam: null,
      targetMappingId: null,
      lookSlot: 1,
      quantize: 'off' as const,
      cooldownSec: 0,
      attackSec: 0,
      holdSec: 0,
      decaySec: 0.2,
      amount: 0.3,
      curve: 'easeOut' as const,
    };
    candidateRuntime.generate();
    // Force a candidate whose topology would fire a document action.
    const cand = candidateRuntime.current!;
    cand.core.triggers = [candidateTrigger];
    candidateRuntime.setPreview(true);
    // previewTriggers is the VISUAL surface…
    expect(candidateRuntime.previewTriggers()).toHaveLength(1);
    // …while the document's trigger list is untouched, so the scheduler
    // (fed from the project by the bridge) can never see it.
    expect(useProjectStore.getState().project.triggers).toEqual([]);
    candidateRuntime.setPreview(false);
  });

  test('discard clears everything and leaves CURRENT alone', () => {
    candidateRuntime.generate();
    const before = JSON.parse(JSON.stringify(useProjectStore.getState().project));
    candidateRuntime.discard();
    expect(candidateRuntime.current).toBeNull();
    expect(candidateRuntime.isPreviewing).toBe(false);
    expect(useProjectStore.getState().project).toEqual(before);
  });
});

describe('candidate lineage (§12, §13)', () => {
  beforeEach(() => {
    candidateRuntime.reset();
    useProjectStore.getState().loadProject('', perfProject());
  });

  test('regenerate keeps CURRENT as parent', () => {
    const a = candidateRuntime.generate()!;
    const b = candidateRuntime.generate()!;
    expect(b.parentCandidateId).toBeNull();
    expect(b.metadata.generation).toBe(1);
    expect(b.parentSeed).toBe(a.parentSeed);
    expect(b.seed).not.toBe(a.seed);
  });

  test('mutate again walks the lineage from the candidate', () => {
    const a = candidateRuntime.generate()!;
    const b = candidateRuntime.generate({ fromCandidate: true })!;
    const c = candidateRuntime.generate({ fromCandidate: true })!;
    expect(b.parentCandidateId).toBe(a.id);
    expect(b.metadata.generation).toBe(2);
    expect(b.parentSeed).toBe(a.seed);
    expect(c.parentCandidateId).toBe(b.id);
    expect(c.metadata.generation).toBe(3);
    expect(c.parentSeed).toBe(b.seed);
  });
});

describe('candidate apply (§7, §8, §9, §25)', () => {
  const ctx = { bpm: 120, beatOffsetSec: 0, beatsPerBar: 4, analysis: null, markers: [] };

  beforeEach(() => {
    candidateRuntime.reset();
    morphRuntime.abortSilently();
    useProjectStore.getState().loadProject('', perfProject({ performanceQuantize: 'off' }));
    liveScheduler.reset(0);
  });

  test('immediate apply commits the candidate core as CURRENT', () => {
    const candidate = candidateRuntime.generate()!;
    candidateRuntime.apply();
    const applied = captureLookCore(useProjectStore.getState().project)!;
    expect(applied.params).toEqual(candidate.core.params);
    expect(candidateRuntime.current).toBeNull();
  });

  test('apply is one undo entry and undo restores CURRENT', () => {
    const before = captureLookCore(useProjectStore.getState().project)!;
    const depth = useProjectStore.getState().past.length;
    candidateRuntime.generate();
    candidateRuntime.apply();
    expect(useProjectStore.getState().past.length).toBe(depth + 1);
    useProjectStore.getState().undo();
    expect(captureLookCore(useProjectStore.getState().project)!.params).toEqual(before.params);
  });

  test('apply preserves activeLookId so the tile reads MODIFIED (§9)', () => {
    useProjectStore.getState().loadProject(
      '',
      perfProject({ activeLookId: 'look-x', performanceQuantize: 'off' }),
    );
    candidateRuntime.generate();
    candidateRuntime.apply();
    expect(useProjectStore.getState().project.activeLookId).toBe('look-x');
  });

  test('quantized apply queues on the ONE scheduler and fires on the boundary', () => {
    useProjectStore.getState().loadProject('', perfProject({ performanceQuantize: 'bar' }));
    const candidate = candidateRuntime.generate()!;
    liveScheduler.reset(0.3);
    // Fire the same synthesized action the runtime uses, off-boundary.
    liveScheduler.fireLive(
      {
        id: `perf-candidate-${candidate.id}`,
        enabled: true,
        source: 'manual',
        action: 'applyCandidate',
        targetParam: null,
        targetMappingId: null,
        lookSlot: null,
        quantize: 'bar',
        cooldownSec: 0,
        attackSec: 0,
        holdSec: 0,
        decaySec: 0.2,
        amount: 0.3,
        curve: 'easeOut',
      },
      0.3,
      ctx,
    );
    const pending = liveScheduler.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.executeAt).toBeCloseTo(2);
    expect(pending[0]!.mapping.action).toBe('applyCandidate');
  });

  test('regenerating cancels a queued apply — no stale candidate lands (§25)', () => {
    useProjectStore.getState().loadProject('', perfProject({ performanceQuantize: 'bar' }));
    liveScheduler.reset(0.3);
    candidateRuntime.generate();
    candidateRuntime.apply();
    expect(useCandidateStore.getState().queuedId).not.toBeNull();
    candidateRuntime.generate(); // regenerate → queue must die
    expect(liveScheduler.getPending().filter((p) => p.mapping.action === 'applyCandidate')).toHaveLength(0);
    expect(useCandidateStore.getState().queuedId).toBeNull();
  });

  test('discarding cancels a queued apply', () => {
    useProjectStore.getState().loadProject('', perfProject({ performanceQuantize: 'bar' }));
    liveScheduler.reset(0.3);
    candidateRuntime.generate();
    candidateRuntime.apply();
    candidateRuntime.discard();
    expect(liveScheduler.getPending().filter((p) => p.mapping.action === 'applyCandidate')).toHaveLength(0);
  });

  test('commit with a stale id is a no-op', () => {
    const before = JSON.parse(JSON.stringify(useProjectStore.getState().project));
    candidateRuntime.generate();
    candidateRuntime.commit('cand-that-no-longer-exists');
    expect(useProjectStore.getState().project).toEqual(before);
    expect(candidateRuntime.current).not.toBeNull();
  });
});

describe('candidate pin (§10)', () => {
  beforeEach(() => {
    candidateRuntime.reset();
    useProjectStore.getState().loadProject('', perfProject());
  });

  test('pin creates a Look without changing output', () => {
    const candidate = candidateRuntime.generate()!;
    const currentBefore = captureLookCore(useProjectStore.getState().project)!;
    const look = candidateRuntime.pin()!;
    const project = useProjectStore.getState().project;
    expect(project.pinnedLooks).toHaveLength(1);
    expect(look.slot).toBe(1);
    expect(look.techniques[0]!.params).toEqual(candidate.core.params);
    // Output untouched.
    expect(captureLookCore(project)!.params).toEqual(currentBefore.params);
    // Candidate survives so the performer can still apply it.
    expect(candidateRuntime.current).not.toBeNull();
  });
});

describe('candidate exclusions (§19, §36)', () => {
  beforeEach(() => {
    candidateRuntime.reset();
    useProjectStore.getState().loadProject('', perfProject());
  });

  test('MUTATE is blocked while a morph runs', () => {
    const look = {
      id: 'look-m',
      createdAt: new Date(0).toISOString(),
      label: 'M',
      note: '',
      slot: 1,
      seed: 1,
      thumbnail: null,
      techniques: [{ id: 'tm', techniqueId: 'mosaic', enabled: true, params: { scale: 2 } }],
      material: createEmptyProject().material,
      modulations: [],
      triggers: [],
    };
    useProjectStore.getState().loadProject('', perfProject({ pinnedLooks: [look] }));
    morphRuntime.start(
      'look-m',
      { startQuantize: 'off', duration: { mode: 'seconds', seconds: 30 }, curve: 'linear' },
      0,
    );
    expect(candidateRuntime.blockedReason).toBe('MUTATE unavailable during Morph');
    expect(candidateRuntime.generate()).toBeNull();
    morphRuntime.abortSilently();
    expect(candidateRuntime.blockedReason).toBeNull();
  });

  test('export ignores an un-applied candidate (§36)', () => {
    candidateRuntime.generate();
    candidateRuntime.setPreview(true);
    const evaluate = createFrameEvaluator(0, 24);
    const documentScale = useProjectStore.getState().project.techniques[0]!.params.scale;
    expect(evaluate(0).params.scale).toBe(documentScale);
    expect(evaluate(10).params.scale).toBe(documentScale);
    candidateRuntime.setPreview(false);
  });
});

describe('queue hygiene (§25 adversarial)', () => {
  test('cancelQueued sweeps orphaned scheduler entries even when the runtime forgot them', () => {
    useProjectStore.getState().loadProject('', perfProject({ performanceQuantize: 'bar' }));
    candidateRuntime.reset();
    liveScheduler.reset(0.3);
    const ctx = { bpm: 120, beatOffsetSec: 0, beatsPerBar: 4, analysis: null, markers: [] };
    liveScheduler.fireLive(
      {
        id: 'perf-candidate-orphan', enabled: true, source: 'manual', action: 'applyCandidate',
        targetParam: null, targetMappingId: null, lookSlot: null, quantize: 'bar',
        cooldownSec: 0, attackSec: 0, holdSec: 0, decaySec: 0.2, amount: 0.3, curve: 'easeOut',
      },
      0.3,
      ctx,
    );
    expect(liveScheduler.getPending()).toHaveLength(1);
    expect(useCandidateStore.getState().queuedId).toBeNull(); // runtime never knew
    candidateRuntime.cancelQueued();
    expect(liveScheduler.getPending()).toHaveLength(0);
  });

  test('reset sweeps a queued apply so it can never fire later', () => {
    useProjectStore.getState().loadProject('', perfProject({ performanceQuantize: 'bar' }));
    liveScheduler.reset(0.3);
    candidateRuntime.generate();
    const ctx = { bpm: 120, beatOffsetSec: 0, beatsPerBar: 4, analysis: null, markers: [] };
    // jsdom pins the playhead at 0, which IS a bar boundary — fire the same
    // action the runtime fires, off-boundary, so it genuinely queues.
    liveScheduler.fireLive(
      {
        id: 'perf-candidate-reset', enabled: true, source: 'manual', action: 'applyCandidate',
        targetParam: null, targetMappingId: null, lookSlot: null, quantize: 'bar',
        cooldownSec: 0, attackSec: 0, holdSec: 0, decaySec: 0.2, amount: 0.3, curve: 'easeOut',
      },
      0.3,
      ctx,
    );
    expect(liveScheduler.getPending()).toHaveLength(1);
    candidateRuntime.reset();
    expect(liveScheduler.getPending()).toHaveLength(0);
    expect(candidateRuntime.current).toBeNull();
    // And advancing past the boundary changes nothing.
    const before = JSON.parse(JSON.stringify(useProjectStore.getState().project));
    liveScheduler.advanceTo(3, [], ctx);
    expect(useProjectStore.getState().project).toEqual(before);
  });
});

describe('mutation always changes something (Phase 17)', () => {
  test('generate retries past a no-op draw', () => {
    candidateRuntime.reset();
    useProjectStore.getState().loadProject('', perfProject());
    useCandidateStore.setState({ intensity: 'low', locks: emptyMutationLocks() });
    for (let i = 0; i < 30; i++) {
      const c = candidateRuntime.generate();
      expect(c).not.toBeNull();
      expect(c!.metadata.changedParams + c!.metadata.changedModulations).toBeGreaterThan(0);
    }
    candidateRuntime.reset();
  });
});

describe('document replacement clears runtimes (Phase 17)', () => {
  test('a new project drops the candidate and any armed morph', () => {
    useProjectStore.getState().loadProject('', perfProject());
    candidateRuntime.generate();
    candidateRuntime.setPreview(true);
    expect(candidateRuntime.current).not.toBeNull();
    useProjectStore.getState().newProject();
    expect(candidateRuntime.current).toBeNull();
    expect(candidateRuntime.isPreviewing).toBe(false);
    expect(morphRuntime.current).toBeNull();
  });

  test('opening another project drops a candidate from the previous one', () => {
    useProjectStore.getState().loadProject('', perfProject());
    const candidate = candidateRuntime.generate();
    expect(candidate).not.toBeNull();
    useProjectStore.getState().loadProject('/elsewhere.material', perfProject());
    expect(candidateRuntime.current).toBeNull();
  });
});

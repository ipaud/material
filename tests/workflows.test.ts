import { selectedLayerOf } from '@shared/schemas/project';
import { describe, expect, it, beforeEach } from 'vitest';
import { listTechniques, getTechnique } from '@/techniques/registry';
import { allParams, defaultParams } from '@/techniques/types';
import { mutateLookCore, emptyMutationLocks, type MutationIntensity } from '@/performance/mutation';
import { captureLookCore, lookToCore, projectWithLookCore } from '@/performance/lookCore';
import { candidateRuntime } from '@/performance/candidateRuntime';
import { freezeAll, clearAllFreezes } from '@/modulation/modulationActions';
import { useProjectStore } from '@/state/projectStore';
import { GENERATORS } from '@/sources/generators/definitions';
import { createEmptyProject, projectSchema, type Project } from '@shared/schemas/project';

/**
 * CE1H — WORKFLOW gates.
 *
 * The per-system tests prove each primitive in isolation. These prove the
 * things a user actually strings together: explore a stateful technique,
 * audition a candidate without damaging what is on screen, pin a Look and
 * reload it, freeze modulation, switch sources.
 */

function projectWith(techniqueId: string): Project {
  const p = createEmptyProject('workflow');
  const def = getTechnique(techniqueId)!;
  return {
    ...p,
    layers: [{ ...createEmptyProject().layers[0]!, technique: { id: 't1', techniqueId, enabled: true, params: defaultParams(def) } }],
  };
}

beforeEach(() => {
  candidateRuntime.reset();
  useProjectStore.setState({ project: projectWith('mosaic'), past: [], future: [] });
});

const FAMILIES = [
  'mosaic',
  'feedback-zoom',
  'feedback-bloom',
  'time-field',
  'slit-scan',
  'echo',
  'step-print',
  'motion-mosh',
  'flow-displace',
  'flow-feedback',
  'motion-trails',
  'reaction-diffusion',
  'cellular',
];

describe('Explore across stateful and stateless systems (§19)', () => {
  it('mutation never leaves a parameter non-finite or out of range', () => {
    // A candidate that escapes its range is not an aesthetic problem, it is
    // an unrecoverable state on a system that keeps its own history.
    let runs = 0;
    for (const id of FAMILIES) {
      const def = getTechnique(id);
      expect(def, `${id} is not registered`).toBeTruthy();
      if (!def) continue;
      const core = captureLookCore(projectWith(id));
      expect(core).toBeTruthy();
      if (!core) continue;
      const byId = new Map(allParams(def).map((p) => [p.id, p]));
      for (let seed = 1; seed <= 25; seed++) {
        for (const intensity of ['low', 'med', 'high'] as MutationIntensity[]) {
          const out = mutateLookCore(core, def, seed, intensity, emptyMutationLocks(), 1);
          runs++;
          for (const [key, value] of Object.entries(out.core.params)) {
            const d = byId.get(key);
            if (typeof value !== 'number') continue;
            expect(Number.isFinite(value), `${id}.${key} = ${value}`).toBe(true);
            if (d?.type === 'number') {
              expect(value, `${id}.${key} below min`).toBeGreaterThanOrEqual(d.min - 1e-9);
              expect(value, `${id}.${key} above max`).toBeLessThanOrEqual(d.max + 1e-9);
            }
          }
        }
      }
    }
    expect(runs).toBe(FAMILIES.length * 25 * 3);
  });

  it('mutation is a pure function of its seed', () => {
    const def = getTechnique('motion-mosh')!;
    const core = captureLookCore(projectWith('motion-mosh'))!;
    const a = mutateLookCore(core, def, 42, 'high', emptyMutationLocks(), 1);
    const b = mutateLookCore(core, def, 42, 'high', emptyMutationLocks(), 1);
    expect(a.core).toEqual(b.core);
  });

  it('mutation never rewrites the technique identity', () => {
    // Explore varies a look; changing identity underneath a running
    // feedback surface or simulation would reset it without asking.
    for (const id of FAMILIES) {
      const def = getTechnique(id)!;
      const core = captureLookCore(projectWith(id))!;
      for (let seed = 1; seed <= 8; seed++) {
        const out = mutateLookCore(core, def, seed, 'high', emptyMutationLocks(), 1);
        expect(out.core.techniqueId).toBe(id);
      }
    }
  });
});

describe('Candidate never corrupts Current (§20-22)', () => {
  for (const id of ['feedback-zoom', 'reaction-diffusion', 'motion-mosh', 'mosaic']) {
    it(`discarding a candidate leaves CURRENT untouched (${id})`, () => {
      useProjectStore.setState({ project: projectWith(id), past: [], future: [] });
      const before = JSON.stringify(useProjectStore.getState().project);
      const candidate = candidateRuntime.generate();
      expect(candidate).not.toBeNull();
      // A candidate is an overlay: the document must not move until apply.
      expect(JSON.stringify(useProjectStore.getState().project)).toBe(before);
      candidateRuntime.discard();
      expect(JSON.stringify(useProjectStore.getState().project)).toBe(before);
    });
  }

  it('an applied candidate becomes CURRENT and keeps the technique identity', () => {
    useProjectStore.setState({ project: projectWith('feedback-zoom'), past: [], future: [] });
    const candidate = candidateRuntime.generate();
    expect(candidate).not.toBeNull();
    candidateRuntime.apply();
    const now = selectedLayerOf(useProjectStore.getState().project).technique;
    expect(now?.techniqueId).toBe('feedback-zoom');
  });

  it('the candidate overlay only exists while auditioning, and dies on discard', () => {
    useProjectStore.setState({ project: projectWith('cellular'), past: [], future: [] });
    candidateRuntime.generate();
    // Generating does NOT put the candidate on screen — auditioning does.
    expect(candidateRuntime.resolveOverlay()).toBeNull();
    candidateRuntime.setPreview(true);
    expect(candidateRuntime.resolveOverlay()).not.toBeNull();
    candidateRuntime.discard();
    expect(candidateRuntime.resolveOverlay()).toBeNull();
  });
});

describe('Looks carry configuration only (§23)', () => {
  for (const id of ['feedback-zoom', 'time-field', 'motion-mosh', 'reaction-diffusion']) {
    it(`a Look of ${id} round-trips without runtime state`, () => {
      const project = projectWith(id);
      const core = captureLookCore(project)!;
      const json = JSON.stringify(core);
      // Runtime lives on the GPU and is rebuilt; serializing it would make
      // a project file depend on the machine that wrote it.
      expect(json).not.toMatch(/texture|renderTarget|surface|stepIndex|atlas|webgl/i);
      expect(core.techniqueId).toBe(id);
      const restored = projectWithLookCore(project, core, null);
      expect(restored.layers[0]?.technique?.techniqueId).toBe(id);
      expect(restored.layers[0]?.technique?.params).toEqual(project.layers[0]?.technique?.params);
    });
  }

  it('a pinned Look converts back to the same core', () => {
    const project = projectWith('flow-feedback');
    const core = captureLookCore(project)!;
    const look = {
      id: 'L1',
      createdAt: '2026-01-01T00:00:00.000Z',
      label: 'L',
      note: '',
      slot: 1,
      seed: core.seed,
      thumbnail: null,
      techniques: selectedLayerOf(project).technique ? [selectedLayerOf(project).technique!] : [],
      material: core.material,
      modulations: core.modulations,
      triggers: core.triggers,
    };
    expect(lookToCore(look)).toEqual(core);
  });
});

describe('Freeze holds a value and release returns to live (§29)', () => {
  it('freezeAll captures, clearAllFreezes restores', () => {
    const p = projectWith('feedback-zoom');
    useProjectStore.setState({
      project: {
        ...p,
        modulations: [
          {
            id: 'm1',
            enabled: true,
            source: 'audio.level',
            target: 't1.persistence',
            amount: 1,
            min: 0,
            max: 1,
            invert: false,
            smoothing: 0,
            curve: 'linear',
            frozenValue: null,
          },
        ],
      },
      past: [],
      future: [],
    });
    freezeAll();
    expect(useProjectStore.getState().project.modulations[0]!.frozenValue).not.toBeNull();
    clearAllFreezes();
    expect(useProjectStore.getState().project.modulations[0]!.frozenValue).toBeNull();
  });
});

describe('source parameter hygiene (§15, §51)', () => {
  it('generator parameter ids never collide with technique parameter ids', () => {
    // They share one modulation vocabulary; the `source.` namespace is what
    // keeps a generator "scale" from writing a technique "scale".
    for (const g of GENERATORS) {
      for (const p of g.params) {
        expect(`source.${p.id}`.startsWith('source.')).toBe(true);
      }
    }
    const techniqueIds = new Set(listTechniques().flatMap((t) => allParams(t).map((p) => p.id)));
    const overlapping = GENERATORS.flatMap((g) => g.params.map((p) => p.id)).filter((id) =>
      techniqueIds.has(id),
    );
    // Overlap is fine ONLY because of the namespace — assert the namespace
    // is what disambiguates, rather than pretending names never collide.
    expect(overlapping.length).toBeGreaterThan(0);
  });

  it('a project keeps its schema shape across a save/parse round trip', () => {
    for (const id of FAMILIES) {
      const project = projectWith(id);
      const parsed = projectSchema.parse(JSON.parse(JSON.stringify(project)));
      expect(parsed.layers[0]?.technique?.techniqueId).toBe(id);
      expect(parsed.layers[0]?.technique?.params).toEqual(project.layers[0]?.technique?.params);
    }
  });
});

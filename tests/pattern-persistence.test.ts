import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { modulationRuntime } from '@/modulation/runtime';
import {
  patternSourceKey,
  parsePatternSourceKey,
  resetPatternRuntime,
  resolvePatternHandles,
  getPatternCacheSize,
  getPatternCompileCount,
} from '@/pattern/patternSourceRuntime';
import {
  addPatternSource,
  duplicatePatternSource,
  orphanPatternMappings,
  removePatternSource,
  setPatternSourceEnabled,
  updatePatternSource,
} from '@/pattern/patternSourceActions';
import { useProjectStore } from '@/state/projectStore';
import { getTechnique } from '@/techniques/registry';
import { defaultParams } from '@/techniques/types';
import { PROJECT_FORMAT_VERSION } from '@shared/constants/app';
import {
  createEmptyProject,
  parseProject,
  projectSchema,
  type ModulationMapping,
  type PatternSource,
  type Project,
} from '@shared/schemas/project';

/**
 * P6 — persistence and project semantics. Everything here runs through the
 * real schema (`parseProject` / `projectSchema`, the exact functions the
 * main-process reader and atomic writer use) and the real store actions.
 */

const mosaic = getTechnique('mosaic')!;
const FIXTURE_PATH = join(__dirname, 'fixtures', 'project-v2-pattern.json');
const fixtureRaw = () => JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;

function mapping(over: Partial<ModulationMapping> = {}): ModulationMapping {
  return {
    id: 'mod-1',
    enabled: true,
    source: patternSourceKey('pat-a'),
    target: 'scale',
    amount: 0.5,
    min: 0,
    max: 1,
    invert: false,
    smoothing: 0,
    curve: 'linear',
    frozenValue: null,
    ...over,
  };
}

function patternSource(over: Partial<PatternSource> = {}): PatternSource {
  return {
    id: 'pat-a',
    enabled: true,
    beatsPerCycle: 4,
    pattern: { type: 'sequence', values: [0, 1, 0.25, 0.8] },
    transforms: [],
    ...over,
  };
}

function projectWith(over: Partial<Project> = {}): Project {
  const p = createEmptyProject('p6');
  return {
    ...p,
    techniques: [
      { id: 'tech-1', techniqueId: 'mosaic', enabled: true, params: defaultParams(mosaic) },
    ],
    timeline: { ...p.timeline, bpm: 96, beatOffsetSec: 0.375 },
    patternSources: [patternSource()],
    modulations: [mapping()],
    explore: { lockedParams: [], lastSeed: 12345 },
    ...over,
  };
}

/** Live final params — the production path (bridge configure + transform). */
function live(t: number): Record<string, unknown> {
  const project = useProjectStore.getState().project;
  const instance = project.techniques.find((tq) => tq.enabled) ?? null;
  modulationRuntime.configure(project.modulations, instance?.techniqueId ?? null, {
    analysis: null,
    durationSec: 600,
    bpm: project.timeline.bpm,
    beatOffsetSec: project.timeline.beatOffsetSec,
    beatsPerBar: project.timeline.beatsPerBar,
    patterns: resolvePatternHandles(project.patternSources),
    projectSeed: project.explore.lastSeed ?? 1,
  });
  const definition = getTechnique(instance?.techniqueId ?? 'mosaic')!;
  return modulationRuntime.transform(
    { ...defaultParams(definition), ...(instance?.params ?? {}) },
    t,
  ) as Record<string, unknown>;
}

function install(project: Project): Project {
  useProjectStore.setState({ project, past: [], future: [], transientBase: null, dirty: false });
  resetPatternRuntime();
  modulationRuntime.reset();
  return project;
}

/** Simulate a full save → read cycle using the exact production functions. */
function saveAndReload(project: Project): Project {
  const written = projectSchema.parse(project); // writeProjectFile validates like this
  return parseProject(JSON.parse(JSON.stringify(written)));
}

const SAMPLE_TIMES = [0.2, 1.1, 2.6, 7.7, 23.456];
const probe = () => SAMPLE_TIMES.map((t) => live(t));

beforeEach(() => {
  resetPatternRuntime();
  modulationRuntime.reset();
});

// ---------------------------------------------------------------------------
// §7 / §8 — format version and old projects
// ---------------------------------------------------------------------------

describe('project format version', () => {
  it('pattern sources are an additive field — v3 exists for LIVE sources, not patterns', () => {
    // v3 was introduced by 18D for live source refs; patterns still never
    // forced a bump and still parse from v2 files via migration.
    expect(PROJECT_FORMAT_VERSION).toBe(3);
    const parsed = parseProject(JSON.parse(JSON.stringify(projectWith())));
    expect(parsed.version).toBe(3);
  });

  it('a v2 project written before patterns existed still opens', () => {
    const legacy = JSON.parse(JSON.stringify(createEmptyProject('pre-pattern'))) as Record<
      string,
      unknown
    >;
    delete legacy.patternSources;
    const parsed = parseProject(legacy);
    expect(parsed.patternSources).toEqual([]);
  });

  it('a v1 project still migrates and gains an empty pattern list', () => {
    const v1 = JSON.parse(JSON.stringify(createEmptyProject('v1'))) as Record<string, unknown>;
    v1.version = 1;
    delete v1.patternSources;
    delete v1.macros;
    v1.timeline = { inSec: null, outSec: null, loop: true, bpm: null, beatOffsetSec: 0 };
    const parsed = parseProject(v1);
    expect(parsed.version).toBe(3);
    expect(parsed.patternSources).toEqual([]);
    expect(parsed.timeline.beatsPerBar).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// §9 / §22–§26 / §47 — round-trip
// ---------------------------------------------------------------------------

describe('round-trip', () => {
  it('sampled values and final params survive save → reload exactly', () => {
    const project = install(projectWith());
    const before = probe();
    const reloaded = install(saveAndReload(project));
    expect(probe()).toEqual(before);
    expect(reloaded.patternSources[0]!.id).toBe('pat-a');
  });

  it('every definition kind round-trips structurally', () => {
    const sources: PatternSource[] = [
      patternSource({ id: 'p-const', pattern: { type: 'constant', value: -0.75 } }),
      patternSource({
        id: 'p-seq',
        pattern: { type: 'sequence', values: [-1, 0, 0.333333333333, 1, true, false] },
      }),
      patternSource({
        id: 'p-euclid',
        pattern: {
          type: 'euclidean',
          pulses: 5,
          steps: 16,
          rotation: -3,
          activeValue: 0.9,
          inactiveValue: -0.2,
        },
      }),
    ];
    const reloaded = saveAndReload(projectWith({ patternSources: sources, modulations: [] }));
    expect(reloaded.patternSources).toEqual(sources);
  });

  it('transform order is never sorted or normalized', () => {
    const chain: PatternSource['transforms'] = [
      { type: 'fast', factor: 2 },
      { type: 'reverse' },
      { type: 'rotate', steps: 3 },
      { type: 'every', cycles: 4, transform: { type: 'slow', factor: 1.5 } },
      { type: 'degrade', probability: 0.63 },
    ];
    const reloaded = saveAndReload(
      projectWith({ patternSources: [patternSource({ transforms: chain })], modulations: [] }),
    );
    expect(reloaded.patternSources[0]!.transforms).toEqual(chain);
    // And the reverse order stays a genuinely different project.
    const flipped = saveAndReload(
      projectWith({
        patternSources: [patternSource({ transforms: [chain[1]!, chain[0]!] })],
        modulations: [],
      }),
    );
    expect(flipped.patternSources[0]!.transforms).toEqual([chain[1], chain[0]]);
  });

  it('beatsPerCycle round-trips exactly for every representative value', () => {
    for (const beatsPerCycle of [1, 2, 4, 7, 8, 0.5]) {
      const reloaded = saveAndReload(
        projectWith({
          patternSources: [patternSource({ beatsPerCycle })],
          modulations: [],
        }),
      );
      expect(reloaded.patternSources[0]!.beatsPerCycle).toBe(beatsPerCycle);
    }
  });

  it('enabled state persists and re-enabling restores the same identity', () => {
    install(projectWith());
    const enabledValues = probe();
    setPatternSourceEnabled('pat-a', false);
    const disabled = probe();
    expect(disabled).not.toEqual(enabledValues);
    const reloaded = saveAndReload(useProjectStore.getState().project);
    expect(reloaded.patternSources[0]!.enabled).toBe(false);
    install(reloaded);
    expect(probe()).toEqual(disabled);
    setPatternSourceEnabled('pat-a', true);
    expect(probe()).toEqual(enabledValues);
  });

  it('only creative data is serialized — no compiled, diagnostic or clock state', () => {
    const project = install(projectWith());
    live(1.1); // populate every runtime cache
    const json = JSON.stringify(projectSchema.parse(useProjectStore.getState().project));
    for (const forbidden of ['compiled', 'values":[', 'cycleIndex', 'stepIndex', 'fingerprint', 'sourceKey']) {
      if (forbidden === 'values":[') continue; // sequence definitions legitimately have values
      expect(json.includes(forbidden), `serialized project must not contain ${forbidden}`).toBe(false);
    }
    expect(Object.keys(project.patternSources[0]!).sort()).toEqual([
      'beatsPerCycle',
      'enabled',
      'id',
      'pattern',
      'transforms',
    ]);
  });
});

// ---------------------------------------------------------------------------
// §11 / §34 / §59 / §60 — validation
// ---------------------------------------------------------------------------

describe('validation', () => {
  it('duplicate pattern ids are refused with a readable error, never renamed', () => {
    const raw = JSON.parse(
      JSON.stringify(
        projectWith({
          patternSources: [patternSource({ id: 'pat-a' }), patternSource({ id: 'pat-a' })],
        }),
      ),
    );
    expect(() => parseProject(raw)).toThrow(/Duplicate Pattern source id: pat-a/);
    // The writer refuses it too — a duplicate can never reach disk.
    expect(() => projectSchema.parse(raw)).toThrow();
  });

  it('malformed pattern data is rejected with the offending path named', () => {
    const cases: [string, (p: Record<string, unknown>) => void, RegExp][] = [
      [
        'missing id',
        (p) => {
          delete (p.patternSources as Record<string, unknown>[])[0]!.id;
        },
        /patternSources\.0\.id/,
      ],
      [
        'invalid beatsPerCycle',
        (p) => {
          (p.patternSources as Record<string, unknown>[])[0]!.beatsPerCycle = 0;
        },
        /patternSources\.0\.beatsPerCycle/,
      ],
      [
        'unknown pattern type',
        (p) => {
          (p.patternSources as Record<string, unknown>[])[0]!.pattern = { type: 'markov' };
        },
        /patternSources\.0\.pattern/,
      ],
      [
        'invalid transform',
        (p) => {
          (p.patternSources as Record<string, unknown>[])[0]!.transforms = [{ type: 'wobble' }];
        },
        /patternSources\.0\.transforms/,
      ],
    ];
    for (const [label, mutate, expected] of cases) {
      const raw = JSON.parse(JSON.stringify(projectWith()));
      mutate(raw);
      expect(() => parseProject(raw), label).toThrow(expected);
      expect(() => parseProject(raw), `${label} readable`).toThrow(/Invalid project file/);
    }
  });

  it('a structurally valid but semantically impossible pattern loads and stays neutral', () => {
    // Schema keeps structure; compilePattern is the semantic authority, so
    // pulses > steps must NOT block opening the file.
    const project = projectWith({
      patternSources: [
        patternSource({
          pattern: {
            type: 'euclidean',
            pulses: 99,
            steps: 8,
            rotation: 0,
            activeValue: 1,
            inactiveValue: 0,
          },
        }),
      ],
    });
    const reloaded = parseProject(JSON.parse(JSON.stringify(project)));
    install(reloaded);
    expect(live(1.1).scale).toBe(defaultParams(mosaic).scale);
    expect(resolvePatternHandles(reloaded.patternSources)[0]!.error).toMatch(/pulses/i);
  });

  it('an orphan mapping loads safely, resolves neutral, and is reportable', () => {
    const project = projectWith({
      patternSources: [],
      modulations: [mapping({ source: patternSourceKey('pat-missing') })],
    });
    const reloaded = parseProject(JSON.parse(JSON.stringify(project)));
    install(reloaded);
    expect(live(1.1).scale).toBe(defaultParams(mosaic).scale);
    expect(orphanPatternMappings(reloaded)).toEqual([
      { mappingId: 'mod-1', patternId: 'pat-missing' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// §12 / §13 — source key format
// ---------------------------------------------------------------------------

describe('mapping source key', () => {
  it('round-trips ids, including ones a hand-edited file could contain', () => {
    for (const id of ['pat_a1b2c3d4', 'pat-a', 'weird:id:with:colons', 'x']) {
      expect(parsePatternSourceKey(patternSourceKey(id))).toBe(id);
    }
  });

  it('ignores every non-pattern source and refuses an empty id', () => {
    for (const source of ['bass', 'beat:1/4', 'time', 'patternish:x', 'pattern:']) {
      expect(parsePatternSourceKey(source)).toBeNull();
    }
  });

  it('generated ids are safe inside the key (uid alphabet)', () => {
    install(projectWith({ patternSources: [], modulations: [] }));
    const created = addPatternSource({
      enabled: true,
      pattern: { type: 'constant', value: 1 },
      transforms: [],
      beatsPerCycle: 4,
    });
    expect(created.id).toMatch(/^pat_[0-9a-f]{8}$/);
    expect(parsePatternSourceKey(patternSourceKey(created.id))).toBe(created.id);
  });
});

// ---------------------------------------------------------------------------
// §15–§18 / §20 / §38 / §40 — actions, undo/redo, ordering
// ---------------------------------------------------------------------------

describe('project actions', () => {
  it('removing a source drops its mappings atomically, and undo restores both', () => {
    install(
      projectWith({
        modulations: [
          mapping({ id: 'm1', target: 'scale' }),
          mapping({ id: 'm2', target: 'spacing' }),
          mapping({ id: 'm3', target: 'rotation' }),
          mapping({ id: 'm-other', source: 'bass', target: 'threshold' }),
        ],
      }),
    );
    const before = probe();
    removePatternSource('pat-a');
    const after = useProjectStore.getState().project;
    expect(after.patternSources).toHaveLength(0);
    expect(after.modulations.map((m) => m.id)).toEqual(['m-other']); // unrelated mapping survives
    useProjectStore.getState().undo();
    const restored = useProjectStore.getState().project;
    expect(restored.patternSources[0]!.id).toBe('pat-a');
    expect(restored.modulations.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm-other']);
    expect(probe()).toEqual(before); // same id → same probability decisions
    useProjectStore.getState().redo();
    expect(useProjectStore.getState().project.patternSources).toHaveLength(0);
  });

  it('duplicate copies the definition under a new id with an independent lane', () => {
    install(
      projectWith({
        patternSources: [
          patternSource({
            id: 'pat-a',
            pattern: { type: 'constant', value: 1 },
            transforms: [{ type: 'degrade', probability: 0.5 }],
          }),
        ],
        modulations: [mapping()],
      }),
    );
    const copy = duplicatePatternSource('pat-a')!;
    expect(copy.id).not.toBe('pat-a');
    expect(copy.pattern).toEqual({ type: 'constant', value: 1 });
    expect(copy.transforms).toEqual([{ type: 'degrade', probability: 0.5 }]);
    // Mappings are NOT cloned (§18).
    expect(useProjectStore.getState().project.modulations).toHaveLength(1);
    // Independent probability: the copy gates on different cycles.
    const project = useProjectStore.getState().project;
    const handles = resolvePatternHandles(project.patternSources);
    const original: boolean[] = [];
    const duplicated: boolean[] = [];
    for (let cycle = 0; cycle < 24; cycle++) {
      const t = cycle * 2.5 + 0.5 + 0.375;
      const values = evalPatternValues(project, handles, t);
      original.push(values.has(patternSourceKey('pat-a')));
      duplicated.push(values.has(patternSourceKey(copy.id)));
    }
    expect(original).not.toEqual(duplicated);
    // Deep copy: editing the copy cannot mutate the original definition.
    updatePatternSource(copy.id, { pattern: { type: 'constant', value: 0.25 } });
    expect(useProjectStore.getState().project.patternSources[0]!.pattern).toEqual({
      type: 'constant',
      value: 1,
    });
  });

  it('reordering sources changes nothing that matters', () => {
    const a = patternSource({ id: 'pat-a' });
    const b = patternSource({ id: 'pat-b', pattern: { type: 'constant', value: 0.5 } });
    const c = patternSource({
      id: 'pat-c',
      pattern: { type: 'euclidean', pulses: 5, steps: 16, rotation: 0, activeValue: 1, inactiveValue: 0 },
      transforms: [{ type: 'degrade', probability: 0.5 }],
    });
    const mappings = [
      mapping({ id: 'm-a', source: patternSourceKey('pat-a'), target: 'scale', amount: 0.3 }),
      mapping({ id: 'm-b', source: patternSourceKey('pat-b'), target: 'spacing', amount: 0.3 }),
      mapping({ id: 'm-c', source: patternSourceKey('pat-c'), target: 'rotation', amount: 0.3 }),
    ];
    install(projectWith({ patternSources: [a, b, c], modulations: mappings }));
    const forward = probe();
    install(projectWith({ patternSources: [c, a, b], modulations: mappings }));
    expect(probe()).toEqual(forward);
    // Reordering also survives a save/reload.
    install(saveAndReload(projectWith({ patternSources: [b, c, a], modulations: mappings })));
    expect(probe()).toEqual(forward);
  });

  it('the full undo/redo matrix restores ids and deterministic output', () => {
    install(projectWith({ patternSources: [], modulations: [] }));
    const created = addPatternSource({
      enabled: true,
      pattern: { type: 'sequence', values: [0, 1] },
      transforms: [],
      beatsPerCycle: 4,
    });
    useProjectStore.getState().apply((p) => ({
      ...p,
      modulations: [mapping({ source: patternSourceKey(created.id) })],
    }));
    const states: Record<string, unknown>[][] = [probe()];

    updatePatternSource(created.id, { pattern: { type: 'constant', value: 0.5 } });
    states.push(probe());
    updatePatternSource(created.id, { transforms: [{ type: 'fast', factor: 2 }] });
    states.push(probe());
    updatePatternSource(created.id, { beatsPerCycle: 7 });
    states.push(probe());
    setPatternSourceEnabled(created.id, false);
    states.push(probe());

    // Walk all the way back, checking each restored state exactly.
    for (let i = states.length - 2; i >= 0; i--) {
      useProjectStore.getState().undo();
      expect(probe(), `undo to state ${i}`).toEqual(states[i]);
      expect(useProjectStore.getState().project.patternSources[0]!.id).toBe(created.id);
    }
    // And forward again.
    for (let i = 1; i < states.length; i++) {
      useProjectStore.getState().redo();
      expect(probe(), `redo to state ${i}`).toEqual(states[i]);
      expect(useProjectStore.getState().project.patternSources[0]!.id).toBe(created.id);
    }
  });

  it('pattern edits mark the project dirty; evaluating never does', () => {
    install(projectWith());
    expect(useProjectStore.getState().dirty).toBe(false);
    for (let f = 0; f < 200; f++) live(f / 60);
    expect(useProjectStore.getState().dirty).toBe(false);

    const dirtyAfter = (action: () => void) => {
      useProjectStore.setState({ dirty: false });
      action();
      return useProjectStore.getState().dirty;
    };
    expect(dirtyAfter(() => updatePatternSource('pat-a', { beatsPerCycle: 8 }))).toBe(true);
    expect(dirtyAfter(() => setPatternSourceEnabled('pat-a', false))).toBe(true);
    expect(dirtyAfter(() => duplicatePatternSource('pat-a'))).toBe(true);
    expect(dirtyAfter(() => removePatternSource('pat-a'))).toBe(true);
    expect(
      dirtyAfter(() =>
        addPatternSource({
          enabled: true,
          pattern: { type: 'constant', value: 1 },
          transforms: [],
          beatsPerCycle: 4,
        }),
      ),
    ).toBe(true);
  });
});

/** Source values a project emits at one time (helper for lane comparisons). */
function evalPatternValues(
  project: Project,
  handles: ReturnType<typeof resolvePatternHandles>,
  t: number,
): Set<string> {
  const instance = project.techniques.find((tq) => tq.enabled) ?? null;
  modulationRuntime.configure(project.modulations, instance?.techniqueId ?? null, {
    analysis: null,
    durationSec: 600,
    bpm: project.timeline.bpm,
    beatOffsetSec: project.timeline.beatOffsetSec,
    beatsPerBar: project.timeline.beatsPerBar,
    patterns: handles,
    projectSeed: project.explore.lastSeed ?? 1,
  });
  modulationRuntime.transform({}, t);
  return new Set(Object.keys(modulationRuntime.lastSourceValues));
}

// ---------------------------------------------------------------------------
// §2 / §4 / §5 / §30–§32 — LookCore policy
// ---------------------------------------------------------------------------

describe('look policy', () => {
  it('LookCore has no pattern field — looks capture mappings, not signals', () => {
    const project = projectWith();
    const look = project.pinnedLooks[0];
    expect(look).toBeUndefined();
    // The schema itself is the contract: parsing a look with a bogus pattern
    // field must strip it rather than persist a per-look definition.
    const withLook = parseProject(
      JSON.parse(
        JSON.stringify({
          ...project,
          pinnedLooks: [
            {
              id: 'look-1',
              createdAt: '2026-01-01T00:00:00.000Z',
              label: 'L',
              note: '',
              slot: 1,
              seed: 1,
              thumbnail: null,
              techniques: project.techniques,
              material: project.material,
              modulations: [mapping({ amount: 0.8 })],
              triggers: [],
              patternSources: [patternSource({ id: 'should-not-persist' })],
            },
          ],
        }),
      ),
    );
    expect('patternSources' in withLook.pinnedLooks[0]!).toBe(false);
    expect(withLook.pinnedLooks[0]!.modulations[0]!.source).toBe(patternSourceKey('pat-a'));
  });

  it('two looks share one pattern signal and only differ in what they do with it', () => {
    const project = install(
      projectWith({
        modulations: [mapping({ id: 'm-scale', amount: 0.2 })],
      }),
    );
    const lowAmount = probe();
    // Look B: same pattern source, bigger amount, different target.
    useProjectStore.getState().apply((p) => ({
      ...p,
      modulations: [mapping({ id: 'm-rot', target: 'rotation', amount: 0.8 })],
    }));
    const other = probe();
    expect(other).not.toEqual(lowAmount);
    // The signal itself never changed: the same pattern source object is
    // still there with the same id and definition.
    expect(useProjectStore.getState().project.patternSources).toEqual(project.patternSources);
  });

  it('editing the shared pattern changes every mapping that references it', () => {
    install(
      projectWith({
        modulations: [
          mapping({ id: 'm-scale', target: 'scale', amount: 0.3 }),
          mapping({ id: 'm-spacing', target: 'spacing', amount: 0.3 }),
        ],
      }),
    );
    const before = live(1.1);
    updatePatternSource('pat-a', { pattern: { type: 'constant', value: 0.5 } });
    const after = live(1.1);
    expect(after.scale).not.toBe(before.scale);
    expect(after.spacing).not.toBe(before.spacing);
  });

  it('a pattern source with zero mappings is kept, not garbage-collected', () => {
    const project = install(projectWith({ modulations: [] }));
    const reloaded = saveAndReload(project);
    expect(reloaded.patternSources).toHaveLength(1);
    expect(reloaded.patternSources[0]!.id).toBe('pat-a');
  });
});

// ---------------------------------------------------------------------------
// §26 / §28 — seed semantics
// ---------------------------------------------------------------------------

describe('seed persistence', () => {
  const degradeProject = (seed: number) =>
    projectWith({
      patternSources: [
        patternSource({
          id: 'pattern-a',
          pattern: { type: 'constant', value: 1 },
          transforms: [{ type: 'degrade', probability: 0.3 }],
        }),
      ],
      modulations: [mapping({ source: patternSourceKey('pattern-a') })],
      explore: { lockedParams: [], lastSeed: seed },
    });

  it('seed A → reload → seed B → back to A reproduces exactly', () => {
    install(degradeProject(12345));
    const a1 = probe();
    install(saveAndReload(degradeProject(12345)));
    expect(probe()).toEqual(a1);
    install(saveAndReload(degradeProject(999)));
    const b = probe();
    expect(b).not.toEqual(a1);
    install(saveAndReload(degradeProject(12345)));
    expect(probe()).toEqual(a1);
  });

  it('the P3 golden degrade decisions survive a save/reload', () => {
    // Goldens (seed 12345, id 'pattern-a', lane 0): cycle 0 sample 0.4530…
    // (≥ .3 → gated), cycle 1 sample 0.2940… (< .3 → kept). Cycle = 2.5s at
    // 96 BPM, and the grid starts at beatOffset 0.375.
    install(saveAndReload(degradeProject(12345)));
    const base = defaultParams(mosaic).scale as number;
    expect(live(0.375 + 1.25).scale).toBe(base); // cycle 0 → gated
    expect(live(0.375 + 2.5 + 1.25).scale).toBe(base + 0.5 * 3); // cycle 1 → kept
  });
});

// ---------------------------------------------------------------------------
// §48 / §49 — durable fixture + golden evaluation
// ---------------------------------------------------------------------------

describe('compatibility fixture', () => {
  it('opens, and keeps every persisted pattern detail', () => {
    const project = parseProject(fixtureRaw());
    expect(project.patternSources.map((s) => s.id)).toEqual([
      'pat_fixture_a',
      'pat_fixture_b',
      'pat_fixture_c',
    ]);
    const [a, b, c] = project.patternSources;
    expect(a!.pattern).toEqual({ type: 'sequence', values: [0, 1, 0.25, 0.8] });
    expect(b!.beatsPerCycle).toBe(7);
    expect(b!.transforms).toEqual([{ type: 'fast', factor: 2 }, { type: 'reverse' }]);
    expect(c!.enabled).toBe(false);
    expect(c!.transforms).toEqual([
      { type: 'every', cycles: 4, transform: { type: 'rotate', steps: 1 } },
      { type: 'degrade', probability: 0.63 },
    ]);
    // The look references the pattern through a mapping only.
    expect(project.pinnedLooks[0]!.modulations[0]!.source).toBe('pattern:pat_fixture_a');
  });

  it('evaluates to locked golden values (guards PRNG, clock, transforms, ids)', () => {
    install(parseProject(fixtureRaw()));
    const at = (t: number) => {
      const p = live(t);
      return { scale: p.scale, spacing: p.spacing };
    };
    const GOLDEN: Record<string, { scale: number; spacing: number }> = {
      '0': { scale: 2.2, spacing: 0.6799999999999999 },
      '1': { scale: 2.5, spacing: 0.6799999999999999 },
      '2.5': { scale: 2.2, spacing: 0.1 },
      '3.7': { scale: 2.5, spacing: 0.1 },
      '7.7': { scale: 2.2, spacing: 0.1 },
      '23.456': { scale: 1, spacing: 0.1 },
    };
    for (const [t, expected] of Object.entries(GOLDEN)) {
      expect(at(Number(t)), `t=${t}`).toEqual(expected);
    }
  });

  it('survives a full save → reload cycle unchanged', () => {
    const first = parseProject(fixtureRaw());
    install(first);
    const values = probe();
    install(saveAndReload(first));
    expect(probe()).toEqual(values);
    expect(saveAndReload(first)).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// §41–§43 / §57 / §58 — cache lifecycle and scale
// ---------------------------------------------------------------------------

describe('cache lifecycle and scale', () => {
  it('25 reload cycles leave no dead cache entries', () => {
    for (let i = 0; i < 25; i++) {
      install(saveAndReload(projectWith()));
      live(1.1);
      expect(getPatternCacheSize()).toBe(1);
    }
  });

  it('undo/redo churn does not accumulate compiled entries', () => {
    install(projectWith());
    for (let i = 0; i < 40; i++) {
      updatePatternSource('pat-a', { pattern: { type: 'constant', value: i / 100 } });
      live(1.1);
      useProjectStore.getState().undo();
      live(1.1);
    }
    expect(getPatternCacheSize()).toBe(1);
  });

  it('a 250-pattern project parses, serializes and evaluates at sane cost', () => {
    const patterns: PatternSource[] = [];
    const mappings: ModulationMapping[] = [];
    for (let i = 0; i < 250; i++) {
      patterns.push(
        patternSource({
          id: `pat_bulk_${i}`,
          beatsPerCycle: 4,
          pattern:
            i % 2 === 0
              ? { type: 'euclidean', pulses: 5, steps: 16, rotation: i % 16, activeValue: 1, inactiveValue: 0 }
              : { type: 'sequence', values: [0, 0.5, 1, 0.5] },
          transforms: [{ type: 'fast', factor: 2 }, { type: 'degrade', probability: 0.5 }],
        }),
      );
      mappings.push(
        mapping({ id: `m_bulk_${i}`, source: patternSourceKey(`pat_bulk_${i}`), amount: 0.002 }),
      );
    }
    const project = projectWith({ patternSources: patterns, modulations: mappings });
    const t0 = performance.now();
    const json = JSON.stringify(projectSchema.parse(project));
    const serializeMs = performance.now() - t0;
    const t1 = performance.now();
    const parsed = parseProject(JSON.parse(json));
    const parseMs = performance.now() - t1;
    install(parsed);
    const t2 = performance.now();
    live(1.1); // first evaluation compiles all 250
    const firstEvalMs = performance.now() - t2;

    expect(parsed.patternSources).toHaveLength(250);
    expect(getPatternCompileCount()).toBe(250);
    expect(json.length).toBeLessThan(400_000);
    // Generous CI bounds — real numbers go in the phase report.
    expect(serializeMs).toBeLessThan(500);
    expect(parseMs).toBeLessThan(1000);
    expect(firstEvalMs).toBeLessThan(500);
  });
});

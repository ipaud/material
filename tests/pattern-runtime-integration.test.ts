import { beforeEach, describe, expect, it } from 'vitest';
import { modulationRuntime } from '@/modulation/runtime';
import { evalSources, type SourceContext } from '@/modulation/sources';
import { freezeAll, clearAllFreezes } from '@/modulation/modulationActions';
import { createFrameEvaluator } from '@/export/exportRunner';
import {
  getPatternCacheSize,
  getPatternCompileCount,
  getPatternDiagnostics,
  getPatternFingerprintCount,
  patternSourceKey,
  resetPatternRuntime,
  resolvePatternHandles,
} from '@/pattern/patternSourceRuntime';
import {
  addPatternSource,
  removePatternSource,
  updatePatternSource,
} from '@/pattern/patternSourceActions';
import { candidateRuntime } from '@/performance/candidateRuntime';
import { morphRuntime } from '@/performance/morphRuntime';
import { useProjectStore } from '@/state/projectStore';
import { getTechnique } from '@/techniques/registry';
import { defaultParams } from '@/techniques/types';
import {
  createEmptyProject,
  type Macro,
  type ModulationMapping,
  type PatternSource,
  type Project,
} from '@shared/schemas/project';

/**
 * P5 — adversarial runtime integration: Candidate / Freeze / Macro / MIDI,
 * removal, project switch, undo-redo, cache architecture, isolation.
 * Same production seams as pattern-parity.test.ts.
 */

const mosaic = getTechnique('mosaic')!;
const slitScan = getTechnique('slit-scan')!;
const SEED = 12345;
const BPM = 120;

function map(
  id: string,
  source: string,
  target: string,
  amount: number,
  over: Partial<ModulationMapping> = {},
): ModulationMapping {
  return {
    id,
    enabled: true,
    source,
    target,
    amount,
    min: 0,
    max: 1,
    invert: false,
    smoothing: 0,
    curve: 'linear',
    frozenValue: null,
    ...over,
  };
}

function pattern(over: Partial<PatternSource> = {}): PatternSource {
  return {
    id: 'pat-a',
    enabled: true,
    beatsPerCycle: 4,
    pattern: { type: 'sequence', values: [0, 1, 0.25, 0.8] },
    transforms: [],
    ...over,
  };
}

function baseProject(over: Partial<Project> = {}): Project {
  const p = createEmptyProject('p5-runtime');
  return {
    ...p,
    techniques: [
      { id: 'tech-1', techniqueId: 'mosaic', enabled: true, params: defaultParams(mosaic) },
    ],
    timeline: { ...p.timeline, bpm: BPM },
    patternSources: [pattern()],
    modulations: [map('m-a', patternSourceKey('pat-a'), 'scale', 0.5)],
    explore: { lockedParams: [], lastSeed: SEED },
    ...over,
  };
}

function configureLive(project: Project): void {
  const instance = project.techniques.find((t) => t.enabled) ?? null;
  modulationRuntime.configure(project.modulations, instance?.techniqueId ?? null, {
    analysis: null,
    durationSec: 600,
    bpm: project.timeline.bpm,
    beatOffsetSec: project.timeline.beatOffsetSec,
    beatsPerBar: project.timeline.beatsPerBar,
    patterns: resolvePatternHandles(project.patternSources),
    projectSeed: project.explore.lastSeed ?? 1,
  });
  modulationRuntime.configureMacros(project.macros);
}

/** Live frame as production draws it (tick → reconfigure → transform). */
function live(t: number): Record<string, unknown> {
  morphRuntime.tick(t);
  const project = useProjectStore.getState().project;
  configureLive(project);
  const overlayTechnique =
    candidateRuntime.resolveOverlay()?.techniqueId ??
    morphRuntime.resolveOverlay(t)?.techniqueId ??
    project.techniques.find((tq) => tq.enabled)?.techniqueId ??
    'mosaic';
  const definition = getTechnique(overlayTechnique)!;
  const instance = project.techniques.find((tq) => tq.enabled);
  return modulationRuntime.transform(
    { ...defaultParams(definition), ...(instance?.params ?? {}) },
    t,
  ) as Record<string, unknown>;
}

function install(project: Project): Project {
  useProjectStore.setState({ project, past: [], future: [], transientBase: null });
  resetPatternRuntime();
  modulationRuntime.reset();
  configureLive(project);
  return project;
}

beforeEach(() => {
  morphRuntime.abortSilently();
  candidateRuntime.reset();
  resetPatternRuntime();
  modulationRuntime.reset();
});

// ---------------------------------------------------------------------------
// §19 / §20 — Candidate
// ---------------------------------------------------------------------------

describe('candidate audition', () => {
  it('pattern sources keep driving params during audition and after release', () => {
    install(baseProject());
    const beforeAudition = live(1.1).scale;
    const candidate = candidateRuntime.generate();
    expect(candidate).not.toBeNull();
    candidateRuntime.setPreview(true);
    // The overlay replaces params/mappings; pattern sources live in project
    // state (outside LookCore) and keep being evaluated by the same authority.
    const during = [0.1, 1.1, 2.6].map((t) => live(t).scale);
    expect(during.every((v) => typeof v === 'number' && Number.isFinite(v))).toBe(true);
    candidateRuntime.setPreview(false);
    expect(live(1.1).scale).toBe(beforeAudition);
  });

  it('audition never leaks into the export evaluator', () => {
    install(baseProject());
    candidateRuntime.generate();
    candidateRuntime.setPreview(true);
    const evaluate = createFrameEvaluator(0, 60);
    candidateRuntime.setPreview(false);
    const documentValue = live(1) as Record<string, number>;
    expect(evaluate(60).params.scale).toBe(documentValue.scale);
  });

  it('a candidate technique change filters a pattern mapping targeting the old technique', () => {
    const project = install(baseProject());
    expect(live(1.1).scale).not.toBe(defaultParams(mosaic).scale);
    // Force the audition onto slit-scan: a mosaic-only pattern target must
    // vanish while auditioning, and come back on release.
    candidateRuntime.generate();
    const candidate = candidateRuntime.current;
    expect(candidate).not.toBeNull();
    (candidateRuntime as unknown as { candidate: { core: Record<string, unknown> } }).candidate.core =
      {
        ...(candidate as { core: Record<string, unknown> }).core,
        techniqueId: 'slit-scan',
        params: defaultParams(slitScan),
        modulations: [map('m-strips', patternSourceKey('pat-a'), 'strips', 0.5)],
      };
    candidateRuntime.setPreview(true);
    const auditioned = live(1.1);
    expect('scale' in auditioned).toBe(false);
    expect(auditioned.strips).not.toBe(defaultParams(slitScan).strips);
    candidateRuntime.setPreview(false);
    const released = live(1.1);
    expect('strips' in released).toBe(false);
    expect(released.scale).not.toBe(defaultParams(mosaic).scale);
    expect(project.techniques[0]!.techniqueId).toBe('mosaic');
  });
});

// ---------------------------------------------------------------------------
// §21 / §22 — Freeze
// ---------------------------------------------------------------------------

describe('freeze', () => {
  it('freeze holds the resolved value while the pattern keeps advancing', () => {
    install(baseProject());
    const moving = [0.1, 0.6, 1.1, 1.6].map((t) => live(t).scale);
    expect(new Set(moving).size).toBeGreaterThan(1);
    live(1.1); // establish the shaped value that FREEZE captures
    freezeAll();
    const frozen = [0.1, 0.6, 1.1, 1.6, 9.9].map((t) => live(t).scale);
    expect(new Set(frozen).size).toBe(1);
    // Release: the pattern resumes at ABSOLUTE time, not where it froze.
    clearAllFreezes();
    expect([0.1, 0.6, 1.1, 1.6].map((t) => live(t).scale)).toEqual(moving);
  });

  it('freeze is serialized project state, so export replays it identically', () => {
    install(baseProject());
    live(1.1);
    freezeAll();
    const frozenValue = useProjectStore.getState().project.modulations[0]!.frozenValue;
    expect(frozenValue).not.toBeNull();
    const evaluate = createFrameEvaluator(0, 60);
    const values = [0, 30, 90, 300].map((f) => evaluate(f).params.scale);
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toBe(live(5).scale);
  });
});

// ---------------------------------------------------------------------------
// §23 / §24 — Macro and MIDI
// ---------------------------------------------------------------------------

describe('macro and MIDI coexistence', () => {
  it('macros shape the base before pattern modulation, identically in both paths', () => {
    const macro: Macro = {
      id: 'macro-1',
      name: 'push',
      value: 0.5,
      mappings: [
        { targetParam: 'scale', amount: 0.4, min: 0, max: 1, invert: false, curve: 'linear', enabled: true },
      ],
    };
    install(baseProject({ macros: [macro] }));
    const evaluate = createFrameEvaluator(0, 60);
    for (const frame of [6, 36, 66, 96]) {
      const exported = evaluate(frame);
      expect(live(exported.timeSec).scale).toBe(exported.params.scale);
    }
    // And the macro genuinely moved the result.
    install(baseProject());
    const withoutMacro = live(0.6).scale;
    install(baseProject({ macros: [macro] }));
    expect(live(0.6).scale).not.toBe(withoutMacro);
  });

  it('a MIDI-written base param is modulated on top with no pattern priority', () => {
    install(baseProject());
    const fromDefault = live(0.6).scale as number;
    // MIDI pickup writes technique params (base layer).
    useProjectStore.getState().apply((p) => ({
      ...p,
      techniques: p.techniques.map((t) => ({ ...t, params: { ...t.params, scale: 0.4 } })),
    }));
    const fromMidi = live(0.6).scale as number;
    expect(fromMidi).toBeCloseTo(fromDefault - 0.6, 10); // base moved 1 → 0.4
    // Export replays the persisted base the same way.
    const evaluate = createFrameEvaluator(0, 60);
    expect(evaluate(36).params.scale).toBe(live(0.6).scale);
  });
});

// ---------------------------------------------------------------------------
// §40 / §41 / §42 / §43 — invalid, disabled, removed, project switch
// ---------------------------------------------------------------------------

describe('neutral and lifecycle states', () => {
  const invalid = pattern({
    id: 'pat-a',
    pattern: { type: 'euclidean', pulses: 9, steps: 8, rotation: 0, activeValue: 1, inactiveValue: 0 },
  });

  it('an invalid definition is neutral in both paths with no NaN', () => {
    install(baseProject({ patternSources: [invalid] }));
    const evaluate = createFrameEvaluator(0, 60);
    const expected = defaultParams(mosaic).scale;
    for (const frame of [0, 36, 300]) {
      const exported = evaluate(frame);
      expect(exported.params.scale).toBe(expected);
      expect(live(exported.timeSec).scale).toBe(expected);
    }
    expect(resolvePatternHandles([invalid])[0]!.error).toBeTruthy();
  });

  it('a disabled source is exactly equivalent to an absent one', () => {
    install(baseProject({ patternSources: [pattern({ enabled: false })] }));
    const disabled = [0.1, 0.6, 1.1].map((t) => live(t).scale);
    install(baseProject({ patternSources: [] }));
    expect([0.1, 0.6, 1.1].map((t) => live(t).scale)).toEqual(disabled);
    // No leaked contribution from a previously enabled compile.
    install(baseProject());
    live(0.6);
    useProjectStore.getState().apply((p) => ({
      ...p,
      patternSources: p.patternSources.map((s) => ({ ...s, enabled: false })),
    }));
    expect(live(0.6).scale).toBe(disabled[1]);
    expect(getPatternCacheSize()).toBe(0);
  });

  it('removing a source mid-session drops its contribution and its cache entry', () => {
    install(baseProject());
    const active = live(0.6).scale;
    expect(active).not.toBe(defaultParams(mosaic).scale);
    removePatternSource('pat-a');
    expect(live(0.6).scale).toBe(defaultParams(mosaic).scale);
    expect(getPatternCacheSize()).toBe(0);
    expect(getPatternDiagnostics()).toHaveLength(0);
    // Other modulation keeps working after the removal.
    useProjectStore.getState().apply((p) => ({ ...p, modulations: [map('m-t', 'time', 'scale', 0.5)] }));
    expect(live(60).scale).not.toBe(defaultParams(mosaic).scale);
  });

  it('a project switch leaves no stale pattern from the previous document', () => {
    for (let round = 0; round < 3; round++) {
      install(baseProject());
      const a = live(0.6).scale;
      expect(a).not.toBe(defaultParams(mosaic).scale);
      // Project B: different pattern id, no mapping to A's id.
      install(
        baseProject({
          patternSources: [pattern({ id: 'pat-b', pattern: { type: 'constant', value: 1 } })],
          modulations: [map('m-b', patternSourceKey('pat-b'), 'scale', 0.25)],
        }),
      );
      const ids = getPatternDiagnostics().map((d) => d.id);
      live(0.6);
      expect(getPatternDiagnostics().map((d) => d.id)).toEqual(['pat-b']);
      expect(ids.includes('pat-a')).toBe(false);
      expect(getPatternCacheSize()).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// §44 — undo / redo
// ---------------------------------------------------------------------------

describe('undo / redo', () => {
  it('add → edit → disable → remove all round-trip with stable ids and values', () => {
    install(baseProject({ patternSources: [], modulations: [] }));
    const created = addPatternSource({
      enabled: true,
      pattern: { type: 'sequence', values: [0, 1] },
      transforms: [],
      beatsPerCycle: 4,
    });
    useProjectStore.getState().apply((p) => ({
      ...p,
      modulations: [map('m-x', patternSourceKey(created.id), 'scale', 0.5)],
    }));
    const activeValue = live(1.1).scale;

    updatePatternSource(created.id, { pattern: { type: 'constant', value: 0.5 } });
    const editedValue = live(1.1).scale;
    expect(editedValue).not.toBe(activeValue);

    updatePatternSource(created.id, { enabled: false });
    expect(live(1.1).scale).toBe(defaultParams(mosaic).scale);

    const store = useProjectStore.getState();
    store.undo(); // re-enable
    expect(live(1.1).scale).toBe(editedValue);
    store.undo(); // back to the original definition
    expect(live(1.1).scale).toBe(activeValue);
    store.redo();
    expect(live(1.1).scale).toBe(editedValue);
    // Ids never regenerate through history.
    expect(useProjectStore.getState().project.patternSources[0]!.id).toBe(created.id);

    removePatternSource(created.id);
    expect(live(1.1).scale).toBe(defaultParams(mosaic).scale);
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.patternSources[0]!.id).toBe(created.id);
    expect(live(1.1).scale).toBe(editedValue);
  });
});

// ---------------------------------------------------------------------------
// §45 / §51 / §52 — cache architecture audit
// ---------------------------------------------------------------------------

describe('cache architecture', () => {
  it('evalSources never compiles or serializes — resolving is configure-time only', () => {
    const project = install(baseProject());
    const handles = resolvePatternHandles(project.patternSources);
    const compiles = getPatternCompileCount();
    const prints = getPatternFingerprintCount();
    const ctx: SourceContext = {
      analysis: null,
      durationSec: 600,
      bpm: BPM,
      beatOffsetSec: 0,
      beatsPerBar: 4,
      patterns: handles,
      projectSeed: SEED,
    };
    for (let f = 0; f < 5000; f++) evalSources(f / 120, ctx);
    expect(getPatternCompileCount()).toBe(compiles);
    expect(getPatternFingerprintCount()).toBe(prints);
  });

  it('re-resolving unchanged project objects costs zero serializations (§52 fix)', () => {
    const project = install(baseProject());
    resolvePatternHandles(project.patternSources);
    const prints = getPatternFingerprintCount();
    // The bridge reconfigures on every store notification; unchanged source
    // objects must not be re-serialized (WeakMap fingerprint by identity).
    for (let i = 0; i < 1000; i++) resolvePatternHandles(project.patternSources);
    expect(getPatternFingerprintCount()).toBe(prints);
    expect(getPatternCompileCount()).toBe(1);
    // A real edit produces exactly one new fingerprint + one compile.
    const edited = [{ ...project.patternSources[0]!, pattern: { type: 'constant' as const, value: 0.5 } }];
    resolvePatternHandles(edited);
    expect(getPatternFingerprintCount()).toBe(prints + 1);
    expect(getPatternCompileCount()).toBe(2);
  });

  it('project edits that do not touch patterns never recompile (object identity)', () => {
    const project = install(baseProject());
    const compiles = getPatternCompileCount();
    const prints = getPatternFingerprintCount();
    for (let i = 0; i < 50; i++) {
      useProjectStore.getState().apply((p) => ({
        ...p,
        techniques: p.techniques.map((t) => ({ ...t, params: { ...t.params, scale: 1 + i / 100 } })),
      }));
      live(0.6);
    }
    expect(getPatternCompileCount()).toBe(compiles);
    expect(getPatternFingerprintCount()).toBe(prints);
    expect(project.patternSources[0]!.id).toBe('pat-a');
  });

  it('1000 export frames compile nothing new — the immutable compiled form is shared', () => {
    install(baseProject());
    expect(getPatternCompileCount()).toBe(1); // the live configure compiled it
    const evaluate = createFrameEvaluator(0, 60);
    for (let f = 0; f < 1000; f++) evaluate(f);
    // CompiledPattern is immutable and evaluation is pure, so the export
    // evaluator safely reuses the same compiled object it found in cache.
    expect(getPatternCompileCount()).toBe(1);
  });

  it('repeated exports do not accumulate cache entries', () => {
    install(baseProject());
    for (let run = 0; run < 25; run++) {
      const evaluate = createFrameEvaluator(run, 30);
      for (let f = 0; f < 20; f++) evaluate(f);
    }
    expect(getPatternCacheSize()).toBe(1);
    expect(getPatternDiagnostics()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §46 / §47 — live / export isolation
// ---------------------------------------------------------------------------

describe('live and export isolation', () => {
  it('hostile live activity during an export does not change the exported stream', () => {
    install(baseProject());
    const reference: number[] = [];
    const evaluateRef = createFrameEvaluator(0, 30);
    for (let f = 0; f < 120; f++) reference.push(evaluateRef(f).params.scale as number);

    install(baseProject());
    const evaluate = createFrameEvaluator(0, 30);
    const observed: number[] = [];
    for (let f = 0; f < 120; f++) {
      // Live editor keeps working mid-export: seeks, auditions, macro moves.
      live(Math.random() * 50);
      if (f === 20) {
        candidateRuntime.generate();
        candidateRuntime.setPreview(true);
      }
      if (f === 60) candidateRuntime.setPreview(false);
      if (f === 80) modulationRuntime.configureMacros([]);
      observed.push(evaluate(f).params.scale as number);
    }
    expect(observed).toEqual(reference);
    candidateRuntime.reset();
  });

  it('the export working copy is unaffected by live pattern edits after it was built', () => {
    install(baseProject());
    const evaluate = createFrameEvaluator(0, 30);
    const before = evaluate(15).params.scale;
    // Editing the live project after evaluator construction: the export
    // evaluator keeps the handles it resolved (committed working copy).
    updatePatternSource('pat-a', { pattern: { type: 'constant', value: 0.5 } });
    expect(evaluate(15).params.scale).toBe(before);
    // While the live path immediately reflects the edit.
    expect(live(0.5).scale).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// §53 — diagnostics never affect determinism
// ---------------------------------------------------------------------------

describe('diagnostics', () => {
  it('reading diagnostics does not perturb evaluation', () => {
    install(baseProject({ patternSources: [pattern({ transforms: [{ type: 'degrade', probability: 0.5 }] })] }));
    const clean = [0.1, 0.6, 1.1, 1.6, 2.1].map((t) => live(t).scale);
    install(baseProject({ patternSources: [pattern({ transforms: [{ type: 'degrade', probability: 0.5 }] })] }));
    const withReads = [0.1, 0.6, 1.1, 1.6, 2.1].map((t) => {
      getPatternDiagnostics();
      const v = live(t).scale;
      getPatternDiagnostics();
      return v;
    });
    expect(withReads).toEqual(clean);
  });

  it('a source that turns invalid reports it — no stale healthy diagnostic (P5 regression)', () => {
    install(baseProject());
    live(0.6);
    expect(getPatternDiagnostics()[0]).toMatchObject({ compiled: true, error: null, active: true });
    updatePatternSource('pat-a', {
      pattern: { type: 'euclidean', pulses: 99, steps: 8, rotation: 0, activeValue: 1, inactiveValue: 0 },
    });
    live(0.6);
    expect(getPatternDiagnostics()[0]).toMatchObject({ compiled: false, active: false, value: null });
    expect(getPatternDiagnostics()[0]!.error).toBeTruthy();
  });

  it('losing the grid (BPM removed) also refreshes the diagnostic', () => {
    install(baseProject());
    live(0.6);
    expect(getPatternDiagnostics()[0]!.active).toBe(true);
    useProjectStore.getState().apply((p) => ({ ...p, timeline: { ...p.timeline, bpm: null } }));
    live(0.6);
    expect(getPatternDiagnostics()[0]).toMatchObject({ compiled: true, active: false, value: null });
  });

  it('diagnostics carry the preserved event seam without reaching FrameState', () => {
    install(
      baseProject({
        patternSources: [
          pattern({
            pattern: { type: 'euclidean', pulses: 5, steps: 16, rotation: 0, activeValue: 1, inactiveValue: 0 },
          }),
        ],
      }),
    );
    live(0.1);
    const [d] = getPatternDiagnostics();
    expect(d).toMatchObject({ id: 'pat-a', sourceKey: 'pattern:pat-a', compiled: true, error: null });
    expect(typeof d!.event).toBe('boolean');
    // FrameState carries only final params — no pattern identity of any kind.
    const params = live(0.1);
    for (const key of Object.keys(params)) {
      expect(key.startsWith('pattern:')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// §49 / §50 — performance under hostile composition
// ---------------------------------------------------------------------------

describe('performance', () => {
  it('250 patterns through the real resolver stay well inside a frame budget', () => {
    const patterns: PatternSource[] = [];
    const mappings: ModulationMapping[] = [];
    for (let i = 0; i < 250; i++) {
      patterns.push(
        pattern({
          id: `p${i}`,
          pattern:
            i % 2 === 0
              ? { type: 'euclidean', pulses: 5, steps: 16, rotation: 0, activeValue: 1, inactiveValue: 0 }
              : { type: 'sequence', values: [0, 0.5, 1, 0.5] },
          transforms: [{ type: 'fast', factor: 2 }, { type: 'degrade', probability: 0.5 }],
        }),
      );
      mappings.push(map(`m${i}`, patternSourceKey(`p${i}`), 'scale', 0.002));
    }
    install(baseProject({ patternSources: patterns, modulations: mappings }));
    const base = defaultParams(mosaic);
    const start = performance.now();
    const FRAMES = 600;
    for (let f = 0; f < FRAMES; f++) modulationRuntime.transform(base, f / 120);
    const perFrame = (performance.now() - start) / FRAMES;
    expect(perFrame).toBeLessThan(5); // broad CI bound; real numbers in the report
    expect(getPatternCompileCount()).toBe(250);
  });
});

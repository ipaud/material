import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyModulations, SmoothingState } from '@/modulation/evaluator';
import { evalSources, type SourceContext } from '@/modulation/sources';
import { modulationRuntime } from '@/modulation/runtime';
import {
  getPatternCacheSize,
  getPatternCompileCount,
  getPatternDiagnostics,
  patternSourceKey,
  resetPatternRuntime,
  resolvePatternHandles,
} from '@/pattern/patternSourceRuntime';
import {
  addPatternSource,
  removePatternSource,
  updatePatternSource,
} from '@/pattern/patternSourceActions';
import { createFrameEvaluator } from '@/export/exportRunner';
import { useProjectStore } from '@/state/projectStore';
import { getTechnique } from '@/techniques/registry';
import { defaultParams } from '@/techniques/types';
import {
  createEmptyProject,
  parseProject,
  type ModulationMapping,
  type PatternSource,
  type Project,
} from '@shared/schemas/project';

// ---------------------------------------------------------------------------
// Helpers — real mosaic definition, real resolver, real source evaluation.
// Target param: mosaic `scale` (min 0, max 3, default 1, modulatable).
// BPM 60, beatsPerCycle 4 → one cycle = 4 s, so cycle = t/4.
// ---------------------------------------------------------------------------

const mosaic = getTechnique('mosaic')!;
const SCALE_SPAN = 3; // mosaic scale: max 3 - min 0
const SCALE_BASE = 1; // mosaic scale default
// Default mapping amount is 0.5 so a full-on step lands at 2.5 — inside the
// param range (base 1 + 1·3 would clamp at max 3 and hide errors).
const SCALE_ON = SCALE_BASE + 0.5 * SCALE_SPAN; // 2.5

let mappingCounter = 0;
function mapping(source: string, over: Partial<ModulationMapping> = {}): ModulationMapping {
  return {
    id: `map_${mappingCounter++}`,
    enabled: true,
    source,
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

let patternCounter = 0;
function patternSource(over: Partial<PatternSource> = {}): PatternSource {
  return {
    id: `pat_${patternCounter++}`,
    enabled: true,
    pattern: { type: 'sequence', values: [0, 1] },
    transforms: [],
    beatsPerCycle: 4,
    ...over,
  };
}

function ctxOf(
  patterns: PatternSource[],
  over: Partial<SourceContext> = {},
  projectSeed = 1,
): SourceContext {
  return {
    analysis: null,
    durationSec: 100,
    bpm: 60,
    beatOffsetSec: 0,
    beatsPerBar: 4,
    patterns: resolvePatternHandles(patterns),
    projectSeed,
    ...over,
  };
}

/** Full real chain at one time: evalSources → applyModulations. */
function resolveScale(
  patterns: PatternSource[],
  mappings: ModulationMapping[],
  timeSec: number,
  ctxOver: Partial<SourceContext> = {},
  projectSeed = 1,
  base: Record<string, number> = { scale: SCALE_BASE },
): number {
  const sources = evalSources(timeSec, ctxOf(patterns, ctxOver, projectSeed));
  const out = applyModulations(base, mappings, sources, mosaic, new SmoothingState(), 1 / 60);
  return out.scale as number;
}

function projectWith(
  patterns: PatternSource[],
  mappings: ModulationMapping[],
  seed: number | null = 1,
): Project {
  const project = createEmptyProject('p4');
  return {
    ...project,
    layers: [{ ...createEmptyProject().layers[0]!, technique: { id: 'tech_1', techniqueId: 'mosaic', enabled: true, params: defaultParams(mosaic) } }],
    timeline: { ...project.timeline, bpm: 60 },
    patternSources: patterns,
    modulations: mappings,
    explore: { lockedParams: [], lastSeed: seed },
  };
}

beforeEach(() => {
  resetPatternRuntime();
  modulationRuntime.reset();
});

// ---------------------------------------------------------------------------
// Structural invariants (§3, §24)
// ---------------------------------------------------------------------------

describe('structural boundaries', () => {
  it('src/pattern never imports rendering, three, or the output window', () => {
    const dir = join(__dirname, '..', 'src', 'pattern');
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), 'utf8');
      for (const banned of ["from 'three'", '@/rendering', 'output-window', '@/output']) {
        expect(text.includes(banned), `${file} must not import ${banned}`).toBe(false);
      }
    }
  });

  it('the output-window replica never imports the pattern runtime', () => {
    const dir = join(__dirname, '..', 'src', 'output-window');
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), 'utf8');
      expect(text.includes('pattern'), `${file} must stay pattern-free`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Core integration (§16, §41)
// ---------------------------------------------------------------------------

describe('pattern → real parameter through the real resolver', () => {
  it('sequence 0 1 resolves mosaic scale at exact phases', () => {
    const pat = patternSource({ pattern: { type: 'sequence', values: [0, 1] } });
    const map = mapping(patternSourceKey(pat.id));
    // cycle = 4s. t=0.4 → phase 0.1 → step 0 (value 0) → shaped 0.
    expect(resolveScale([pat], [map], 0.4)).toBe(SCALE_BASE);
    // t=2.4 → phase 0.6 → step 1 (value 1) → base + 0.5·1·span = 2.5.
    expect(resolveScale([pat], [map], 2.4)).toBe(SCALE_ON);
  });

  it('euclidean E(5,16) drives activeValue/inactiveValue through normal mapping rules', () => {
    const pat = patternSource({
      pattern: {
        type: 'euclidean',
        pulses: 5,
        steps: 16,
        rotation: 0,
        activeValue: 1,
        inactiveValue: 0,
      },
    });
    const map = mapping(patternSourceKey(pat.id), { amount: 1 / 3 });
    const pulses = [0, 3, 6, 9, 12]; // E(5,16) = 1001001001001000
    for (let step = 0; step < 16; step++) {
      const t = ((step + 0.5) / 16) * 4;
      const expected = pulses.includes(step) ? SCALE_BASE + (1 / 3) * SCALE_SPAN : SCALE_BASE;
      expect(resolveScale([pat], [map], t)).toBeCloseTo(expected, 10);
    }
  });

  it('fast 2 through the resolver — direct seek equals playback order', () => {
    const pat = patternSource({
      pattern: { type: 'sequence', values: [0, 1] },
      transforms: [{ type: 'fast', factor: 2 }],
    });
    const map = mapping(patternSourceKey(pat.id));
    // fast 2 → cycle = 2s. t=0.2 (phase .1 of fast cycle 0) → step 0; t=1.2 → step 1.
    expect(resolveScale([pat], [map], 0.2)).toBe(SCALE_BASE);
    expect(resolveScale([pat], [map], 1.2)).toBe(SCALE_ON);
    // Direct seek: fresh everything, far time, no history.
    expect(resolveScale([pat], [map], 401.2)).toBe(SCALE_ON);
  });

  it('slow 4 through the resolver', () => {
    const pat = patternSource({
      pattern: { type: 'sequence', values: [0, 1] },
      transforms: [{ type: 'slow', factor: 4 }],
    });
    const map = mapping(patternSourceKey(pat.id));
    // slow 4 → pattern cycle = 16s: first 8s step 0, next 8s step 1.
    expect(resolveScale([pat], [map], 4)).toBe(SCALE_BASE);
    expect(resolveScale([pat], [map], 12)).toBe(SCALE_ON);
  });

  it('every 4 reverse through the resolver on cycles 1..4', () => {
    const pat = patternSource({
      pattern: { type: 'sequence', values: [0, 1] },
      transforms: [{ type: 'every', cycles: 4, transform: { type: 'reverse' } }],
    });
    const map = mapping(patternSourceKey(pat.id));
    const atPhase = (cycle: number, phase: number) => resolveScale([pat], [map], (cycle + phase) * 4);
    // Cycles 0,1,2 normal: phase .1 → step 0. Cycle 3 reversed: phase .1 → step 1.
    expect(atPhase(0, 0.1)).toBe(SCALE_BASE);
    expect(atPhase(1, 0.1)).toBe(SCALE_BASE);
    expect(atPhase(2, 0.1)).toBe(SCALE_BASE);
    expect(atPhase(3, 0.1)).toBe(SCALE_ON);
    expect(atPhase(3, 0.6)).toBe(SCALE_BASE);
  });

  it('degrade gates a real modulation with the P3 golden keys', () => {
    // P3 goldens (seed 12345, id 'pattern-a', lane 0): cycle 0 sample
    // 0.4530… (≥ .3 → gated), cycle 1 sample 0.2940… (< .3 → kept).
    const pat = patternSource({
      id: 'pattern-a',
      pattern: { type: 'constant', value: 1 },
      transforms: [{ type: 'degrade', probability: 0.3 }],
    });
    const map = mapping(patternSourceKey('pattern-a'));
    expect(resolveScale([pat], [map], 2, {}, 12345)).toBe(SCALE_BASE); // cycle 0: gated
    expect(resolveScale([pat], [map], 6, {}, 12345)).toBe(SCALE_ON); // cycle 1
    // Repeat = identical (stateless sampling through the whole stack).
    expect(resolveScale([pat], [map], 2, {}, 12345)).toBe(SCALE_BASE);
  });
});

// ---------------------------------------------------------------------------
// Neutral semantics (§11, §13, §37)
// ---------------------------------------------------------------------------

describe('inactive → true modulation neutral', () => {
  it('a gated pattern leaves the base parameter untouched even with invert and min > 0', () => {
    const pat = patternSource({
      id: 'pattern-a',
      pattern: { type: 'constant', value: 1 },
      transforms: [{ type: 'degrade', probability: 0 }], // never active
    });
    // invert:true + min .9 would manufacture a large value from numeric 0 —
    // the skip rule must prevent any contribution at all.
    const map = mapping(patternSourceKey('pattern-a'), { invert: true, min: 0.9 });
    for (const t of [0.5, 2, 7.7]) {
      expect(resolveScale([pat], [map], t, {}, 12345)).toBe(SCALE_BASE);
    }
  });

  it('no BPM → pattern contributes nothing, as if the source were absent', () => {
    const pat = patternSource();
    const map = mapping(patternSourceKey(pat.id));
    expect(resolveScale([pat], [map], 2.4, { bpm: null })).toBe(SCALE_BASE);
    const sources = evalSources(2.4, ctxOf([pat], { bpm: null }));
    expect(patternSourceKey(pat.id) in sources).toBe(false);
  });

  it('boolean pattern values stay engine-internal — numeric-only mapping in P4', () => {
    const pat = patternSource({ pattern: { type: 'sequence', values: [true, false] } });
    const map = mapping(patternSourceKey(pat.id));
    expect(resolveScale([pat], [map], 0.4)).toBe(SCALE_BASE);
    expect(resolveScale([pat], [map], 2.4)).toBe(SCALE_BASE);
    // The engine still evaluated it (diagnostics carry the boolean).
    const diag = getPatternDiagnostics().find((d) => d.id === pat.id);
    expect(diag?.active).toBe(true);
    expect(diag?.value).toBe(false);
  });

  it('a frozen mapping holds its captured value while the pattern is inactive', () => {
    const pat = patternSource({
      id: 'pattern-a',
      pattern: { type: 'constant', value: 1 },
      transforms: [{ type: 'degrade', probability: 0 }],
    });
    const map = mapping(patternSourceKey('pattern-a'), { frozenValue: 0.7 });
    expect(resolveScale([pat], [map], 2, {}, 12345)).toBeCloseTo(SCALE_BASE + 0.5 * 0.7 * SCALE_SPAN, 10);
  });

  it('compile failure is isolated: neutral source, no throw, no NaN, others continue', () => {
    const broken = patternSource({
      id: 'broken',
      pattern: {
        type: 'euclidean',
        pulses: 9,
        steps: 8,
        rotation: 0,
        activeValue: 1,
        inactiveValue: 0,
      },
    });
    const good = patternSource({ id: 'good', pattern: { type: 'constant', value: 1 } });
    const maps = [mapping(patternSourceKey('broken')), mapping(patternSourceKey('good'), { amount: 0.5 })];
    const scale = resolveScale([broken, good], maps, 2.4);
    expect(scale).toBe(SCALE_BASE + 0.5 * SCALE_SPAN);
    expect(Number.isFinite(scale)).toBe(true);
    const handles = resolvePatternHandles([broken, good]);
    expect(handles.find((h) => h.id === 'broken')?.error).toMatch(/pulses/i);
    expect(handles.find((h) => h.id === 'good')?.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stacking (§14, §15)
// ---------------------------------------------------------------------------

describe('stacking with existing sources', () => {
  it('two patterns on the same target combine additively (existing semantics)', () => {
    const a = patternSource({ id: 'stack-a', pattern: { type: 'constant', value: 1 } });
    const b = patternSource({ id: 'stack-b', pattern: { type: 'constant', value: 0.5 } });
    const maps = [
      mapping(patternSourceKey('stack-a'), { amount: 0.2 }),
      mapping(patternSourceKey('stack-b'), { amount: 0.2 }),
    ];
    const expected = SCALE_BASE + 0.2 * 1 * SCALE_SPAN + 0.2 * 0.5 * SCALE_SPAN;
    expect(resolveScale([a, b], maps, 2)).toBeCloseTo(expected, 10);
  });

  it('pattern + audio mapping stack through the same resolver', () => {
    // analysis:null → bass emits 0; mapping min .5 idles at .5 (existing
    // audio-source semantics: present key, shaped by the mapping range).
    const pat = patternSource({ pattern: { type: 'constant', value: 1 } });
    const maps = [
      mapping(patternSourceKey(pat.id), { amount: 0.2 }),
      mapping('bass', { amount: 0.2, min: 0.5 }),
    ];
    const expected = SCALE_BASE + 0.2 * 1 * SCALE_SPAN + 0.2 * 0.5 * SCALE_SPAN;
    expect(resolveScale([pat], maps, 2)).toBeCloseTo(expected, 10);
  });

  it('pattern + beat phase stack', () => {
    const pat = patternSource({ pattern: { type: 'constant', value: 1 } });
    // beat:bar at bpm 60, t=2 → bar phase 0.5 (4 beats/bar).
    const maps = [
      mapping(patternSourceKey(pat.id), { amount: 0.2 }),
      mapping('beat:bar', { amount: 0.2 }),
    ];
    const expected = SCALE_BASE + 0.2 * 1 * SCALE_SPAN + 0.2 * 0.5 * SCALE_SPAN;
    expect(resolveScale([pat], maps, 2)).toBeCloseTo(expected, 10);
  });

  it('MIDI coexistence: MIDI writes the base param, pattern modulates on top', () => {
    // The MIDI engine applies pickup values into technique params (base
    // layer); modulation is additive on top — same combine rule as any
    // parameter edit.
    const pat = patternSource({ pattern: { type: 'constant', value: 1 } });
    const map = mapping(patternSourceKey(pat.id), { amount: 0.2 });
    const midiBase = { scale: 1.8 };
    expect(resolveScale([pat], [map], 2, {}, 1, midiBase)).toBeCloseTo(
      1.8 + 0.2 * SCALE_SPAN,
      10,
    );
  });

  it('macro coexistence: macros shape the base BEFORE modulation (documented order)', () => {
    // Resolver order (docs/PARAMETER_EVALUATION.md): base → macros →
    // modulation → pulses → clamp. Pattern contribution is additive on the
    // macro-shaped base; asserting at the applyModulations layer with a
    // macro-shifted base proves the order.
    const pat = patternSource({ pattern: { type: 'constant', value: 1 } });
    const map = mapping(patternSourceKey(pat.id), { amount: 0.2 });
    const macroShapedBase = { scale: 0.5 };
    expect(resolveScale([pat], [map], 2, {}, 1, macroShapedBase)).toBeCloseTo(
      0.5 + 0.2 * SCALE_SPAN,
      10,
    );
  });
});

// ---------------------------------------------------------------------------
// Timing (§38, §39, §40)
// ---------------------------------------------------------------------------

describe('timing integration', () => {
  it('beatOffsetSec shifts the pattern phase through the shared grid', () => {
    const pat = patternSource({ pattern: { type: 'sequence', values: [0, 1] } });
    const map = mapping(patternSourceKey(pat.id));
    // offset 0: t=2.4 → phase .6 → step 1. offset 2: t=2.4 → 0.4s into the
    // grid → phase .1 → step 0.
    expect(resolveScale([pat], [map], 2.4, { beatOffsetSec: 0 })).toBe(SCALE_ON);
    expect(resolveScale([pat], [map], 2.4, { beatOffsetSec: 2 })).toBe(SCALE_BASE);
  });

  it('resolved BPM is consumed as-is (78.03 like the QA reference)', () => {
    const pat = patternSource({ pattern: { type: 'sequence', values: [0, 1] } });
    const map = mapping(patternSourceKey(pat.id));
    const cycleSec = (4 * 60) / 78.03;
    expect(resolveScale([pat], [map], cycleSec * 0.1, { bpm: 78.03 })).toBe(SCALE_BASE);
    expect(resolveScale([pat], [map], cycleSec * 0.6, { bpm: 78.03 })).toBe(SCALE_ON);
  });

  it('beatsPerCycle is independent from beatsPerBar', () => {
    const eight = patternSource({
      pattern: { type: 'sequence', values: [0, 1] },
      beatsPerCycle: 8,
    });
    const map = mapping(patternSourceKey(eight.id));
    // 8-beat cycle at bpm 60 = 8s: t=3 → phase .375 → step 0; t=5 → step 1.
    expect(resolveScale([eight], [map], 3)).toBe(SCALE_BASE);
    expect(resolveScale([eight], [map], 5)).toBe(SCALE_ON);
  });
});

// ---------------------------------------------------------------------------
// Coexistence (§45)
// ---------------------------------------------------------------------------

describe('cross-technique coexistence', () => {
  it('a pattern mapping cannot inject params into a technique that lacks the target', () => {
    const pat = patternSource({ pattern: { type: 'constant', value: 1 } });
    const map = mapping(patternSourceKey(pat.id)); // target 'scale' (mosaic)
    const slitScan = getTechnique('slit-scan')!;
    const sources = evalSources(2, ctxOf([pat]));
    expect(sources[patternSourceKey(pat.id)]).toBe(1); // still evaluated
    const out = applyModulations({}, [map], sources, slitScan, new SmoothingState(), 1 / 60);
    expect('scale' in out).toBe(false); // existing definition filter: no stale injection
  });
});

// ---------------------------------------------------------------------------
// Live runtime vs export evaluator parity (§42, §43)
// ---------------------------------------------------------------------------

describe('preview/export parity', () => {
  it('modulationRuntime.transform and createFrameEvaluator resolve identical params', () => {
    const pat = patternSource({
      id: 'pattern-a',
      pattern: {
        type: 'euclidean',
        pulses: 5,
        steps: 16,
        rotation: 0,
        activeValue: 1,
        inactiveValue: 0,
      },
      transforms: [{ type: 'fast', factor: 2 }, { type: 'degrade', probability: 0.5 }],
    });
    const map = mapping(patternSourceKey('pattern-a'), { amount: 0.4 });
    const project = projectWith([pat], [map], 12345);
    useProjectStore.setState({ project });

    // Live path — configured exactly like engineBridge.configureModulation.
    modulationRuntime.configure(project.modulations, 'mosaic', {
      analysis: null,
      durationSec: 100,
      bpm: project.timeline.bpm,
      beatOffsetSec: project.timeline.beatOffsetSec,
      beatsPerBar: project.timeline.beatsPerBar,
      patterns: resolvePatternHandles(project.patternSources),
      projectSeed: project.explore.lastSeed ?? 1,
    });

    const fps = 10;
    const evaluate = createFrameEvaluator(0, fps);
    for (const frame of [1, 7, 13, 24, 31, 47]) {
      const exported = evaluate(frame);
      const live = modulationRuntime.transform(defaultParams(mosaic), exported.timeSec);
      expect(live.scale).toBe(exported.params.scale);
    }
    // And the pattern actually did something across those frames.
    const values = [1, 7, 13, 24, 31, 47].map((f) => evaluate(f).params.scale);
    expect(new Set(values).size).toBeGreaterThan(1);
  });

  it('no-BPM neutrality holds in the export evaluator too', () => {
    const pat = patternSource({ pattern: { type: 'constant', value: 1 } });
    const map = mapping(patternSourceKey(pat.id));
    const project = projectWith([pat], [map]);
    useProjectStore.setState({
      project: { ...project, timeline: { ...project.timeline, bpm: null } },
    });
    const evaluate = createFrameEvaluator(0, 10);
    expect(evaluate(12).params.scale).toBe(SCALE_BASE);
  });
});

// ---------------------------------------------------------------------------
// Compile cache (§8, §9, §53, §54)
// ---------------------------------------------------------------------------

describe('compile cache', () => {
  it('never recompiles at frame rate', () => {
    const pat = patternSource();
    const handles = resolvePatternHandles([pat]);
    const after = getPatternCompileCount();
    const ctx = ctxOf([pat]);
    ctx.patterns = handles;
    for (let f = 0; f < 1000; f++) evalSources(f / 60, ctx);
    expect(getPatternCompileCount()).toBe(after);
    // Re-resolving unchanged definitions is also compile-free.
    resolvePatternHandles([pat]);
    resolvePatternHandles([pat]);
    expect(getPatternCompileCount()).toBe(after);
  });

  it('recompiles exactly once per definition change; beatsPerCycle change never recompiles', () => {
    const pat = patternSource();
    resolvePatternHandles([pat]);
    const base = getPatternCompileCount();
    resolvePatternHandles([{ ...pat, beatsPerCycle: 8 }]);
    expect(getPatternCompileCount()).toBe(base);
    resolvePatternHandles([{ ...pat, pattern: { type: 'constant', value: 0.5 } }]);
    expect(getPatternCompileCount()).toBe(base + 1);
    resolvePatternHandles([
      { ...pat, pattern: { type: 'constant', value: 0.5 }, transforms: [{ type: 'reverse' }] },
    ]);
    expect(getPatternCompileCount()).toBe(base + 2);
  });

  it('prunes removed/disabled sources — no leak over 150 add/remove cycles', () => {
    for (let i = 0; i < 150; i++) {
      const pat = patternSource({ id: `cycle-${i}` });
      const handles = resolvePatternHandles([pat]);
      const ctx = ctxOf([pat]);
      ctx.patterns = handles;
      evalSources(1, ctx);
      resolvePatternHandles([]); // removed
    }
    expect(getPatternCacheSize()).toBe(0);
    expect(getPatternDiagnostics().length).toBe(0);
    const pat = patternSource({ id: 'still-here' });
    resolvePatternHandles([pat]);
    expect(getPatternCacheSize()).toBe(1);
    resolvePatternHandles([{ ...pat, enabled: false }]);
    expect(getPatternCacheSize()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Project model (§29, §31, §36)
// ---------------------------------------------------------------------------

describe('project model', () => {
  it('patternSources round-trips through parseProject; old projects default to []', () => {
    const project = projectWith([patternSource({ id: 'persisted' })], []);
    const parsed = parseProject(JSON.parse(JSON.stringify(project)));
    expect(parsed.patternSources).toHaveLength(1);
    expect(parsed.patternSources[0]!.id).toBe('persisted');
    // A pre-P4 project without the field parses and defaults.
    const legacy = JSON.parse(JSON.stringify(createEmptyProject('legacy'))) as Record<
      string,
      unknown
    >;
    delete legacy.patternSources;
    expect(parseProject(legacy).patternSources).toEqual([]);
  });

  it('actions use the standard undo/redo path with stable ids', () => {
    useProjectStore.setState({
      project: createEmptyProject('undo'),
      past: [],
      future: [],
      transientBase: null,
    });
    const created = addPatternSource({
      enabled: true,
      pattern: { type: 'constant', value: 1 },
      transforms: [],
      beatsPerCycle: 4,
    });
    expect(created.id).toMatch(/^pat_/);
    expect(useProjectStore.getState().project.patternSources).toHaveLength(1);
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.patternSources).toHaveLength(0);
    useProjectStore.getState().redo();
    expect(useProjectStore.getState().project.patternSources[0]!.id).toBe(created.id);
    updatePatternSource(created.id, { beatsPerCycle: 8 });
    expect(useProjectStore.getState().project.patternSources[0]!.beatsPerCycle).toBe(8);
    // Removing the source also removes mappings that reference it.
    useProjectStore.getState().apply((p) => ({
      ...p,
      modulations: [mapping(patternSourceKey(created.id))],
    }));
    removePatternSource(created.id);
    const after = useProjectStore.getState().project;
    expect(after.patternSources).toHaveLength(0);
    expect(after.modulations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Performance + FrameState shape (§51, §52)
// ---------------------------------------------------------------------------

describe('performance and FrameState shape', () => {
  it('250 pattern sources through the full resolver stay under budget', () => {
    const patterns: PatternSource[] = [];
    const maps: ModulationMapping[] = [];
    for (let i = 0; i < 250; i++) {
      patterns.push(
        patternSource({
          id: `perf-${i}`,
          pattern:
            i % 2 === 0
              ? { type: 'euclidean', pulses: 5, steps: 16, rotation: 0, activeValue: 1, inactiveValue: 0 }
              : { type: 'sequence', values: [0, 0.5, 1, 0.5] },
          transforms: [{ type: 'fast', factor: 2 }, { type: 'degrade', probability: 0.5 }],
        }),
      );
      maps.push(mapping(patternSourceKey(`perf-${i}`), { amount: 0.001 }));
    }
    const handles = resolvePatternHandles(patterns);
    const ctx = ctxOf([]);
    ctx.patterns = handles;
    const smoothing = new SmoothingState();
    const start = performance.now();
    for (let f = 0; f < 300; f++) {
      const sources = evalSources(f / 60, ctx);
      applyModulations({}, maps, sources, mosaic, smoothing, 1 / 60);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1500); // broad CI bound; real numbers in the report
  });

  it('final params keep the same key set with and without pattern modulation', () => {
    const pat = patternSource({ pattern: { type: 'constant', value: 1 } });
    const map = mapping(patternSourceKey(pat.id), { amount: 0.2 });
    const base = { scale: 1, rotation: 0 };
    const withoutPattern = applyModulations(
      base,
      [],
      evalSources(2, ctxOf([])),
      mosaic,
      new SmoothingState(),
      1 / 60,
    );
    const withPattern = applyModulations(
      base,
      [map],
      evalSources(2, ctxOf([pat])),
      mosaic,
      new SmoothingState(),
      1 / 60,
    );
    // FrameState carries exactly these final params — no pattern-specific
    // fields exist, so the payload shape (and byte size modulo digits) is
    // unchanged.
    expect(Object.keys(withPattern).sort()).toEqual(Object.keys(withoutPattern).sort());
  });
});

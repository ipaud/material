import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { modulationRuntime } from '@/modulation/runtime';
import { evalSources, type SourceContext } from '@/modulation/sources';
import { applyModulations, SmoothingState } from '@/modulation/evaluator';
import { createFrameEvaluator } from '@/export/exportRunner';
import { patternSourceKey, resetPatternRuntime, resolvePatternHandles } from '@/pattern/patternSourceRuntime';
import { morphRuntime } from '@/performance/morphRuntime';
import { candidateRuntime } from '@/performance/candidateRuntime';
import { captureLookCore } from '@/performance/lookCore';
import { useProjectStore } from '@/state/projectStore';
import { getTechnique } from '@/techniques/registry';
import { defaultParams } from '@/techniques/types';
import { analyzeBuffer, type AudioAnalysis } from '@/audio/analysis';
import {
  createEmptyProject,
  type ModulationMapping,
  type PatternSource,
  type PinnedLook,
  type Project,
} from '@shared/schemas/project';

/**
 * P5 — PREVIEW === OUTPUT === EXPORT for pattern-driven state.
 *
 * Both sides run through PRODUCTION seams:
 *   live    → modulationRuntime.transform (what RenderEngine calls; its
 *             result is exactly what runtimeBus.emitFrame publishes as
 *             FrameState.finalParams, so live parity IS Output parity for
 *             values — the replica evaluates nothing)
 *   export  → createFrameEvaluator (the real offline evaluator)
 *
 * Mappings use smoothing 0 so equality is EXACT. Smoothed mappings are
 * history-dependent by design in both paths (see export-determinism.test.ts).
 */

const mosaic = getTechnique('mosaic')!;
const slitScan = getTechnique('slit-scan')!;

// ---- Canonical pattern QA project (§3) ----------------------------------
// Fixed seed / BPM / offset / ids. BPM 96 → beat 0.625s, 4-beat cycle 2.5s.
// beatOffset 0.375 is deliberately fractional and non-cycle-aligned.
const SEED = 12345;
const BPM = 96;
const BEAT_OFFSET = 0.375;
const BEAT_SEC = 60 / BPM; // 0.625
const CYCLE_SEC = 4 * BEAT_SEC; // 2.5

const PATTERNS: PatternSource[] = [
  {
    id: 'pat-a',
    enabled: true,
    beatsPerCycle: 4,
    pattern: { type: 'sequence', values: [0, 1, 0.25, 0.8] },
    transforms: [],
  },
  {
    id: 'pat-b',
    enabled: true,
    beatsPerCycle: 4,
    pattern: {
      type: 'euclidean',
      pulses: 5,
      steps: 16,
      rotation: 0,
      activeValue: 1,
      inactiveValue: 0,
    },
    transforms: [{ type: 'fast', factor: 2 }],
  },
  {
    id: 'pat-c',
    enabled: true,
    beatsPerCycle: 8, // deliberately not the bar length
    pattern: { type: 'sequence', values: [0.2, 0.7, 0.4] },
    transforms: [
      { type: 'every', cycles: 4, transform: { type: 'reverse' } },
      { type: 'degrade', probability: 0.63 },
    ],
  },
];

const MAPPINGS: ModulationMapping[] = [
  map('m-a', patternSourceKey('pat-a'), 'scale', 0.5),
  map('m-b', patternSourceKey('pat-b'), 'spacing', 0.4),
  map('m-c', patternSourceKey('pat-c'), 'rotation', 0.6),
];

const TARGETS = ['scale', 'spacing', 'rotation'] as const;

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

function qaProject(over: Partial<Project> = {}): Project {
  const p = createEmptyProject('pattern-qa');
  return {
    ...p,
    techniques: [
      { id: 'tech-1', techniqueId: 'mosaic', enabled: true, params: defaultParams(mosaic) },
    ],
    timeline: { ...p.timeline, bpm: BPM, beatOffsetSec: BEAT_OFFSET },
    patternSources: PATTERNS,
    modulations: MAPPINGS,
    explore: { lockedParams: [], lastSeed: SEED },
    ...over,
  };
}

/**
 * Configure the live runtime exactly as engineBridge.configureModulation
 * does. A structural test below guards this helper against drift.
 */
/** Analysis the live runtime is configured with (the audio store's role). */
let liveAnalysis: AudioAnalysis | null = null;
let liveDuration = 600;

function configureLive(project: Project): void {
  const instance = project.techniques.find((t) => t.enabled) ?? null;
  modulationRuntime.configure(project.modulations, instance?.techniqueId ?? null, {
    analysis: liveAnalysis,
    durationSec: liveDuration,
    bpm: project.timeline.bpm,
    beatOffsetSec: project.timeline.beatOffsetSec,
    beatsPerBar: project.timeline.beatsPerBar,
    patterns: resolvePatternHandles(project.patternSources),
    projectSeed: project.explore.lastSeed ?? 1,
  });
  modulationRuntime.configureMacros(project.macros);
}

/**
 * Live final params at composition time t — the exact values
 * runtimeBus.emitFrame publishes as FrameState.finalParams.
 *
 * Faithful to the production loop: PlaybackController ticks the morph
 * runtime before the frame is drawn, and the engineBridge store
 * subscription reconfigures modulation whenever the project changes (a
 * completed morph commits to the store), so both happen here too.
 */
function live(_project: Project, t: number): Record<string, unknown> {
  morphRuntime.tick(t);
  const project = useProjectStore.getState().project;
  configureLive(project);
  const instance = project.techniques.find((tq) => tq.enabled);
  const definition = getTechnique(instance?.techniqueId ?? 'mosaic')!;
  return modulationRuntime.transform(
    { ...defaultParams(definition), ...(instance?.params ?? {}) },
    t,
  ) as Record<string, unknown>;
}


/** PinnedLook matching the real schema (createdAt is an ISO string, note exists). */
function pinnedLook(over: Partial<PinnedLook> = {}): PinnedLook {
  return {
    id: 'look-target',
    createdAt: '2026-01-01T00:00:00.000Z',
    label: 'target',
    note: '',
    slot: 1,
    seed: SEED,
    thumbnail: null,
    techniques: [
      { id: 'tech-1', techniqueId: 'mosaic', enabled: true, params: { ...defaultParams(mosaic), scale: 2.4 } },
    ],
    material: createEmptyProject().material,
    modulations: [map('m-a', patternSourceKey('pat-a'), 'scale', 0.15)],
    triggers: [],
    ...over,
  };
}

function pick(params: Record<string, unknown>, keys: readonly string[] = TARGETS) {
  return Object.fromEntries(keys.map((k) => [k, params[k]]));
}

function installProject(
  project: Project,
  audio: { analysis: AudioAnalysis | null; durationSec: number } = { analysis: null, durationSec: 600 },
): Project {
  useProjectStore.setState({ project, past: [], future: [], transientBase: null });
  liveAnalysis = audio.analysis;
  liveDuration = audio.durationSec;
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
// §4 / §5 — fixed-time parity matrix
// ---------------------------------------------------------------------------

describe('preview/export parity matrix', () => {
  const EPS = 1e-4;
  const beat = (k: number) => BEAT_OFFSET + k * BEAT_SEC;
  const cycle = (k: number) => BEAT_OFFSET + k * CYCLE_SEC;
  const stepB = (k: number) => BEAT_OFFSET + (k * CYCLE_SEC) / 32; // pat-b: fast2 × 16 steps

  const TIMES: [string, number][] = [
    ['zero', 0],
    ['pre-grid', 0.1],
    ['beat boundary', beat(3)],
    ['just before beat', beat(3) - EPS],
    ['just after beat', beat(3) + EPS],
    ['step boundary (pat-b)', stepB(7)],
    ['just before step', stepB(7) - EPS],
    ['just after step', stepB(7) + EPS],
    ['cycle boundary', cycle(2)],
    ['just before cycle', cycle(2) - EPS],
    ['just after cycle', cycle(2) + EPS],
    ['1.234', 1.234],
    ['7.000', 7],
    ['23.456', 23.456],
    ['123.456', 123.456],
  ];

  it('live and export resolve identical final params at every matrix time', () => {
    const project = installProject(qaProject());
    const fps = 1000; // frameIndex = ms → any of the matrix times is reachable
    const evaluate = createFrameEvaluator(0, fps);
    for (const [label, t] of TIMES) {
      const frame = Math.round(t * fps);
      const exported = evaluate(frame);
      const previewed = live(project, exported.timeSec);
      expect(pick(previewed), `${label} @ ${exported.timeSec}`).toEqual(
        pick(exported.params as Record<string, unknown>),
      );
    }
  });

  it('the matrix actually moves all three pattern targets', () => {
    const project = installProject(qaProject());
    const seen = { scale: new Set<unknown>(), spacing: new Set<unknown>(), rotation: new Set<unknown>() };
    for (const [, t] of TIMES) {
      const p = live(project, t);
      for (const k of TARGETS) seen[k].add(p[k]);
    }
    for (const k of TARGETS) expect(seen[k].size, `${k} never changed`).toBeGreaterThan(1);
  });

  it('the live-configure helper still mirrors engineBridge', () => {
    const bridge = readFileSync(join(__dirname, '..', 'src', 'rendering', 'engineBridge.ts'), 'utf8');
    expect(bridge).toContain('patterns: resolvePatternHandles(project.patternSources)');
    expect(bridge).toContain('projectSeed: project.explore.lastSeed ?? 1');
  });
});

// ---------------------------------------------------------------------------
// §6 / §7 — no BPM, beat offset
// ---------------------------------------------------------------------------

describe('timing parity', () => {
  it('no BPM: both paths contribute nothing, identically', () => {
    const p = createEmptyProject('no-bpm');
    const project = installProject(
      qaProject({ timeline: { ...p.timeline, bpm: null, beatOffsetSec: BEAT_OFFSET } }),
    );
    const evaluate = createFrameEvaluator(0, 60);
    const base = defaultParams(mosaic);
    for (const frame of [0, 37, 512]) {
      const exported = evaluate(frame);
      expect(pick(exported.params as Record<string, unknown>)).toEqual(pick(base));
      expect(pick(live(project, exported.timeSec))).toEqual(pick(base));
    }
  });

  it('fractional beat offsets shift both paths the same way', () => {
    for (const offset of [0, 0.375, 1.2345, 3.9]) {
      const p = createEmptyProject('offset');
      const project = installProject(
        qaProject({ timeline: { ...p.timeline, bpm: BPM, beatOffsetSec: offset } }),
      );
      const evaluate = createFrameEvaluator(0, 1000);
      for (const frame of [0, 1234, 7000, 23456]) {
        const exported = evaluate(frame);
        expect(pick(live(project, exported.timeSec)), `offset ${offset} @ ${exported.timeSec}`).toEqual(
          pick(exported.params as Record<string, unknown>),
        );
      }
    }
  });

  it('offset is relative to global composition time, not the export range start', () => {
    const project = installProject(qaProject());
    // Same absolute time reached from two different export ranges.
    const fromZero = createFrameEvaluator(0, 100)(2200); // t = 22
    const fromMid = createFrameEvaluator(22, 100)(0); // t = 22
    expect(fromMid.timeSec).toBeCloseTo(22, 12);
    expect(pick(fromMid.params as Record<string, unknown>)).toEqual(
      pick(fromZero.params as Record<string, unknown>),
    );
    expect(pick(live(project, 22))).toEqual(pick(fromMid.params as Record<string, unknown>));
  });
});

// ---------------------------------------------------------------------------
// §8 / §9 / §38 — export range start and fps independence
// ---------------------------------------------------------------------------

describe('export range and fps independence', () => {
  it('frame 0 of a 22s→28s export evaluates at 22s (sequence, slow, degrade)', () => {
    const project = installProject(
      qaProject({
        patternSources: [
          PATTERNS[0]!,
          { ...PATTERNS[1]!, transforms: [{ type: 'slow', factor: 4 }] },
          PATTERNS[2]!,
        ],
      }),
    );
    const evaluate = createFrameEvaluator(22, 30);
    expect(evaluate(0).timeSec).toBe(22);
    for (const frame of [0, 45, 179]) {
      const exported = evaluate(frame);
      expect(exported.timeSec).toBeCloseTo(22 + frame / 30, 12);
      expect(pick(live(project, exported.timeSec))).toEqual(
        pick(exported.params as Record<string, unknown>),
      );
    }
  });

  it('an unaligned start (17.381s) resolves the same as the global timeline', () => {
    const project = installProject(qaProject());
    const shifted = createFrameEvaluator(17.381, 25);
    for (const frame of [0, 1, 13, 97]) {
      const exported = shifted(frame);
      expect(pick(live(project, exported.timeSec))).toEqual(
        pick(exported.params as Record<string, unknown>),
      );
    }
  });

  it('24 / 25 / 30 / 60 fps agree at matching composition timestamps', () => {
    installProject(qaProject());
    const at = (fps: number, seconds: number) =>
      pick(createFrameEvaluator(0, fps)(Math.round(seconds * fps)).params as Record<string, unknown>);
    for (const seconds of [1, 3, 7.5, 20]) {
      const reference = at(24, seconds);
      for (const fps of [25, 30, 60]) {
        expect(at(fps, seconds), `${fps}fps @ ${seconds}s`).toEqual(reference);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §10–§13 — seek and loop
// ---------------------------------------------------------------------------

describe('seek and loop', () => {
  it('direct seek equals playback-through in both paths', () => {
    const project = installProject(qaProject());
    const target = 41.7;
    const direct = pick(live(project, target));
    // Walk there frame by frame first, then re-read the same instant.
    for (let f = 0; f < 600; f++) live(project, f / 60);
    expect(pick(live(project, target))).toEqual(direct);
    const evaluate = createFrameEvaluator(0, 60);
    for (let f = 0; f < 600; f++) evaluate(f);
    expect(pick(evaluate(Math.round(target * 60)).params as Record<string, unknown>)).toEqual(direct);
  });

  it('backward seek resolves from absolute time with no stale state', () => {
    const project = installProject(qaProject());
    const early = pick(live(project, 3.3));
    live(project, 88.8);
    live(project, 120.1);
    expect(pick(live(project, 3.3))).toEqual(early);
  });

  it('a 2s → 122s jump lands correctly with no intermediate evaluation', () => {
    const project = installProject(qaProject());
    const jumped = pick(live(project, 122));
    installProject(qaProject()); // fresh runtime, no history at all
    expect(pick(live(project, 122))).toEqual(jumped);
    const evaluate = createFrameEvaluator(122, 60);
    expect(pick(evaluate(0).params as Record<string, unknown>)).toEqual(jumped);
  });

  it('loop wrap: post-wrap values match a cold evaluation at the loop start', () => {
    const project = installProject(qaProject());
    const coldStart = pick(live(project, 0.05));
    // Play to the loop end, wrap, continue.
    for (let f = 0; f < 300; f++) live(project, 20 + f / 60);
    const wrapped = [0.05, 0.1, 0.2].map((t) => pick(live(project, t)));
    installProject(qaProject());
    expect(wrapped[0]).toEqual(coldStart);
    expect(wrapped).toEqual([0.05, 0.1, 0.2].map((t) => pick(live(project, t))));
  });
});

// ---------------------------------------------------------------------------
// §14–§16 — morph
// ---------------------------------------------------------------------------

describe('morph parity', () => {
  /** Arm the same morph on both sides: live runtime + recorded export event. */
  function armMorph(project: Project, look: PinnedLook, startTime: number, endTime: number) {
    const withLook: Project = { ...project, pinnedLooks: [look] };
    installProject(withLook);
    const source = captureLookCore(withLook)!;
    const withEvent: Project = {
      ...withLook,
      morphEvents: [
        { id: 'morph-1', startTime, endTime, curve: 'linear', sourceSnapshot: source, targetLookId: look.id },
      ],
    };
    installProject(withEvent);
    morphRuntime.start(
      look.id,
      { startQuantize: 'off', duration: { mode: 'seconds', seconds: endTime - startTime }, curve: 'linear' },
      startTime,
    );
    return withEvent;
  }

  const lookOf = pinnedLook;

  it('same-technique morph: live and export agree across the whole progression', () => {
    const project = armMorph(qaProject(), lookOf(), 0, 4);
    const evaluate = createFrameEvaluator(0, 1000);
    for (const pct of [0, 0.25, 0.499, 0.5, 0.501, 0.75, 1]) {
      const t = pct * 4;
      const exported = evaluate(Math.round(t * 1000));
      expect(pick(live(project, exported.timeSec), ['scale']), `progress ${pct}`).toEqual(
        pick(exported.params as Record<string, unknown>, ['scale']),
      );
    }
    morphRuntime.abortSilently();
  });

  it('cross-technique morph filters a mosaic-only pattern mapping after the switch', () => {
    const slitLook = lookOf({
      id: 'look-slit',
      techniques: [
        { id: 'tech-1', techniqueId: 'slit-scan', enabled: true, params: defaultParams(slitScan) },
      ],
      modulations: [map('m-strips', patternSourceKey('pat-b'), 'strips', 0.5)],
    });
    const project = armMorph(qaProject(), slitLook, 0, 4);
    const evaluate = createFrameEvaluator(0, 1000);
    let sawMosaic = false;
    let sawSlit = false;
    for (const t of [0.1, 1, 2, 3, 3.9, 4.5]) {
      const exported = evaluate(Math.round(t * 1000));
      const previewed = live(project, exported.timeSec);
      expect(previewed.techniqueId ?? exported.techniqueId).toBeDefined();
      if (exported.techniqueId === 'mosaic') {
        sawMosaic = true;
        // A slit-scan-only target can never appear on a mosaic frame.
        expect('strips' in (exported.params as object)).toBe(false);
        expect(pick(previewed, ['scale'])).toEqual(pick(exported.params as Record<string, unknown>, ['scale']));
      } else {
        sawSlit = true;
        // And the mosaic-only pattern target is filtered out, not injected stale.
        expect('scale' in (exported.params as object)).toBe(false);
        expect(pick(previewed, ['strips'])).toEqual(pick(exported.params as Record<string, unknown>, ['strips']));
      }
    }
    expect(sawMosaic && sawSlit).toBe(true);
    morphRuntime.abortSilently();
  });

  it('inverse morph: a mosaic pattern mapping starts contributing once mosaic is evaluated', () => {
    const slitBase = qaProject({
      techniques: [
        { id: 'tech-1', techniqueId: 'slit-scan', enabled: true, params: defaultParams(slitScan) },
      ],
    });
    const project = armMorph(slitBase, lookOf(), 0, 4);
    const evaluate = createFrameEvaluator(0, 1000);
    const late = evaluate(4500);
    expect(late.techniqueId).toBe('mosaic');
    const params = late.params as Record<string, unknown>;
    expect(params.scale).not.toBe(defaultParams(mosaic).scale);
    expect(pick(live(project, late.timeSec), ['scale'])).toEqual(pick(params, ['scale']));
    morphRuntime.abortSilently();
  });
});

// ---------------------------------------------------------------------------
// §17 — temporal technique
// ---------------------------------------------------------------------------

describe('temporal technique parity', () => {
  it('a pattern mapped to a slit-scan parameter resolves identically in both paths', () => {
    const project = installProject(
      qaProject({
        techniques: [
          { id: 'tech-1', techniqueId: 'slit-scan', enabled: true, params: defaultParams(slitScan) },
        ],
        modulations: [map('m-strips', patternSourceKey('pat-b'), 'strips', 0.5)],
      }),
    );
    const evaluate = createFrameEvaluator(0, 60);
    for (const frame of [0, 17, 61, 240]) {
      const exported = evaluate(frame);
      expect(pick(live(project, exported.timeSec), ['strips'])).toEqual(
        pick(exported.params as Record<string, unknown>, ['strips']),
      );
    }
    // Values actually move, and stay inside the definition range.
    const values: number[] = [];
    for (let f = 0; f < 240; f++) values.push(evaluate(f).params.strips as number);
    expect(new Set(values).size).toBeGreaterThan(1);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(512);
    }
  });
});

// ---------------------------------------------------------------------------
// §25 / §26 / §27 — mixed sources and multiple patterns
// ---------------------------------------------------------------------------

describe('mixed source parity', () => {
  function analysisFixture() {
    const sampleRate = 48000;
    const mono = new Float32Array(sampleRate * 6);
    for (let i = 0; i < mono.length; i++) {
      const t = i / sampleRate;
      const burst = Math.floor(t * 4) % 2 === 0 ? 1 : 0.2;
      mono[i] = Math.sin(2 * Math.PI * 60 * t) * burst + Math.sin(2 * Math.PI * 5000 * t) * 0.3 * burst;
    }
    return analyzeBuffer(mono, sampleRate);
  }

  it('audio + beat + three patterns stack identically in both paths', () => {
    const analysis = analysisFixture();
    const project = qaProject({
      modulations: [
        ...MAPPINGS,
        map('m-bass', 'bass', 'scale', 0.3),
        map('m-beat', 'beat:1/4', 'spacing', 0.2),
      ],
    });
    installProject(project, { analysis, durationSec: 6 });
    const instance = project.techniques[0]!;
    // Export reads analysis from the audio store; drive evalSources directly
    // with the export context shape instead (same function, same inputs).
    const ctx: SourceContext = {
      analysis,
      durationSec: 6,
      bpm: BPM,
      beatOffsetSec: BEAT_OFFSET,
      beatsPerBar: 4,
      patterns: resolvePatternHandles(project.patternSources),
      projectSeed: SEED,
    };
    for (const t of [0.4, 1.7, 2.5, 4.25]) {
      const exported = applyModulations(
        { ...defaultParams(mosaic), ...instance.params },
        project.modulations,
        evalSources(t, ctx),
        mosaic,
        new SmoothingState(),
        1 / 60,
      );
      expect(pick(live(project, t))).toEqual(pick(exported as Record<string, unknown>));
    }
  });

  it('pattern handle iteration order never changes resolved values', () => {
    const project = qaProject();
    resetPatternRuntime();
    const forward = resolvePatternHandles(project.patternSources);
    const ctxFwd: SourceContext = {
      analysis: null,
      durationSec: 600,
      bpm: BPM,
      beatOffsetSec: BEAT_OFFSET,
      beatsPerBar: 4,
      patterns: forward,
      projectSeed: SEED,
    };
    const ctxRev: SourceContext = { ...ctxFwd, patterns: [...forward].reverse() };
    for (const t of [0.2, 3.9, 12.75, 40.1]) {
      expect(evalSources(t, ctxRev)).toEqual(evalSources(t, ctxFwd));
    }
  });

  it('two patterns on one target stack additively in both paths', () => {
    const project = installProject(
      qaProject({
        modulations: [
          map('m-a', patternSourceKey('pat-a'), 'scale', 0.3),
          map('m-c', patternSourceKey('pat-c'), 'scale', 0.3),
        ],
      }),
    );
    const evaluate = createFrameEvaluator(0, 60);
    for (const frame of [7, 61, 133]) {
      const exported = evaluate(frame);
      expect(pick(live(project, exported.timeSec), ['scale'])).toEqual(
        pick(exported.params as Record<string, unknown>, ['scale']),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// §29 / §30 / §31 — seed behaviour and reload
// ---------------------------------------------------------------------------

describe('seed and reload determinism', () => {
  const probe = (project: Project) => [0.5, 3.1, 9.9, 21.4].map((t) => live(project, t).rotation);

  it('changing explore.lastSeed changes degrade outcomes deterministically and reversibly', () => {
    const a1 = probe(installProject(qaProject()));
    const b = probe(
      installProject(qaProject({ explore: { lockedParams: [], lastSeed: 999 } })),
    );
    const a2 = probe(installProject(qaProject()));
    expect(a2).toEqual(a1);
    expect(b).not.toEqual(a1);
  });

  it('export replay uses the seed in force at each frame, not a start-of-export snapshot', () => {
    // A look apply mid-timeline swaps the working seed; frames before and
    // after must use different seeds — and match a preview configured the
    // same way on each side of the boundary.
    const look = pinnedLook({
      id: 'look-seed',
      label: 'seed-swap',
      seed: 999,
      techniques: [
        { id: 'tech-1', techniqueId: 'mosaic', enabled: true, params: defaultParams(mosaic) },
      ],
      modulations: MAPPINGS,
    });
    const source = captureLookCore(qaProject())!;
    const project = installProject(
      qaProject({
        pinnedLooks: [look],
        morphEvents: [
          { id: 'm-seed', startTime: 4, endTime: 4.001, curve: 'linear', sourceSnapshot: source, targetLookId: 'look-seed' },
        ],
      }),
    );
    const evaluate = createFrameEvaluator(0, 100);
    const before = evaluate(200).params.rotation; // t = 2, seed 12345
    const after = evaluate(800).params.rotation; // t = 8, seed 999 after the swap

    const seedA = installProject(qaProject());
    expect(live(seedA, 2).rotation).toBe(before);
    const seedB = installProject(qaProject({ explore: { lockedParams: [], lastSeed: 999 } }));
    expect(live(seedB, 8).rotation).toBe(after);
    expect(project.explore.lastSeed).toBe(SEED);
  });

  it('a serialized round-trip of the project reproduces every sampled value', () => {
    const original = installProject(qaProject());
    const values = probe(original);
    const reloaded = installProject(JSON.parse(JSON.stringify(original)) as Project);
    expect(probe(reloaded)).toEqual(values);
  });
});

// ---------------------------------------------------------------------------
// §36 / §37 — long export, byte determinism of the evaluated stream
// ---------------------------------------------------------------------------

describe('long and repeatable export', () => {
  /** Cheap order-sensitive digest of an evaluated parameter stream. */
  function digest(values: number[]): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < values.length; i++) {
      const s = `${i}:${values[i]!.toPrecision(17)}`;
      for (let c = 0; c < s.length; c++) {
        h1 = Math.imul(h1 ^ s.charCodeAt(c), 0x01000193) >>> 0;
        h2 = (Math.imul(h2 ^ s.charCodeAt(c), 0x85ebca6b) >>> 0) ^ (h1 >>> 7);
      }
    }
    return `${h1.toString(16)}-${(h2 >>> 0).toString(16)}`;
  }

  function exportStream(frames: number, fps = 30, startSec = 0): number[] {
    const evaluate = createFrameEvaluator(startSec, fps);
    const out: number[] = [];
    for (let f = 0; f < frames; f++) {
      const p = evaluate(f).params;
      out.push(p.scale as number, p.spacing as number, p.rotation as number);
    }
    return out;
  }

  it('a 3-minute export with slow/every/degrade/euclidean repeats byte-for-byte', () => {
    installProject(
      qaProject({
        patternSources: [
          PATTERNS[0]!,
          { ...PATTERNS[1]!, transforms: [{ type: 'slow', factor: 4 }] },
          PATTERNS[2]!,
        ],
      }),
    );
    const FRAMES = 30 * 180; // 3 minutes at 30fps
    const first = exportStream(FRAMES);
    const firstDigest = digest(first);
    installProject(
      qaProject({
        patternSources: [
          PATTERNS[0]!,
          { ...PATTERNS[1]!, transforms: [{ type: 'slow', factor: 4 }] },
          PATTERNS[2]!,
        ],
      }),
    );
    expect(digest(exportStream(FRAMES))).toBe(firstDigest);
    // No drift/accumulation: the stream keeps moving and stays finite.
    expect(first.every((v) => Number.isFinite(v))).toBe(true);
    const tail = first.slice(-300);
    expect(new Set(tail).size).toBeGreaterThan(1);
  });

  it('an unaligned-start export is also repeatable', () => {
    installProject(qaProject());
    const a = digest(exportStream(1200, 30, 17.381));
    installProject(qaProject());
    expect(digest(exportStream(1200, 30, 17.381))).toBe(a);
  });

  it('cross-technique morph + degrade + temporal target exports repeatably', () => {
    const slitLook = pinnedLook({
      id: 'look-slit',
      label: 'slit',
      techniques: [
        { id: 'tech-1', techniqueId: 'slit-scan', enabled: true, params: defaultParams(slitScan) },
      ],
      modulations: [
        map('m-strips', patternSourceKey('pat-b'), 'strips', 0.5),
        map('m-span', patternSourceKey('pat-c'), 'spanSec', 0.4),
      ],
    });
    const build = () => {
      const base = qaProject({ pinnedLooks: [slitLook] });
      const source = captureLookCore(base)!;
      return installProject({
        ...base,
        morphEvents: [
          { id: 'm-x', startTime: 2, endTime: 6, curve: 'linear', sourceSnapshot: source, targetLookId: 'look-slit' },
        ],
      });
    };
    const run = () => {
      build();
      const evaluate = createFrameEvaluator(0, 30);
      const stream: number[] = [];
      const techniques: (string | null)[] = [];
      for (let f = 0; f < 300; f++) {
        const r = evaluate(f);
        techniques.push(r.techniqueId);
        const p = r.params as Record<string, number>;
        stream.push(p.scale ?? -1, p.strips ?? -1, p.spanSec ?? -1, p.rotation ?? -1);
      }
      return { d: digest(stream), techniques };
    };
    const first = run();
    const second = run();
    expect(second.d).toBe(first.d);
    // The export really did cross the technique boundary.
    expect(new Set(first.techniques).size).toBe(2);
    expect(first.techniques.at(-1)).toBe('slit-scan');
  });
});

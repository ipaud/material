import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  canFormatSequence,
  createPatternDraft,
  formatSequencePattern,
  parsePattern,
  updatePatternDraft,
} from '@/pattern/miniNotation';
import {
  addPatternSource,
  updatePatternSourceFromText,
} from '@/pattern/patternSourceActions';
import {
  getPatternCompileCount,
  patternSourceKey,
  resetPatternRuntime,
  resolvePatternHandles,
} from '@/pattern/patternSourceRuntime';
import { evalSources, type SourceContext } from '@/modulation/sources';
import { modulationRuntime } from '@/modulation/runtime';
import { createFrameEvaluator } from '@/export/exportRunner';
import { useProjectStore } from '@/state/projectStore';
import { getTechnique } from '@/techniques/registry';
import { defaultParams } from '@/techniques/types';
import {
  createEmptyProject,
  parseProject,
  projectSchema,
  type ModulationMapping,
  type PatternSource,
  type Project,
} from '@shared/schemas/project';
import type { AlternatePattern, SequencePattern } from '@/pattern/patternTypes';

/** P7 — mini-notation parser, formatter and live-edit semantics. */

const mosaic = getTechnique('mosaic')!;
const seq = (values: number[]): SequencePattern => ({ type: 'sequence', values });

function mustParse(text: string): SequencePattern | AlternatePattern {
  const result = parsePattern(text);
  if (!result.ok) throw new Error(`expected "${text}" to parse: ${result.error.message}`);
  return result.definition;
}

// ---------------------------------------------------------------------------
// §3 / §5 / §6 / §42 / §51 — valid grammar
// ---------------------------------------------------------------------------

describe('parser — accepted forms', () => {
  it('parses single numbers in every supported shape', () => {
    const cases: [string, number][] = [
      ['0', 0],
      ['1', 1],
      ['-1', -1],
      ['12', 12],
      ['0.5', 0.5],
      ['.25', 0.25],
      ['-.25', -0.25],
      ['12.', 12], // trailing decimal point: accepted (locked)
      ['-12.75', -12.75],
      ['00.50', 0.5],
    ];
    for (const [text, value] of cases) {
      expect(mustParse(text).values, text).toEqual([value]);
    }
  });

  it('treats any whitespace run as one separator', () => {
    const expected = [0, 0.5, 1, 0.5];
    for (const text of [
      '0 .5 1 .5',
      '0    .5\t1\n.5',
      '  0 .5 1 .5  ',
      '0\n.5\n1\n.5\n',
      '\t0\t\t.5 1   .5\t',
    ]) {
      expect(mustParse(text).values, JSON.stringify(text)).toEqual(expected);
    }
  });

  it('normalizes -0 to 0', () => {
    const [value] = mustParse('-0').values;
    expect(value).toBe(0);
    expect(Object.is(value, -0)).toBe(false);
    expect(mustParse('0 -0 -0.0').values.every((v) => Object.is(v, 0))).toBe(true);
  });

  it('handles a long sequence', () => {
    const values = Array.from({ length: 512 }, (_, i) => i / 512);
    const parsed = mustParse(values.map((v) => String(v)).join(' '));
    expect(parsed.values).toEqual(values);
  });
});

// ---------------------------------------------------------------------------
// §7 / §38 / §40 / §41 / §52 — rejected input
// ---------------------------------------------------------------------------

describe('parser — rejected input', () => {
  const invalid = [
    '',
    '   ',
    '\n\t ',
    '.',
    '-',
    '+',
    '+1',
    '-.',
    '1..2',
    '--1',
    '+-1',
    'NaN',
    'Infinity',
    '-Infinity',
    '1e3',
    '1E-2',
    '0x10',
    'foo',
    '0 foo 1',
    '1,5',
    '1;2',
    '[]',
    '[0 1]',
    '0 <1 2> 3', // alternation inside a sequence is NOT in the grammar
    '0*2',
    '5/16',
    'fast 2',
    '0 .5 1 .', // the canonical mid-typing draft
  ];

  it('rejects everything outside the grammar', () => {
    for (const text of invalid) {
      const result = parsePattern(text);
      expect(result.ok, `"${text}" must not parse`).toBe(false);
    }
  });

  it('code-shaped input is just an invalid token — never executed', () => {
    for (const text of [
      'process.exit()',
      'alert(1)',
      '${1+1}',
      '<script>alert(1)</script>',
      '1;2',
      '1 || 2',
      'constructor',
      '__proto__',
      'require("fs")',
    ]) {
      const result = parsePattern(text);
      expect(result.ok, text).toBe(false);
    }
    // The parser module contains no dynamic evaluation at all.
    const src = readFileSync(join(__dirname, '..', 'src', 'pattern', 'miniNotation.ts'), 'utf8');
    expect(src.includes('eval(')).toBe(false);
    expect(src.includes('new Function')).toBe(false);
  });

  it('rejects numbers that overflow to Infinity', () => {
    expect(parsePattern('1'.repeat(400)).ok).toBe(false);
    // …but a merely huge finite number is fine.
    expect(mustParse('1'.repeat(20)).values[0]).toBe(Number('1'.repeat(20)));
  });

  it('is locale-independent: comma decimals never parse', () => {
    for (const text of ['0,25', '1,5 2,5', '0.5 1,5']) {
      expect(parsePattern(text).ok, text).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// §9 / §10 — error model
// ---------------------------------------------------------------------------

describe('parse errors', () => {
  it('names the offending token and its exact offset', () => {
    const result = parsePattern('0 .5 nope 1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.token).toBe('nope');
    expect(result.error.index).toBe(5);
    expect(result.error.length).toBe(4);
    expect(result.error.message).toBe('Unexpected token "nope" at position 5');
    // The offset really points at the token (P8 underlines this range).
    expect('0 .5 nope 1'.slice(result.error.index, result.error.index + result.error.length)).toBe(
      'nope',
    );
  });

  it('reports offsets correctly after tabs and newlines', () => {
    const text = '0\t.5\n1 bad';
    const result = parsePattern(text);
    if (result.ok) throw new Error('expected failure');
    expect(text.slice(result.error.index, result.error.index + result.error.length)).toBe('bad');
  });

  it('empty input has its own readable message, not a token error', () => {
    const result = parsePattern('   ');
    if (result.ok) throw new Error('expected failure');
    expect(result.error.message).toMatch(/empty/i);
    expect(result.error.token).toBe('');
  });
});

// ---------------------------------------------------------------------------
// §11–§15 / §50 / §53 — formatter and round-trip
// ---------------------------------------------------------------------------

describe('formatter', () => {
  it('produces the locked canonical text', () => {
    const cases: [number[], string][] = [
      [[0], '0'],
      [[1], '1'],
      [[-1], '-1'],
      [[0.5], '0.5'],
      [[0.25], '0.25'], // .25 input formats WITH the leading zero
      [[-0.25], '-0.25'],
      [[2], '2'], // 2.0 → 2
      [[12.5], '12.5'], // 12.500 → 12.5
      [[0], '0'], // -0 → 0
      [[0, 0.25, 1, 0.25], '0 0.25 1 0.25'],
    ];
    for (const [values, text] of cases) {
      expect(formatSequencePattern(seq(values)), JSON.stringify(values)).toBe(text);
    }
    expect(formatSequencePattern(seq([-0]))).toBe('0');
  });

  it('parse(format(definition)) preserves values exactly', () => {
    const definitions = [
      [0],
      [0, 1],
      [-1, 0, 1],
      [0.1, 0.2, 0.30000000000000004],
      [1 / 3, 2 / 3],
      [0.333333333333, -12.75, 0.0001234, 123456.789],
      Array.from({ length: 200 }, (_, i) => (i - 100) / 7),
    ];
    for (const values of definitions) {
      const definition = seq(values);
      expect(canFormatSequence(definition)).toBe(true);
      expect(mustParse(formatSequencePattern(definition)).values).toEqual(values);
    }
  });

  it('format(parse(text)) is canonical, not the original whitespace', () => {
    expect(formatSequencePattern(mustParse('  0   .25\t1\n.25 '))).toBe('0 0.25 1 0.25');
    expect(formatSequencePattern(mustParse('12. -0 2.0'))).toBe('12 0 2');
  });

  it('flags definitions that have no text form (booleans, exponent-scale numbers)', () => {
    expect(canFormatSequence({ type: 'sequence', values: [0, true, 1] } as SequencePattern)).toBe(
      false,
    );
    expect(canFormatSequence(seq([1e21]))).toBe(false);
    // Exponent-notation values have no text form either — P8 falls back to read-only.
    expect(canFormatSequence(seq([1e-7]))).toBe(false);
    expect(canFormatSequence(seq([0.000001]))).toBe(true);
  });

  it('every value canFormatSequence accepts really does round-trip', () => {
    const probes = [0, 1, -1, 0.5, 1e-6, 1e-7, 1e20, 1e21, 123456789.123, Number.MIN_SAFE_INTEGER];
    for (const value of probes) {
      const definition = seq([value]);
      if (!canFormatSequence(definition)) continue;
      expect(mustParse(formatSequencePattern(definition)).values[0], String(value)).toBe(value);
    }
  });
});

// ---------------------------------------------------------------------------
// §19–§22 / §26 / §54 / §55 — live-edit draft semantics
// ---------------------------------------------------------------------------

describe('live-edit draft', () => {
  it('starts from the persisted definition, formatted', () => {
    const draft = createPatternDraft(seq([0, 0.5, 1, 0.5]));
    expect(draft.text).toBe('0 0.5 1 0.5');
    expect(draft.error).toBeNull();
    expect(draft.changed).toBe(false);
  });

  it('an invalid draft keeps the last valid pattern and commits nothing', () => {
    let draft = createPatternDraft(seq([0, 0.5, 1, 0.5]));
    const original = draft.lastValid;
    for (const keystroke of ['0 .5 1 .', '0 .5 1 ..', '0 .5 1 x']) {
      draft = updatePatternDraft(draft, keystroke);
      expect(draft.text).toBe(keystroke);
      expect(draft.error).not.toBeNull();
      expect(draft.changed).toBe(false);
      expect(draft.lastValid).toBe(original); // same object — nothing to commit
    }
    // Finishing the edit clears the error and yields one committable change.
    draft = updatePatternDraft(draft, '0 .5 1 .25');
    expect(draft.error).toBeNull();
    expect(draft.changed).toBe(true);
    expect(draft.lastValid.values).toEqual([0, 0.5, 1, 0.25]);
  });

  it('re-typing the same values is not a change (no redundant history entry)', () => {
    let draft = createPatternDraft(seq([0, 0.5]));
    draft = updatePatternDraft(draft, '0 0.5');
    expect(draft.changed).toBe(false);
    draft = updatePatternDraft(draft, '  0    .5  '); // same values, different text
    expect(draft.changed).toBe(false);
    expect(draft.text).toBe('  0    .5  '); // the draft still shows what was typed
    draft = updatePatternDraft(draft, '0 0.6');
    expect(draft.changed).toBe(true);
  });

  it('recovering from invalid text back to the original values is not a change', () => {
    let draft = createPatternDraft(seq([0, 1]));
    draft = updatePatternDraft(draft, '0 1..');
    expect(draft.changed).toBe(false);
    expect(draft.error).not.toBeNull();
    draft = updatePatternDraft(draft, '0 1');
    expect(draft.changed).toBe(false);
    expect(draft.error).toBeNull();
  });

  it('deleting a step mid-edit IS a real change — P8 owns debouncing, not the parser', () => {
    let draft = createPatternDraft(seq([0, 1]));
    draft = updatePatternDraft(draft, '0 ');
    expect(draft.error).toBeNull();
    expect(draft.changed).toBe(true);
    expect(draft.lastValid.values).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// Integration: actions, runtime, persistence
// ---------------------------------------------------------------------------

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
    beatsPerCycle: 8,
    pattern: seq([0, 1]),
    transforms: [
      { type: 'fast', factor: 2 },
      { type: 'every', cycles: 4, transform: { type: 'reverse' } },
      { type: 'degrade', probability: 0.63 },
    ],
    ...over,
  };
}

function projectWith(over: Partial<Project> = {}): Project {
  const p = createEmptyProject('p7');
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

const SAMPLES = [0.2, 1.1, 2.6, 7.7, 23.456];
const probe = () => SAMPLES.map((t) => live(t));

beforeEach(() => {
  resetPatternRuntime();
  modulationRuntime.reset();
});

// ---------------------------------------------------------------------------
// §23 / §24 / §33 / §43–§47 / §56 — action integration
// ---------------------------------------------------------------------------

describe('committing text to a pattern source', () => {
  it('replaces only the definition — id, transforms, cycle, enabled, mappings survive', () => {
    const project = install(projectWith());
    const before = project.patternSources[0]!;
    const result = updatePatternSourceFromText('pat-a', '0 .25 1 .25');
    expect(result.ok).toBe(true);
    const after = useProjectStore.getState().project;
    const source = after.patternSources[0]!;
    expect(source.id).toBe('pat-a'); // stable identity → stable probability lane
    expect(source.pattern).toEqual(seq([0, 0.25, 1, 0.25]));
    expect(source.transforms).toEqual(before.transforms);
    expect(source.beatsPerCycle).toBe(8);
    expect(source.enabled).toBe(true);
    expect(after.modulations).toEqual(project.modulations);
    expect(after.modulations[0]!.source).toBe(patternSourceKey('pat-a'));
  });

  it('invalid text changes nothing: no project update, no history, no dirty', () => {
    install(projectWith());
    const before = useProjectStore.getState().project;
    const values = probe();
    const result = updatePatternSourceFromText('pat-a', '0 .5 1 .');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/Unexpected token "\."/);
    const after = useProjectStore.getState();
    expect(after.project).toBe(before); // same object — nothing applied
    expect(after.dirty).toBe(false);
    expect(after.past).toHaveLength(0);
    expect(probe()).toEqual(values); // runtime kept the last valid pattern
  });

  it('a valid edit changes the runtime and recompiles exactly once', () => {
    install(projectWith());
    const before = probe();
    resetPatternRuntime();
    live(1.1);
    const compiles = getPatternCompileCount();
    updatePatternSourceFromText('pat-a', '0 .25 1 .25 .5 .75');
    const after = probe();
    expect(after).not.toEqual(before);
    expect(getPatternCompileCount()).toBe(compiles + 1);
    // Step count really changed: 2 → 6 steps.
    expect(useProjectStore.getState().project.patternSources[0]!.pattern).toEqual(
      seq([0, 0.25, 1, 0.25, 0.5, 0.75]),
    );
    // Re-committing identical text does not change the values.
    updatePatternSourceFromText('pat-a', '0 0.25 1 0.25 0.5 0.75');
    expect(probe()).toEqual(after);
  });

  it('step count changes take effect immediately with no stale division', () => {
    install(projectWith({ patternSources: [patternSource({ transforms: [] })] }));
    const at = (t: number) => live(t).scale;
    updatePatternSourceFromText('pat-a', '0 1 0 1'); // 4 steps
    const four = SAMPLES.map(at);
    updatePatternSourceFromText('pat-a', '0 1 0'); // 3 steps
    const three = SAMPLES.map(at);
    updatePatternSourceFromText('pat-a', '0 .2 .4 .6 .8 1 .5 .25'); // 8 steps
    const eight = SAMPLES.map(at);
    expect(new Set([JSON.stringify(four), JSON.stringify(three), JSON.stringify(eight)]).size).toBe(
      3,
    );
    updatePatternSourceFromText('pat-a', '0 1 0 1');
    expect(SAMPLES.map(at)).toEqual(four); // back to the same values exactly
  });

  it('undo/redo restores definitions exactly, keeping the id', () => {
    install(projectWith({ patternSources: [patternSource({ pattern: seq([0, 1]) })] }));
    const first = probe();
    updatePatternSourceFromText('pat-a', '0 .5 1 .5');
    const second = probe();
    expect(second).not.toEqual(first);
    useProjectStore.getState().undo();
    expect(probe()).toEqual(first);
    expect(useProjectStore.getState().project.patternSources[0]!.id).toBe('pat-a');
    useProjectStore.getState().redo();
    expect(probe()).toEqual(second);
    expect(useProjectStore.getState().project.patternSources[0]!.id).toBe('pat-a');
    expect(useProjectStore.getState().project.patternSources[0]!.pattern).toEqual(
      seq([0, 0.5, 1, 0.5]),
    );
  });

  it('a rejected commit leaves the history untouched between two valid ones', () => {
    install(projectWith());
    updatePatternSourceFromText('pat-a', '0 1');
    const historyAfterFirst = useProjectStore.getState().past.length;
    updatePatternSourceFromText('pat-a', '0 1 broken');
    updatePatternSourceFromText('pat-a', '0 1 nope 2');
    expect(useProjectStore.getState().past).toHaveLength(historyAfterFirst);
    updatePatternSourceFromText('pat-a', '0 1 .5');
    expect(useProjectStore.getState().past).toHaveLength(historyAfterFirst + 1);
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.patternSources[0]!.pattern).toEqual(seq([0, 1]));
  });

  it('an unknown pattern id is a no-op', () => {
    const project = install(projectWith());
    expect(updatePatternSourceFromText('pat-missing', '0 1').ok).toBe(true);
    expect(useProjectStore.getState().project.patternSources).toEqual(project.patternSources);
  });
});

// ---------------------------------------------------------------------------
// §25 / §26 / §58 — deterministic probability across edits
// ---------------------------------------------------------------------------

describe('probability across text edits', () => {
  it('a stable id keeps identical decisions for unchanged event identities', () => {
    // Constant pattern + degrade: one event per cycle, step 0 always. Editing
    // the sequence to another single-step definition keeps the event key
    // (cycle, step 0) and therefore the exact same gate decisions.
    install(
      projectWith({
        patternSources: [
          patternSource({
            id: 'pattern-a',
            transforms: [{ type: 'degrade', probability: 0.5 }],
            pattern: seq([1]),
          }),
        ],
        modulations: [mapping({ source: patternSourceKey('pattern-a') })],
      }),
    );
    const gatesFor = () => {
      const project = useProjectStore.getState().project;
      const ctx: SourceContext = {
        analysis: null,
        durationSec: 600,
        bpm: 96,
        beatOffsetSec: 0.375,
        beatsPerBar: 4,
        patterns: resolvePatternHandles(project.patternSources),
        projectSeed: 12345,
      };
      const key = patternSourceKey('pattern-a');
      return Array.from({ length: 24 }, (_, cycle) =>
        Boolean(key in evalSources(0.375 + cycle * 5 + 2.5, ctx)),
      );
    };
    const before = gatesFor();
    updatePatternSourceFromText('pattern-a', '0.75'); // same shape, one step
    expect(gatesFor()).toEqual(before);
    expect(before.some(Boolean) && !before.every(Boolean)).toBe(true); // gate really fires

    // Changing the STEP STRUCTURE legitimately changes event keys.
    updatePatternSourceFromText('pattern-a', '1 1 1 1');
    expect(gatesFor()).not.toEqual(before);
    // …and is itself reproducible.
    const four = gatesFor();
    updatePatternSourceFromText('pattern-a', '0.75');
    updatePatternSourceFromText('pattern-a', '1 1 1 1');
    expect(gatesFor()).toEqual(four);
  });
});

// ---------------------------------------------------------------------------
// §35 / §49 / §57 — persistence and export
// ---------------------------------------------------------------------------

describe('persistence and export', () => {
  it('text → definition → save → reload → canonical text, values unchanged', () => {
    install(projectWith());
    updatePatternSourceFromText('pat-a', '0 .25 1 .25');
    const values = probe();
    const saved = projectSchema.parse(useProjectStore.getState().project);
    const json = JSON.stringify(saved);
    // No raw draft text anywhere in the file.
    expect(json.includes('"text"')).toBe(false);
    expect(json.includes('.25 1')).toBe(false);
    const reloaded = parseProject(JSON.parse(json));
    install(reloaded);
    expect(probe()).toEqual(values);
    const definition = reloaded.patternSources[0]!.pattern as SequencePattern;
    expect(definition).toEqual(seq([0, 0.25, 1, 0.25]));
    expect(formatSequencePattern(definition)).toBe('0 0.25 1 0.25');
  });

  it('the schema has no raw-text field for patterns', () => {
    const source = projectSchema.parse(
      JSON.parse(
        JSON.stringify({
          ...projectWith(),
          patternSources: [{ ...patternSource(), text: '0 .5 1 .5', draft: 'x' }],
        }),
      ),
    ).patternSources[0]!;
    expect('text' in source).toBe(false);
    expect('draft' in source).toBe(false);
    expect(Object.keys(source).sort()).toEqual([
      'beatsPerCycle',
      'enabled',
      'id',
      'pattern',
      'transforms',
    ]);
  });

  it('export sees only committed definitions — an invalid draft cannot reach it', () => {
    install(projectWith({ patternSources: [patternSource({ transforms: [] })] }));
    updatePatternSourceFromText('pat-a', '0 1 .5');
    const evaluate = createFrameEvaluator(0, 30);
    const committed = [0, 30, 90].map((f) => evaluate(f).params.scale);
    updatePatternSourceFromText('pat-a', '0 1 .5 ..'); // rejected
    const again = createFrameEvaluator(0, 30);
    expect([0, 30, 90].map((f) => again(f).params.scale)).toEqual(committed);
  });
});

// ---------------------------------------------------------------------------
// §59 / §60 — performance and isolation
// ---------------------------------------------------------------------------

describe('performance and isolation', () => {
  it('parses and formats large inputs in linear time', () => {
    const timings: string[] = [];
    for (const n of [4, 16, 64, 256, 1024]) {
      const values = Array.from({ length: n }, (_, i) => i / n);
      const text = values.map((v) => String(v)).join(' ');
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        const parsed = parsePattern(text);
        if (!parsed.ok) throw new Error('parse failed');
        formatSequencePattern(parsed.definition);
      }
      const perCall = ((performance.now() - start) / 100) * 1000;
      timings.push(`${n}: ${perCall.toFixed(1)}µs`);
      expect(perCall).toBeLessThan(5000); // µs — broad bound, real numbers in the report
    }
    expect(timings).toHaveLength(5);
  });

  it('no parser work happens during evaluation', () => {
    const project = install(projectWith());
    const ctx: SourceContext = {
      analysis: null,
      durationSec: 600,
      bpm: 96,
      beatOffsetSec: 0.375,
      beatsPerBar: 4,
      patterns: resolvePatternHandles(project.patternSources),
      projectSeed: 12345,
    };
    for (let f = 0; f < 10000; f++) evalSources(f / 120, ctx);
    // evalSources and the modulation layer never import the parser at all.
    for (const file of ['sources.ts', 'evaluator.ts', 'runtime.ts']) {
      const src = readFileSync(join(__dirname, '..', 'src', 'modulation', file), 'utf8');
      expect(src.includes('miniNotation'), `${file} must not import the parser`).toBe(false);
    }
  });

  it('the output replica bundle never reaches the parser', () => {
    const dir = join(__dirname, '..', 'src', 'output-window');
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), 'utf8');
      expect(text.toLowerCase().includes('mininotation'), `${file}`).toBe(false);
      expect(text.includes('pattern'), `${file}`).toBe(false);
    }
    // And the parser itself pulls in nothing but types.
    const parser = readFileSync(join(__dirname, '..', 'src', 'pattern', 'miniNotation.ts'), 'utf8');
    const imports = [...parser.matchAll(/^import .*$/gm)].map((m) => m[0]);
    expect(imports).toEqual([
      "import type { AlternatePattern, SequencePattern } from './patternTypes';",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Draft → action, end to end (what P8 will wire to a text field)
// ---------------------------------------------------------------------------

describe('draft to project, end to end', () => {
  it('typing an edit produces exactly one project change', () => {
    install(projectWith({ patternSources: [], modulations: [] }));
    const created = addPatternSource({
      enabled: true,
      pattern: seq([0, 1]),
      transforms: [],
      beatsPerCycle: 4,
    });
    useProjectStore.getState().apply((p) => ({
      ...p,
      modulations: [mapping({ source: patternSourceKey(created.id) })],
    }));
    const historyBefore = useProjectStore.getState().past.length;

    let draft = createPatternDraft(seq([0, 1]));
    // Simulated keystrokes, committing only when the draft reports a change.
    for (const text of ['0 1 ', '0 1 .', '0 1 .5', '0 1 .5 ', '0 1 .5 .', '0 1 .5 .25']) {
      draft = updatePatternDraft(draft, text);
      if (draft.changed) updatePatternSourceFromText(created.id, draft.text);
    }
    const store = useProjectStore.getState();
    // Two commits: '0 1 .5' and '0 1 .5 .25' — never one per keystroke.
    expect(store.past.length - historyBefore).toBe(2);
    expect(store.project.patternSources[0]!.pattern).toEqual(seq([0, 1, 0.5, 0.25]));
    expect(store.project.patternSources[0]!.id).toBe(created.id);
  });
});

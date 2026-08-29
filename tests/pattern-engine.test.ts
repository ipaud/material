import { describe, expect, it } from 'vitest';
import { compilePattern, type CompiledPattern } from '@/pattern/compilePattern';
import { evaluatePattern } from '@/pattern/evaluatePattern';
import { euclideanMask } from '@/pattern/euclidean';
import type { PatternDefinition, PatternTransform } from '@/pattern/patternTypes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mustCompile(def: PatternDefinition, transforms: PatternTransform[] = []): CompiledPattern {
  const result = compilePattern(def, transforms);
  if (!result.ok) throw new Error(result.error);
  return result.pattern;
}

const seq = (values: (number | boolean)[]): PatternDefinition => ({ type: 'sequence', values });

function valueAt(compiled: CompiledPattern, cycleIndex: number, cyclePhase: number) {
  const r = evaluatePattern(compiled, { cycleIndex, cyclePhase });
  if (!r.active || r.value === null) throw new Error('unexpected inactive');
  return r.value;
}

/** Values sampled at the center of each of `n` slots within one cycle. */
function cycleSamples(compiled: CompiledPattern, cycleIndex: number, n: number) {
  const out: (number | boolean)[] = [];
  for (let i = 0; i < n; i++) out.push(valueAt(compiled, cycleIndex, (i + 0.5) / n));
  return out;
}

const maskString = (pulses: number, steps: number) =>
  euclideanMask(pulses, steps)
    .map((b) => (b ? '1' : '0'))
    .join('');

// ---------------------------------------------------------------------------
// Constant
// ---------------------------------------------------------------------------

describe('constant', () => {
  it('returns the same value at arbitrary times, all types', () => {
    for (const v of [0.5, -3, 0.123, true, false]) {
      const c = mustCompile({ type: 'constant', value: v });
      for (const [cy, ph] of [
        [0, 0],
        [7, 0.99],
        [-3, 0.5],
        [1e6, 0.001],
      ] as const) {
        expect(valueAt(c, cy, ph)).toBe(v);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Sequence
// ---------------------------------------------------------------------------

describe('sequence', () => {
  it('spec example: 0 .5 1 .5 at quarter phases', () => {
    const c = mustCompile(seq([0, 0.5, 1, 0.5]));
    expect(valueAt(c, 0, 0)).toBe(0);
    expect(valueAt(c, 0, 0.25)).toBe(0.5);
    expect(valueAt(c, 0, 0.5)).toBe(1);
    expect(valueAt(c, 0, 0.75)).toBe(0.5);
  });

  it('1 / 2 / 3 element sequences divide the cycle evenly', () => {
    expect(cycleSamples(mustCompile(seq([7])), 0, 4)).toEqual([7, 7, 7, 7]);
    expect(cycleSamples(mustCompile(seq([1, 2])), 0, 4)).toEqual([1, 1, 2, 2]);
    expect(cycleSamples(mustCompile(seq([1, 2, 3])), 0, 3)).toEqual([1, 2, 3]);
  });

  it('booleans, negatives and fractions survive untouched', () => {
    const c = mustCompile(seq([true, -1.5, 0.25, false]));
    expect(cycleSamples(c, 0, 4)).toEqual([true, -1.5, 0.25, false]);
  });

  it('exact step boundaries belong to the RIGHT step; cycle boundary is step 0', () => {
    const c = mustCompile(seq([10, 20, 30, 40]));
    expect(valueAt(c, 0, 0.25)).toBe(20);
    expect(valueAt(c, 0, 0.5)).toBe(30);
    expect(valueAt(c, 3, 0)).toBe(10);
  });

  it('final epsilon before the cycle end stays on the last step', () => {
    const c = mustCompile(seq([1, 2, 3, 4]));
    expect(valueAt(c, 0, 0.999999)).toBe(4);
  });

  it('phase ~1 from float error rolls into the next cycle step 0', () => {
    const c = mustCompile(seq([1, 2, 3, 4]));
    const r = evaluatePattern(c, { cycleIndex: 0, cyclePhase: 1 - 1e-12 });
    expect(r).toMatchObject({ active: true, value: 1, cycleIndex: 1 });
  });

  it('negative (pre-roll) and huge cycles are ordinary', () => {
    const c = mustCompile(seq([1, 2, 3, 4]));
    expect(valueAt(c, -1, 0.25)).toBe(2);
    expect(valueAt(c, -5, 0.75)).toBe(4);
    expect(valueAt(c, 2_000_000, 0.5)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Euclidean
// ---------------------------------------------------------------------------

describe('euclidean canonical orientation (locked)', () => {
  it('classic masks', () => {
    expect(maskString(0, 8)).toBe('00000000');
    expect(maskString(1, 8)).toBe('10000000');
    expect(maskString(3, 8)).toBe('10010010');
    expect(maskString(5, 8)).toBe('10110110');
    expect(maskString(8, 8)).toBe('11111111');
    expect(maskString(5, 16)).toBe('1001001001001000');
    expect(maskString(2, 5)).toBe('10100');
    expect(maskString(4, 4)).toBe('1111');
  });

  it('pulse count is always exact', () => {
    for (let steps = 1; steps <= 16; steps++) {
      for (let pulses = 0; pulses <= steps; pulses++) {
        const count = euclideanMask(pulses, steps).filter(Boolean).length;
        expect(count).toBe(pulses);
      }
    }
  });
});

describe('euclidean pattern', () => {
  const euclid = (pulses: number, steps: number, rotation = 0): PatternDefinition => ({
    type: 'euclidean',
    pulses,
    steps,
    rotation,
    activeValue: 1,
    inactiveValue: 0,
  });

  it('3/8: pulses land on the canonical steps', () => {
    const c = mustCompile(euclid(3, 8));
    expect(cycleSamples(c, 0, 8)).toEqual([1, 0, 0, 1, 0, 0, 1, 0]);
  });

  it('0/8 all inactive · 8/8 all active', () => {
    expect(cycleSamples(mustCompile(euclid(0, 8)), 0, 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(cycleSamples(mustCompile(euclid(8, 8)), 0, 8)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('rotation +1 shifts the pattern forward one step', () => {
    const c = mustCompile(euclid(3, 8, 1));
    expect(cycleSamples(c, 0, 8)).toEqual([0, 1, 0, 0, 1, 0, 0, 1]);
  });

  it('rotation -1 / rotation ≡ steps+1 normalize identically', () => {
    const minus = cycleSamples(mustCompile(euclid(3, 8, -1)), 0, 8);
    const plus7 = cycleSamples(mustCompile(euclid(3, 8, 7)), 0, 8);
    const plus17 = cycleSamples(mustCompile(euclid(3, 8, -9)), 0, 8);
    expect(minus).toEqual([0, 0, 1, 0, 0, 1, 0, 1]);
    expect(plus7).toEqual(minus);
    expect(plus17).toEqual(minus);
  });

  it('custom active/inactive values, booleans included', () => {
    const c = mustCompile({
      type: 'euclidean',
      pulses: 1,
      steps: 4,
      rotation: 0,
      activeValue: true,
      inactiveValue: false,
    });
    expect(cycleSamples(c, 0, 4)).toEqual([true, false, false, false]);
  });
});

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

describe('fast', () => {
  it('x2: pattern repeats twice per cycle', () => {
    const c = mustCompile(seq([1, 2]), [{ type: 'fast', factor: 2 }]);
    expect(cycleSamples(c, 0, 8)).toEqual([1, 1, 2, 2, 1, 1, 2, 2]);
  });

  it('x4 and fractional factors derive from absolute position', () => {
    const c4 = mustCompile(seq([1, 2]), [{ type: 'fast', factor: 4 }]);
    expect(cycleSamples(c4, 0, 8)).toEqual([1, 2, 1, 2, 1, 2, 1, 2]);
    const cHalf = mustCompile(seq([1, 2]), [{ type: 'fast', factor: 0.5 }]);
    // fast 0.5 === slow 2
    expect(valueAt(cHalf, 0, 0.25)).toBe(1);
    expect(valueAt(cHalf, 1, 0.25)).toBe(2);
  });

  it('cycle identity flows through: fast 2 at cycle boundary', () => {
    const c = mustCompile(seq([1, 2]), [{ type: 'fast', factor: 2 }]);
    expect(valueAt(c, 1, 0)).toBe(1);
    expect(valueAt(c, -1, 0.75)).toBe(2); // pre-roll
  });
});

describe('slow', () => {
  it('x4: the pattern spans four cycles — direct seek, no history', () => {
    const c = mustCompile(seq([1, 2, 3, 4]), [{ type: 'slow', factor: 4 }]);
    expect(valueAt(c, 0, 0.5)).toBe(1);
    expect(valueAt(c, 1, 0.5)).toBe(2);
    expect(valueAt(c, 2, 0.5)).toBe(3);
    expect(valueAt(c, 3, 0.5)).toBe(4);
    expect(valueAt(c, 4, 0.5)).toBe(1);
    // direct seek into cycle 73: 73.5/4 = 18.375 → phase .375 → step 1
    expect(valueAt(c, 73, 0.5)).toBe(2);
  });

  it('x2 cross-cycle + huge time + pre-roll', () => {
    const c = mustCompile(seq([1, 2]), [{ type: 'slow', factor: 2 }]);
    expect(valueAt(c, 0, 0.9)).toBe(1);
    expect(valueAt(c, 1, 0.1)).toBe(2);
    expect(valueAt(c, 1e6, 0.5)).toBe(1); // 1e6/2 exact → phase .25 → step 1? 500000.25 → step 1 of [1,2] len2 → floor(.25*2)=0 → 1
    expect(valueAt(c, -1, 0.5)).toBe(2); // -0.25 → cycle -1, phase 0.75 → step 1
  });
});

describe('reverse', () => {
  it('plays the sequence backwards within the cycle', () => {
    const c = mustCompile(seq([1, 2, 3, 4]), [{ type: 'reverse' }]);
    expect(cycleSamples(c, 0, 4)).toEqual([4, 3, 2, 1]);
  });

  it('boundaries: phase 0 is the LAST step; the exact next-cycle boundary never yields stale phase 1', () => {
    const c = mustCompile(seq([1, 2, 3, 4]), [{ type: 'reverse' }]);
    expect(valueAt(c, 0, 0)).toBe(4);
    expect(valueAt(c, 0, 0.999999)).toBe(1);
    // exact boundary arrives as phase 0 of cycle 1 (clock guarantees this)
    expect(valueAt(c, 1, 0)).toBe(4);
    // float creep just below 1 rolls forward, still step-safe
    const r = evaluatePattern(c, { cycleIndex: 0, cyclePhase: 1 - 1e-12 });
    expect(r).toMatchObject({ active: true, value: 4 });
  });

  it('pre-roll reverses identically', () => {
    const c = mustCompile(seq([1, 2, 3, 4]), [{ type: 'reverse' }]);
    expect(cycleSamples(c, -2, 4)).toEqual([4, 3, 2, 1]);
  });
});

describe('rotate', () => {
  it('0 / +1 / -1 / length on a sequence', () => {
    const base = seq([1, 2, 3, 4]);
    expect(cycleSamples(mustCompile(base, [{ type: 'rotate', steps: 0 }]), 0, 4)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(cycleSamples(mustCompile(base, [{ type: 'rotate', steps: 1 }]), 0, 4)).toEqual([
      4, 1, 2, 3,
    ]);
    expect(cycleSamples(mustCompile(base, [{ type: 'rotate', steps: -1 }]), 0, 4)).toEqual([
      2, 3, 4, 1,
    ]);
    expect(cycleSamples(mustCompile(base, [{ type: 'rotate', steps: 4 }]), 0, 4)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(cycleSamples(mustCompile(base, [{ type: 'rotate', steps: 9 }]), 0, 4)).toEqual([
      4, 1, 2, 3,
    ]);
  });

  it('rotate transform ≡ euclidean rotation field', () => {
    const viaField = mustCompile({
      type: 'euclidean',
      pulses: 3,
      steps: 8,
      rotation: 2,
      activeValue: 1,
      inactiveValue: 0,
    });
    const viaTransform = mustCompile(
      { type: 'euclidean', pulses: 3, steps: 8, rotation: 0, activeValue: 1, inactiveValue: 0 },
      [{ type: 'rotate', steps: 2 }],
    );
    expect(cycleSamples(viaTransform, 0, 8)).toEqual(cycleSamples(viaField, 0, 8));
  });

  it('rotate on constant is a no-op', () => {
    const c = mustCompile({ type: 'constant', value: 5 }, [{ type: 'rotate', steps: 3 }]);
    expect(valueAt(c, 0, 0.5)).toBe(5);
  });
});

describe('every', () => {
  const rev: PatternTransform = { type: 'reverse' };

  it('cycles=4: 1 normal, 2 normal, 3 normal, 4 transformed', () => {
    const c = mustCompile(seq([1, 2, 3, 4]), [{ type: 'every', cycles: 4, transform: rev }]);
    expect(cycleSamples(c, 0, 4)).toEqual([1, 2, 3, 4]);
    expect(cycleSamples(c, 1, 4)).toEqual([1, 2, 3, 4]);
    expect(cycleSamples(c, 2, 4)).toEqual([1, 2, 3, 4]);
    expect(cycleSamples(c, 3, 4)).toEqual([4, 3, 2, 1]);
    expect(cycleSamples(c, 7, 4)).toEqual([4, 3, 2, 1]);
  });

  it('cycles=1 transforms every cycle; cycles=2 alternates', () => {
    const c1 = mustCompile(seq([1, 2]), [{ type: 'every', cycles: 1, transform: rev }]);
    expect(cycleSamples(c1, 0, 2)).toEqual([2, 1]);
    const c2 = mustCompile(seq([1, 2]), [{ type: 'every', cycles: 2, transform: rev }]);
    expect(cycleSamples(c2, 0, 2)).toEqual([1, 2]);
    expect(cycleSamples(c2, 1, 2)).toEqual([2, 1]);
  });

  it('direct seek into transformed and normal cycles needs no history', () => {
    const c = mustCompile(seq([10, 20]), [{ type: 'every', cycles: 4, transform: rev }]);
    expect(valueAt(c, 4003, 0.25)).toBe(20); // 4003 % 4 = 3 → transformed
    expect(valueAt(c, 4001, 0.25)).toBe(10); // normal
  });

  it('negative pre-roll cycles follow true modulo: …,-5,-1,3,7 transformed (n=4)', () => {
    const c = mustCompile(seq([1, 2]), [{ type: 'every', cycles: 4, transform: rev }]);
    expect(cycleSamples(c, -1, 2)).toEqual([2, 1]); // mod(-1,4)=3 → transformed
    expect(cycleSamples(c, -5, 2)).toEqual([2, 1]);
    expect(cycleSamples(c, -2, 2)).toEqual([1, 2]); // mod(-2,4)=2 → normal
  });

  it('nested rotate and nested fast work', () => {
    const cr = mustCompile(seq([1, 2, 3, 4]), [
      { type: 'every', cycles: 2, transform: { type: 'rotate', steps: 1 } },
    ]);
    expect(cycleSamples(cr, 0, 4)).toEqual([1, 2, 3, 4]);
    expect(cycleSamples(cr, 1, 4)).toEqual([4, 1, 2, 3]);
    const cf = mustCompile(seq([1, 2]), [
      { type: 'every', cycles: 2, transform: { type: 'fast', factor: 2 } },
    ]);
    expect(cycleSamples(cf, 0, 4)).toEqual([1, 1, 2, 2]);
    expect(cycleSamples(cf, 1, 4)).toEqual([1, 2, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Transform order
// ---------------------------------------------------------------------------

describe('transform order (serialized order is semantic)', () => {
  it('rotate → reverse differs from reverse → rotate', () => {
    const base = seq([1, 2, 3, 4]);
    const rotRev = mustCompile(base, [{ type: 'rotate', steps: 1 }, { type: 'reverse' }]);
    const revRot = mustCompile(base, [{ type: 'reverse' }, { type: 'rotate', steps: 1 }]);
    // rotate1: [4,1,2,3]; then reverse: [3,2,1,4]
    expect(cycleSamples(rotRev, 0, 4)).toEqual([3, 2, 1, 4]);
    // reverse: [4,3,2,1]; then rotate1: [1,4,3,2]
    expect(cycleSamples(revRot, 0, 4)).toEqual([1, 4, 3, 2]);
  });

  it('fast → every differs from every → fast (every reads its chain-position cycle)', () => {
    const base = seq([1, 2]);
    const fastThenEvery = mustCompile(base, [
      { type: 'fast', factor: 2 },
      { type: 'every', cycles: 2, transform: { type: 'reverse' } },
    ]);
    const everyThenFast = mustCompile(base, [
      { type: 'every', cycles: 2, transform: { type: 'reverse' } },
      { type: 'fast', factor: 2 },
    ]);
    // fast first: cycle 0 becomes transformed halves alternating (post-fast
    // cycles 0,1 → second half transformed):
    expect(cycleSamples(fastThenEvery, 0, 4)).toEqual([1, 2, 2, 1]);
    // every first reads the ORIGINAL cycle (0 → normal), then fast doubles:
    expect(cycleSamples(everyThenFast, 0, 4)).toEqual([1, 2, 1, 2]);
    expect(cycleSamples(everyThenFast, 1, 4)).toEqual([2, 1, 2, 1]);
  });

  it('the full spec chain locks: sequence → fast 2 → every 4 reverse → rotate 1', () => {
    const c = mustCompile(seq([1, 2, 3, 4]), [
      { type: 'fast', factor: 2 },
      { type: 'every', cycles: 4, transform: { type: 'reverse' } },
      { type: 'rotate', steps: 1 },
    ]);
    // cycle 0 → post-fast cycles 0/1: neither ≡3 (mod 4) → rotate only.
    expect(cycleSamples(c, 0, 8)).toEqual([4, 1, 2, 3, 4, 1, 2, 3]);
    // cycle 1 → post-fast cycles 2/3: second half hits every-4 → reverse+rotate.
    expect(cycleSamples(c, 1, 8)).toEqual([4, 1, 2, 3, 1, 4, 3, 2]);
  });
});

// ---------------------------------------------------------------------------
// Determinism / purity
// ---------------------------------------------------------------------------

describe('determinism', () => {
  const families: [string, CompiledPattern][] = [
    ['sequence', mustCompile(seq([0, 0.25, 1, 0.25]))],
    [
      'euclid',
      mustCompile({
        type: 'euclidean',
        pulses: 5,
        steps: 16,
        rotation: 3,
        activeValue: 1,
        inactiveValue: 0,
      }),
    ],
    [
      'fast+every+rotate',
      mustCompile(seq([1, 2, 3]), [
        { type: 'fast', factor: 2 },
        { type: 'every', cycles: 3, transform: { type: 'reverse' } },
        { type: 'rotate', steps: 2 },
      ]),
    ],
    ['slow', mustCompile(seq([1, 2, 3, 4]), [{ type: 'slow', factor: 4 }])],
  ];

  it('direct seek equals playback-through-time for every family', () => {
    for (const [, c] of families) {
      const target = { cycleIndex: 123, cyclePhase: 0.456 };
      const direct = evaluatePattern(c, target);
      for (let t = 0; t < 123.456; t += 0.789) {
        evaluatePattern(c, { cycleIndex: Math.floor(t), cyclePhase: t - Math.floor(t) });
      }
      expect(evaluatePattern(c, target)).toEqual(direct);
    }
  });

  it('repeated evaluation is exact-equal — no hidden cursor, no order dependence', () => {
    for (const [, c] of families) {
      const points = [
        { cycleIndex: 0, cyclePhase: 0 },
        { cycleIndex: -4, cyclePhase: 0.9 },
        { cycleIndex: 5_000_000, cyclePhase: 0.123 },
      ];
      const first = points.map((p) => evaluatePattern(c, p));
      const reversedOrder = [...points]
        .reverse()
        .map((p) => evaluatePattern(c, p))
        .reverse();
      expect(reversedOrder).toEqual(first);
    }
  });

  it('O(1) in elapsed time: huge cycle indices evaluate instantly and finitely', () => {
    const c = mustCompile(seq([1, 2, 3, 4]), [{ type: 'slow', factor: 7 }]);
    const r = evaluatePattern(c, { cycleIndex: 70_000_001, cyclePhase: 0.5 });
    expect(r.active).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('validation (compile-time, never hot-path throws)', () => {
  const bad: [PatternDefinition, PatternTransform[]][] = [
    [seq([]), []],
    [seq([NaN]), []],
    [seq([Infinity]), []],
    [{ type: 'constant', value: NaN }, []],
    [{ type: 'euclidean', pulses: 3, steps: 0, rotation: 0, activeValue: 1, inactiveValue: 0 }, []],
    [
      { type: 'euclidean', pulses: -1, steps: 8, rotation: 0, activeValue: 1, inactiveValue: 0 },
      [],
    ],
    [{ type: 'euclidean', pulses: 9, steps: 8, rotation: 0, activeValue: 1, inactiveValue: 0 }, []],
    [
      { type: 'euclidean', pulses: 3, steps: 8, rotation: 0.5, activeValue: 1, inactiveValue: 0 },
      [],
    ],
    [seq([1]), [{ type: 'fast', factor: 0 }]],
    [seq([1]), [{ type: 'fast', factor: -2 }]],
    [seq([1]), [{ type: 'slow', factor: 0 }]],
    [seq([1]), [{ type: 'rotate', steps: 1.5 }]],
    [seq([1]), [{ type: 'every', cycles: 0, transform: { type: 'reverse' } }]],
    [
      seq([1]),
      [
        {
          type: 'every',
          cycles: 4,
          transform: { type: 'every', cycles: 2, transform: { type: 'reverse' } } as never,
        },
      ],
    ],
  ];

  it('rejects every invalid definition with a readable error', () => {
    for (const [def, transforms] of bad) {
      const r = compilePattern(def, transforms);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(5);
    }
  });

  it('evaluator returns inactive (never throws, never NaN) on defensive-invalid positions', () => {
    const c = mustCompile(seq([1, 2]));
    expect(evaluatePattern(c, { cycleIndex: NaN, cyclePhase: 0 })).toEqual({ active: false });
    expect(evaluatePattern(c, { cycleIndex: 0, cyclePhase: Infinity })).toEqual({ active: false });
  });
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

describe('performance', () => {
  it('500 mixed compiled patterns × 1000 frames stays trivial', () => {
    const patterns: CompiledPattern[] = [];
    for (let i = 0; i < 500; i++) {
      const kind = i % 3;
      patterns.push(
        kind === 0
          ? mustCompile(seq([0, 0.25, 1, 0.25]), [{ type: 'fast', factor: 1 + (i % 4) }])
          : kind === 1
            ? mustCompile(
                {
                  type: 'euclidean',
                  pulses: 3 + (i % 5),
                  steps: 16,
                  rotation: i % 7,
                  activeValue: 1,
                  inactiveValue: 0,
                },
                [{ type: 'every', cycles: 4, transform: { type: 'reverse' } }],
              )
            : mustCompile(seq([1, 2, 3]), [
                { type: 'slow', factor: 2 },
                { type: 'rotate', steps: i % 3 },
              ]),
      );
    }
    let sink = 0;
    const t0 = performance.now();
    for (let frame = 0; frame < 1000; frame++) {
      const pos = { cycleIndex: frame, cyclePhase: (frame % 97) / 97 };
      for (const p of patterns) {
        const r = evaluatePattern(p, pos);
        if (r.active && typeof r.value === 'number') sink += r.value;
      }
    }
    const ms = performance.now() - t0;
    expect(sink).toBeGreaterThan(0);
    // 500k evaluations; generous CI bound — real budget check reported.
    expect(ms).toBeLessThan(500);
    console.log(
      `[bench] 500 patterns × 1000 frames = ${ms.toFixed(1)}ms total, ${(ms / 1000).toFixed(4)}ms/frame`,
    );
  });

  it('compile cost is one-time and small (Bjorklund never at frame rate)', () => {
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      mustCompile({
        type: 'euclidean',
        pulses: 7,
        steps: 32,
        rotation: i,
        activeValue: 1,
        inactiveValue: 0,
      });
    }
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(200);
  });
});

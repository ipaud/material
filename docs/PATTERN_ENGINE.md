# Pattern Engine

Native deterministic temporal patterns, conceptually inspired by TidalCycles'
one useful lesson: **temporal structure is a pure function of time**. MATERIAL
never "executes" a pattern — it asks _what value does this pattern have at
exactly this composition time?_ Same inputs → same output, for preview,
playback, seek, the Output replica, offline export and project reload.

Status: **P1 (PatternClock) + P2 (pure engine) shipped.** P3+ (probability,
modulation integration, persistence, mini-notation, UI) land in later phases.

## Architectural position

```
composition time (PlaybackController live · startSec + i/fps export)
    ↓
PatternClock            pure view — owns no time, no timer, no BPM
    ↓
Pattern Engine (P2+)    pure evaluation
    ↓
modulation system       existing amount/range/curve/clamp semantics
    ↓
resolved parameters → FrameState → editor pixels → Output replica pixels
```

The Output replica evaluates nothing (Phase 18B contract). Export uses the
same pure functions as preview (the export evaluator already shares
`beatGrid`/`evalSources`; patterns join that path in P4).

## PatternClock (P1)

`src/pattern/patternClock.ts` — `patternClockAt(timeSec, timing, beatsPerCycle?)`.

- **Derived, never authoritative.** Callers pass the composition time they
  already have. All math reduces to `beatGrid.beatsAt` — the same primitive
  behind beat modulation sources, trigger events and quantization, so pattern
  timing cannot drift from the rest of the instrument. No timers, no
  setInterval, no second BPM store (invariant G).
- **Timing input** is the project's resolved grid: `timeline.bpm` (manual or
  detected — whatever the authority resolved), `beatOffsetSec`, `beatsPerBar`.
- **Cycle**: `beatsPerCycle` defaults to 4 (one bar at 4/4) but is
  independently configurable per pattern; the clock never assumes
  cycle === bar.
- **No BPM → `null`** (product convention, option B): beat sources emit 0,
  deterministic triggers emit nothing, the monitor says SET BPM — patterns
  are inactive until a grid exists. No invented 120 BPM fallback.
- **Boundaries**: phases live in `[0,1)`; exact musical boundaries land on
  phase 0 of the _next_ index (epsilon-guarded against float error), so
  downstream step math can trust `floor(phase * length)`.
- **Pre-roll** (`t < beatOffsetSec`): indices go mathematically negative with
  valid phases. This deliberately diverges from the UI's `musicalPosition`
  clamp (BAR 1 readout): evaluation needs a stable, seek-safe index
  everywhere; a clamped plateau would make transforms and deterministic
  probability ambiguous.
- **Purity = seek safety** (invariants C/D): evaluating directly at
  `t = 123.456` is byte-identical to stepping there — tested.

## Pattern engine (P2)

`src/pattern/{patternTypes,euclidean,compilePattern,evaluatePattern}.ts`.

**Definitions** (serializable, persisted in P6): `constant`, `sequence`
(cycle divided evenly, STEP sampling), `euclidean` (pulses/steps/rotation +
active/inactive values). **CompiledPattern** (never persisted) unifies all
three into one `values[]` step array — Euclidean's Bjorklund mask and
rotation fold in at compile time, so nothing algorithmic runs per frame.

**Compilation** — `compilePattern(definition, transforms) → Result`. All
validation lives here (empty/NaN/∞ sequences, steps<1, pulses>steps,
non-integer rotation, factor≤0, cycles<1, nested EVERY). The evaluator only
ever sees valid compiled patterns and cannot throw on user input; defensive
invalid positions return `{active:false}` — NaN can never escape.

**Evaluation** — `evaluatePattern(compiled, {cycleIndex, cyclePhase})` →
`{active:true, value, stepIndex, cycleIndex} | {active:false}`. Pure, O(1)
in elapsed time, O(transforms) per call. Measured: **~176 ns/eval, zero
sustained allocation** (1M-eval probe) — 250 patterns at 120 Hz ≈
0.04 ms/frame.

### Coordinate model

- **Cycle-space transforms** act on the continuous absolute position
  `pos = cycleIndex + cyclePhase`: `fast f → pos·f`, `slow f → pos/f`
  (fractional factors welcome; `fast 0.5 ≡ slow 2`). Direct seek works by
  construction — there is no history anywhere.
- **Step-space transforms** compose into one affine index map
  `base = (A·i + B) mod N` in serialized order (`reverse: i → N-1-i`,
  `rotate s: i → i-s`, newest transform applied first — standard function
  composition). `rotate→reverse ≠ reverse→rotate`, test-locked.
- **EVERY** reads `floor(pos)` at its chain position and applies its single
  nested transform on cycles where `mod(cycle, n) === n-1` — "1 normal, 2
  normal, 3 normal, 4 transformed". True mathematical modulo extends the
  lattice into pre-roll: with n=4, cycles …,−5,−1,3,7,… are transformed.
  Because it reads the _current transformed_ coordinate, `fast→every ≠
every→fast` (also test-locked).

### Euclidean canonical orientation (locked)

First pulse on step 0, remainders front-loaded (classic Bjorklund pairing):
`E(3,8)=10010010`, `E(5,8)=10110110`, `E(5,16)=1001001001001000`. Any other
alignment is expressed via `rotation` (normalized true-modulo, so −1 ≡
steps−1 ≡ steps·k−1), never by the algorithm.

### Boundaries

Phases live in `[0,1)`. Exact boundaries arrive from PatternClock as phase 0
of the next cycle; float creep `>1−1e−9` inside the evaluator rolls forward
the same way, and step sampling clamps `floor(phase·N)` to `N−1`. Reverse at
phase 0 therefore yields the LAST step — never a stale phase-1.0.

## Determinism inputs reserved for P3

Project seed: `project.explore.lastSeed` already exists and is the stable
project-level seed (looks/candidates carry their own). Hash/PRNG:
`src/utils/prng.ts` (`mulberry32`, `deriveSeed`) is the sanctioned
deterministic source — `Math.random` remains banned from visual paths
(`freshSeed` is its only home). Pattern probability will derive
`deriveSeed(projectSeed ^ patternId, cycleIndex/stepIndex)`-style lanes.

## DevTools

`__dev.patternClock.at(timeSec?, beatsPerCycle?)` — inspects the clock at any
composition time (defaults to the live playhead) against the current
project's grid. Dev-only, read-only.

## Adding to this engine (future phases)

- A pattern type = a serializable definition + a pure
  `evaluate(compiled, clock, ctx)` branch. Compile once on change; never
  parse per frame.
- A transform = a pure phase/index mapping applied in serialized order.
- Anything that samples randomness goes through the deterministic
  hash — never `Math.random`, never stateful PRNG advanced per frame.

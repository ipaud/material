# Pattern Engine

Native deterministic temporal patterns, conceptually inspired by TidalCycles'
one useful lesson: **temporal structure is a pure function of time**. MATERIAL
never "executes" a pattern — it asks _what value does this pattern have at
exactly this composition time?_ Same inputs → same output, for preview,
playback, seek, the Output replica, offline export and project reload.

Status: **P1 (PatternClock) + P2 (pure engine) + P3 (deterministic
probability / Degrade) + P4 (modulation integration) + P5 (parity
hardening) + P6 (persistence contract) + P7 (mini-notation) shipped.**
P8 (BUILD UI) shipped. P9 (final QA) closes Pattern Engine v1.

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
same pure functions as preview — since P4 both call the same
`evalSources(timeSec, ctx)` with pattern handles in the context.

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

## Deterministic probability (P3)

`src/pattern/patternRandom.ts` — every probabilistic decision is a
**stateless hash of the event's identity**. There is no mutable PRNG stream
anywhere: no cursor to advance means evaluation order, direct seeks, reloads
and export renders all see the exact same sample for the same event.

### Sample key

```
projectSeed → patternIdHash → lane → zigzagLo(cycle) → zigzagHi(cycle) → step → salt
```

Each `→` is one `deriveSeed` step (bit-exact with `src/utils/prng.ts`,
re-expressed allocation-free as `mulberry32Once` — locked by test); the final
seed produces one mulberry32 output in `[0,1)`.

- **projectSeed** — `project.explore.lastSeed ?? 1`, supplied by the CALLER
  in `PatternEvaluationContext`; the pure engine never reads stores.
- **patternIdHash** — FNV-1a of the stable pattern id (`hashPatternId`,
  memoized). Same project seed + different id → independent lanes. Ids must
  be stable identities — never array index, render order or object identity
  (P4/P6 decide persistence).
- **lane** — semantic separation: `LANE_DEGRADE = 0`; `1`/`2` reserved for
  future CHOICE/HUMANIZE so adding a random feature never shifts Degrade.
- **cycle/step** — the **transformed event coordinate**: the final evaluated
  cycle and PRESENTED step, after fast/slow/every/rotate/reverse. Zigzag
  encoding keeps pre-roll (negative cycles) collision-free; deriving both
  32-bit words keeps identities distinct across the float-exact range
  (|cycle| < 2^52).
- **salt** — sub-index inside a lane (position of a degrade gate in a chain
  with several).

### Degrade

`{ type: 'degrade', probability }` (0..1, validated at compile — NaN/∞/out of
range rejected). It is a **post-value event gate**, deliberately outside the
coordinate transform chain: its semantics depend on final discrete event
identity, not coordinate mapping. Locked rule: `sample < probability` keeps
the event — `0` never active, `1` always active. A gated event returns the
same `{active:false}` P2 already defined; **`value:false` is an active
boolean event, never inactive** (test-locked).

Transformed-coordinate identity (all test-locked):

- `fast 2` → two independently degradable event cycles per source cycle.
- `slow 4` → ONE sample across the whole stretched event; no mid-event
  resample (frames inside a step share `cycle+step`, never phase or time).
- `reverse`/`rotate` → keyed on the step the listener actually perceives.
- `every 4 reverse + degrade .5` → direct seek ≡ playback-through.

### Events

`CompiledPattern.events` (`null` = every step): sequence/constant steps are
all events (value `0` is still a gateable event); Euclidean marks **pulses
only**, derived from the mask through the same rotation — never inferred from
values (`activeValue` may equal `inactiveValue`). Degrade gates events only:
Euclidean rests stay active with `inactiveValue` at any probability. The
active evaluation now carries `event: boolean` — the seam future trigger
integration reads.

### Golden compatibility warning

`tests/pattern-degrade.test.ts` locks exact samples (e.g. seed 12345,
`pattern-a`, lane 0, cycle 0, step 0 → `0.45305717131122947`). Once patterns
persist in projects (P6), these hashes are **project compatibility
semantics**: changing FNV-1a, the derivation chain or mulberry32 would
visually alter saved projects. Do not "fix" the numbers.

Measured: degrade adds ~37 ns/eval (same-run: 50 ns/eval for a
fast+every+reverse chain without degrade, 87 ns/eval with; 1M-eval probe,
heap delta negative — zero sustained allocation).

## Modulation integration (P4)

Pattern is **just another modulation source**. The full path:

```
project.patternSources (serialized definitions; additive defaulted field, no version bump)
    ↓ resolvePatternHandles()        compile-on-change cache (patternSourceRuntime)
SourceContext.patterns + projectSeed  ← built at the store boundary
    ↓ evalSources(timeSec, ctx)      ONE evaluation per authority pass
values['pattern:<id>'] ∈ [0,1] — or ABSENT when the pattern is inactive
    ↓ applyModulations()             existing mapping/amount/range/clamp/stacking
final params → FrameState → Editor pixels → passive Output replica
```

- **Source taxonomy**: mappings reference `pattern:<id>` — a plain source id
  string, like `bass` or `beat:bar`. Amount/range/curve/invert/smoothing/
  freeze all belong to the mapping, never to the pattern.
- **True neutral**: an inactive pattern (degrade-gated, boolean value, compile
  error, no BPM) emits NO key; `applyModulations` skips a mapping whose
  source produced no value this frame (unless FROZEN — a frozen mapping holds
  its captured value regardless). Skipping means invert/curve/min cannot
  manufacture a contribution from silence — the base parameter is untouched.
- **Timing**: `SourceContext` is structurally a `PatternTiming` — patterns
  read the same resolved bpm/beatOffset/beatsPerBar as beat sources and can
  never drift. No BPM → `patternClockAt` returns null → neutral (no 120
  fallback). `beatsPerCycle` lives on the pattern source (default 4),
  independent from `beatsPerBar`.
- **Identity**: `PatternSource.id` (uid('pat'), standard entity convention)
  is both the mapping source key and the deterministic probability lane;
  `projectSeed = project.explore.lastSeed ?? 1` is supplied by the caller at
  the store boundary (engineBridge / export evaluator) — the pure engine
  still reads no stores. The export evaluator mirrors mid-export seed changes
  from replayed look applies for exact preview parity.
- **Compile cache** (`patternSourceRuntime.ts`): keyed by pattern id,
  validated by `JSON.stringify({pattern, transforms})` content identity.
  `beatsPerCycle`/`enabled`/seed changes never recompile; removed, disabled
  or replaced sources are pruned at configure time — no stale compiled
  pattern survives a project switch. Compile failure → handle carries the
  error, source stays neutral, nothing throws in the render loop, NaN cannot
  reach params.
- **Numeric-only in P4**: pattern values are clamped to [0,1] as source
  convention; boolean-valued steps stay engine-internal (visible in
  diagnostics) and contribute nothing. Discrete/boolean targets are a later
  phase; booleans are NOT implicitly 0/1.
- **No renderer path**: `src/pattern` imports no rendering/three/output code
  and the Output replica imports no pattern code (both test-locked). FrameState
  gained no fields — patterns are visible only as final param values.
- **Trigger firing deferred**: the P3 `event` seam is preserved in
  diagnostics; wiring events into TriggerScheduler's interval API needs
  inverse coordinate mapping (transformed event times in (t0,t1]) and is
  deliberately not part of P4.

Measured (full `evalSources`+`applyModulations`, mosaic): 0 patterns
0.0007 ms/frame · 10 → 0.005 · 100 → 0.021 · 250 → **0.052 ms/frame**.
Final-params payload bytes identical with/without pattern modulation.

## Parity guarantees (P5)

`PREVIEW === OUTPUT === EXPORT` is enforced by construction and locked by
tests that drive the production seams (`modulationRuntime.transform` and
`createFrameEvaluator`), not a parallel harness:

- **One interpretation of time.** Both paths call the same
  `evalSources(timeSec, ctx)`; patterns read the same resolved grid as beat
  sources. Export frame *i* is `startSec + i/fps` in GLOBAL composition
  time — a 22s→28s range evaluates its frame 0 at 22s, and an unaligned
  start (17.381s) resolves like any other instant.
- **Frame-rate independence.** 24/25/30/60 fps agree at matching timestamps;
  nothing in the pattern path reads a frame number.
- **Seek/loop.** Direct seek, backward seek and 100-cycle jumps equal
  playback-through, because evaluation has no history. Loop wrap resolves
  from absolute time — nothing survives the discontinuity.
- **Output.** The replica evaluates nothing: `runtimeBus.emitFrame` publishes
  exactly the params `transform()` returned, so live parity IS Output
  parity. Verified live: `JSON.stringify(finalParams)` byte-identical on both
  sides, including float tails.
- **Freeze** is serialized project state (`mapping.frozenValue`), so export
  replays it; releasing resumes at absolute time, never where it froze.
- **Morph** interpolates mappings (amount included) — pattern contribution
  rides the interpolated mapping and the evaluated technique's parameter
  filter, so a mosaic-only pattern target is dropped on slit-scan frames and
  returns when mosaic is evaluated again.
- **Candidate** overlays params/mappings/technique; pattern SOURCES live in
  project state (outside LookCore), so they keep being evaluated by the one
  authority while the overlay decides which mappings are valid.
- **Diagnostics never affect determinism** and never reach FrameState.

Live measurements (3 patterns, 78.03 BPM, Output open): editor 120 fps,
authority→replica transit 0–1 ms (same class as any other param — patterns
add no latency), FrameState 201 bytes. Hostile case (100 patterns, mixed
Euclidean/Sequence, fast+degrade, slit-scan temporal, Output open): editor
119 fps, one authority evaluation pass 0.0168 ms, FrameState 253 bytes,
100 compiles total (one per definition), zero page errors.

### Cache architecture (audited in P5)

`resolvePatternHandles` runs at CONFIGURE time only — `evalSources` never
compiles and never serializes. Content fingerprints are memoized in a
`WeakMap` keyed by the `PatternSource` OBJECT: the store is immutable, so an
unchanged source keeps its identity and is serialized exactly once, while an
edit produces a new object → one fingerprint → one compile. Verified live:
40 unrelated project edits → 0 extra compiles; 5000 evaluation passes → 0
fingerprints, 0 compiles. Live and export share the cache safely because
`CompiledPattern` is immutable and evaluation is pure; an export evaluator
keeps the handle array it resolved at construction, so later live edits
cannot mutate a running export.

## Persistence contract (P6)

Patterns persist as `project.patternSources[]` — an **additive v2 field**,
no schema bump (the `macros` / `performancePads` precedent; the next real
break belongs to Live Sources). Full field reference in
[PROJECT_FORMAT](PROJECT_FORMAT.md); the ownership decision and its
rationale are recorded in [DECISIONS](DECISIONS.md).

**Pattern ids and hash semantics are project compatibility.** An id feeds
`patternRandom01`, so it must survive save, reload, undo, redo, reorder and
Save As untouched — and duplicates are refused at parse/write time rather
than renamed, because renaming would change what a saved project renders.
`tests/fixtures/project-v2-pattern.json` plus its locked evaluated values
guard this: any future change to the PRNG, the clock, transform order or id
semantics breaks that test instead of a user's composition.

Semantics worth knowing:

- **Looks capture mappings, not patterns.** One `E(5,16)` can drive Scale in
  look A and Feedback in look B; both observe the same signal at the same
  time. Editing the pattern changes every mapping referencing it — shared
  resource semantics, never a silent per-look fork.
- **Editing preserves identity, duplicating does not.** `updatePatternSource`
  keeps the id, so the probability lane survives an edit (though changing
  step structure naturally changes step keys). `duplicatePatternSource`
  assigns a NEW id, so a duplicated Degrade pattern makes its own
  independent decisions — that is the point of duplicating it. Duplicates do
  not clone mappings.
- **Removal is atomic.** Removing a source removes the mappings that
  referenced it in one `store.apply`, so one undo restores the source, the
  mappings and the exact random decisions. Parsing never does this cleanup:
  a hand-edited file with orphan mappings still opens, and those mappings
  resolve neutral.
- **Seed.** Probability follows the currently evaluated project seed
  (`explore.lastSeed ?? 1`). Changing the Explore seed intentionally changes
  probabilistic outcomes; a look apply that carries its own seed changes
  them deterministically too. No `patternSeed` exists.

Save/load cost stays linear: 250 sources = 93.9 KB JSON, 1.8 ms serialize,
1.5 ms parse, 1.2 ms first-evaluation compile of all 250, 0.057 ms/frame
steady state.

## Mini-notation (P7)

`src/pattern/miniNotation.ts` — a text INPUT layer for Sequence patterns:

```
editor text → parsePattern → PatternDefinition → compilePattern → evaluation
```

**Raw text is never persisted.** The structured definition stays the single
source of truth; opening an editor formats it back to canonical text. That
keeps one truth in the file, keeps projects diffable, and means a future
grammar change cannot invalidate saved work.

### Grammar (closed on purpose)

```
sequence := number ( whitespace number )*
number   := '-'? ( digits ( '.' digits? )? | '.' digits )
```

Accepted: `0` · `1` · `-1` · `12` · `0.5` · `.25` · `-.25` · `12.` ·
`-12.75` · `00.50`. Any whitespace run separates steps (space, tab,
newline); leading and trailing whitespace is ignored.

Rejected — locked by test: empty/whitespace-only input, `.` `-` `+` `+1`
`-.` `1..2` `--1` `+-1`, `NaN`, `Infinity`, exponent notation (`1e3`,
`1E-2`), hex (`0x10`), comma decimals (`0,25` — the parser is
locale-independent by construction), and everything code- or
Tidal-shaped: `[]` `<1 2>` `0*2` `5/16` `fast 2` `${1+1}` `alert(1)`
`__proto__`. Parsing is an explicit character scanner: **no `eval`, no
`new Function`**, no regex backtracking, no dynamic evaluation of any kind.

Euclidean (`5/16`) and transforms (`fast 2`, `degrade .5`) deliberately
have NO text syntax — they already have structured models and get real
controls in P8. Keeping them out of the text box is what stops a tiny
grammar from becoming a language. Booleans have no text form either;
`canFormatSequence` reports when a definition (booleans, or values large
enough to need exponent notation) cannot be edited as text, so P8 can fall
back to read-only instead of lying.

### Errors

`{ message, index, length, token }` — e.g. `Unexpected token "nope" at
position 5`, with offsets that slice exactly the offending token so P8 can
underline it. Syntax belongs to the parser; semantic validity still belongs
to `compilePattern` (no duplicated rule set).

### Formatter

`String(n)` shortest round-trip decimals with a conventional leading zero:
`.25` in → `0.25` out, `-.25` → `-0.25`, `2.0` → `2`, `12.500` → `12.5`,
`-0` → `0` (negative zero is normalized at parse, not treated as creative
meaning). `parse(format(d))` returns the exact same values for every
formattable definition — test-locked. `format(parse(text))` is canonical,
not the user's original whitespace, because the text was never the truth.

### Live-edit semantics (locked for P8)

While a draft is invalid, the runtime keeps the LAST VALID pattern —
visuals must not blink out because someone typed `0 .5 1 .` on the way to
`0 .5 1 .25`. Concretely:

- `updatePatternDraft` returns `{ text, lastValid, error, changed }`; only
  `changed: true` is worth committing.
- `updatePatternSourceFromText(id, text)` commits ONLY on a successful
  parse: invalid text produces no project update, no history entry and no
  dirty flag, so undo history holds creative changes rather than parser
  garbage. P8 owns debouncing and keystroke grouping.
- A commit replaces the `pattern` field ONLY. The id survives — and with it
  the deterministic probability lane — along with transforms,
  `beatsPerCycle`, `enabled` and every mapping referencing `pattern:<id>`.
  Changing step COUNT naturally changes step keys, so Degrade decisions
  shift deterministically; that is correct, not a regression.
- Export only ever sees committed structured definitions. There is no
  parser anywhere in the export or Output path.

Parsing runs on edit, never per frame: linear, ~107 ns per step (1 step
0.18 µs, 64 steps 6.8 µs, 1024 steps 110 µs; formatting is about half
that), and 10 000 evaluation passes invoke it zero times.

## BUILD editor (P8)

`src/patterns/` — the pattern editor lives in **BUILD → Inspector →
SIGNALS**, beside modulation, triggers, macros and MIDI. There is no fifth
workspace and no pattern controls in PERFORM, EXPLORE or OUTPUT: a pattern
is a signal source, mapped onto parameters through the existing modulation
system like any other.

```
PATTERNS                                   + ADD
● PAT 01   SEQ · 4 steps                   LIVE
● PAT 02   EUCLID · 5/16 · 3T              LIVE
    TYPE [Euclidean]  CYCLE [4] beats        1 TARGET
    EUCLIDEAN                                 5 of 16
    PULSES [5]  STEPS [16]  ROTATE [0]
    ● · · ● · · ● · · ● · · ● · · ·
    STEP 14 / 16   0.00
    TRANSFORMS                        applied in order
    01 FAST         FACTOR [2] ×        ↑ ↓ ✕
    02 EVERY        CYCLES [4] → [Reverse]
    03 PROBABILITY  CHANCE [63] %       ↑ ↓ ✕
    [+ Add transform]
    DUPLICATE   DELETE
```

- **Labels are positional** (`PAT 01`); the stable id never appears in the
  UI — it is creative identity, not something to read or type. Mapping rows
  show `PAT 01`, never `pattern:pat_9f31c2ab`.
- **Status is text**, never colour alone: LIVE · DISABLED · INVALID ·
  NO BPM · UNMAPPED.
- **Transforms are an ordered list, not a set of toggles.** Positions are
  numbered and reordering is explicit (↑ ↓), because P2 locked
  `fast → reverse ≠ reverse → fast`. Nothing sorts them, ever. `degrade` is
  presented as PROBABILITY in percent and stored as 0–1.
- **Sequence editing** uses the P7 contract: an invalid draft stays on
  screen with `Invalid · last valid active` while the committed pattern
  keeps running; valid text commits ~320 ms after typing settles, and is
  flushed on blur, Enter and unmount so a workspace switch cannot lose an
  edit. Escape restores the committed text. A sequence with no text form
  (booleans) is shown read-only rather than mangled.
- **The step indicator writes to DOM refs on a 20 Hz timer** — the engine
  still evaluates at full rate, but React commits nothing and the project
  store is never touched. Measured while playing: 0 DOM mutations/s with the
  editor closed, 20/s with a sequence open, 38/s with a running Euclidean —
  against 120 fps of rendering, and **0 store writes**.
- **The System Path collapses patterns to one `PATTERN` segment**; listing
  PAT 01 / PAT 02 / PAT 03 would drown the path in instances of one idea.

## DevTools

`__dev.patternEngine` — `compilePattern` / `evaluatePattern` /
`patternRandom01` (pure, read-only) plus `sources()` (last-evaluated state of
each live pattern source: compiled/error/cycle/active/event/value) and
`compileCount()` (cache effectiveness), plus `parse(text)` / `format(def)`
for the P7 mini-notation (read-only, no project mutation). `__dev.patternClock.at(timeSec?, beatsPerCycle?)` — inspects the clock at any
composition time (defaults to the live playhead) against the current
project's grid. Dev-only, read-only.

## Adding to this engine (future phases)

- A pattern type = a serializable definition + a pure
  `evaluate(compiled, clock, ctx)` branch. Compile once on change; never
  parse per frame.
- A transform = a pure phase/index mapping applied in serialized order.
- Anything that samples randomness goes through the deterministic
  hash — never `Math.random`, never stateful PRNG advanced per frame.

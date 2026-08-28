# Pattern Engine

Native deterministic temporal patterns, conceptually inspired by TidalCycles'
one useful lesson: **temporal structure is a pure function of time**. MATERIAL
never "executes" a pattern — it asks _what value does this pattern have at
exactly this composition time?_ Same inputs → same output, for preview,
playback, seek, the Output replica, offline export and project reload.

Status: **P1 (PatternClock) shipped.** P2+ (pattern types, transforms,
probability, modulation integration, persistence, mini-notation, UI) land in
later phases; this document grows with them.

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

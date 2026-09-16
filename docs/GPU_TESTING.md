# GPU Numeric Testing (CE1D-2 methodology)

The standard for verifying numeric GPU state in MATERIAL (optical flow
today; Reaction Diffusion, Cellular Automata and Motion Signals tomorrow).

## The contract

Never read float render targets raw and never trust a measurement the
harness has not proven it can make:

```
float GPU state
   ↓  GPU ENCODE pass (documented scale, signed→0..255, saturation visible)
RGBA8 diagnostic target        (UnsignedByte, NoColorSpace — data-safe)
   ↓  typed Uint8Array readback (validated: type, glGetError — throw loud)
numeric assertions
```

## Self-test FIRST (mandatory)

Before any conclusion about the state under test, the probe must pass:
- constants: −MAX→0, 0→128, +MAX→255 on each axis;
- a gradient;
- an orientation marker (top-left dot → high `yFromBottom` rows: GL
  readback is bottom-row-first).
If the self-test fails, STOP — every downstream number is meaningless.
`FlowProbe.selfTest()` in `src/rendering/flow/flowDiagnostics.ts` is the
reference implementation.

## Clean-process rule

Golden evidence only from a freshly started app. Editing ANY source while
the dev app runs invalidates the session (HMR splits module graphs and
poisons singletons). Cycle: stop → edit → build/start → measure → stop.

## The traps this methodology exists for (all measured in CE1D)

1. **`renderer.setViewport` multiplies by pixelRatio — always.** After
   `setRenderTarget(rt)` Three already applies the RT's full viewport
   WITHOUT ratio; a manual `setViewport(0,0,w,h)` on a ratio-2 canvas
   paints only the lower-left quadrant. Symptom: fragments that consume
   `vUv` read zeros at sample points; constant shaders look fine.
2. **`readRenderTargetPixels` returns silent zeros** on buffer/type
   mismatch (Float32Array from an RGBA8 target, Uint8 from a float
   target). Always match types and check `gl.getError()`.
3. **Dynamic `import()` in dev can load a second module graph** (second
   `three`): objects from one copy rendered by the other fail silently.
   Dev harness entry points use static imports.
4. **Lossless H.264 (`-qp 0`) decodes to BLACK silently** in this
   Chromium. Core goldens use shader-generated synthetic frames — no
   decoder in the truth path (`SyntheticMotionSource`).
5. `dot` is a GLSL built-in — never a variable name.

## Flow goldens (reference numbers, M-series, 320-grid)

Self-test PASS. Units: ‰ uv/frame; ENCODE_MAX = 30‰; truth for a 2-px
shift at 320 = 6.25‰.

| Case | meanX | meanY | bg mag |
|---|---|---|---|
| STATIC | 0.12 | 0.12 | 0.166 (≈ encoder half-LSB) |
| RIGHT2 | +6.45 | 0.00 | 0.166 |
| LEFT2 | −6.49 | 0.00 | 0.166 |
| UP2 | −0.00 | +5.34 | 0.166 |
| DOWN2 | 0.00 | −5.38 | 0.166 |
| DIAG2 | +6.65 | −5.85 | 0.166 |

Velocity accuracy ±3% at 2px. Useful range 1–4 grid-px (8px incoherent,
16px dead — mono-scale LK limit, documented). Resolution sweep: 320
optimal (256: +12% bias; 512: −32%, weaker signal). UP = +Y (UV-up).

## CE1H additions

Two more instruments, both built to answer a question that reading the code
could not.

### `temporalPathCompare(T, fps, from)`

Builds the same composition time two ways — priming directly at `T` (what a
subrange export does) versus priming earlier and advancing to `T` (what a full
export does) — then compares the atlas **by logical slot**, so physical
placement differences do not register as content differences.

This is what closed the CE1C debt. It reported the two atlases identical, with
the same anchor, spacing and filled count, which ruled out the schedule and
the decoder in one measurement and left `head` as the only difference. The
bug was bilinear taps bleeding across atlas tile borders, whose neighbours
change when placement rotates.

### `temporalExportProbe(T, fps, from)`

Replicates the export loop for one frame both ways and hashes each stage:
atlas, head, filled, anchor and the rendered frame. It reports `atlasSame`
alongside `frameSame`, which is exactly the pair needed to separate "wrong
history" from "right history, wrong sampling".

### Lessons that generalise

- **A comparison metric can hide the bug it is meant to find.** Comparing raw
  atlas bytes said "2 million pixels differ" (true, and meaningless — the
  atlas is a rotating buffer). Comparing by logical slot said "identical".
  Same data, opposite conclusions; only one of them was the right question.
- **Determinism is not correctness.** Optical flow was never computed during
  export, and every determinism gate passed, because a constant flow field is
  perfectly reproducible. The preset contact sheet caught it by rendering four
  different Motion presets to byte-identical tiles. When a gate can be
  satisfied by a system doing nothing, it needs a companion that fails when
  nothing happens.

## v0.4A — the reduction ladder

### `statsGoldens()`

Seven fixtures through the real product path, from a clean process. Every one
reports `n` alongside its value, because `n` is the assertion that cannot be
faked:

| fixture | n | expected | measured |
| --- | --- | --- | --- |
| constant 0.25 | 57 600 | 0.25 | 0.25098 (fixture is RGBA8: 64/255) |
| ramp `vUv.x` | 57 600 | 0.5 | **0.500000** |
| odd half/half 317×179 | **56 743** | 159/317 | **0.501577** |
| flow right | 57 600 | x = 1 | **1.000000**, amount 3.2 |
| flow left | 57 600 | x = 0 | **0.000000**, amount 3.2 |
| flow vertical | 57 600 | x = 0.5 | **0.500000**, amount 3.2 |
| flow still | 57 600 | x = 0.5, amount 0 | **0.500000**, 0 |

`amount = 3.2` is exactly `0.01 uv × 320` texels. Vertical motion reading dead
centre is correct and worth having as a fixture: vertical displacement has no
horizontal dominance. `gateRerunsOnce` proves the frame-key cache does not
re-reduce the same frame, and `deterministic` proves a repeat is bit-identical.

### Doctrine deviation, recorded on purpose

The product path reads `FloatType` straight into a `Float32Array`. The
"encode to RGBA8 first" rule in this document exists for **signed,
unknown-scale diagnostics**; a ladder sum reaching 57 600 cannot survive 8
bits. `EXT_color_buffer_float` is already a hard dependency of the flow field,
so RGBA32F is renderable and readable here. The diagnostic probes still follow
the doctrine.

### Mutation policy for signal work

Every visual signal ships with a companion test that **fails when the analysis
becomes a constant**. This is not optional style; it is the direct lesson of
optical flow never being computed during export while all twelve determinism
gates passed. Determinism is cheap for a dead system.

The three companions:

- reduction: replacing the ladder with a constant fails the black/white and
  ramp fixtures, and fails `n == gridWidth·gridHeight` on odd dimensions;
- direction: `abs()` on the signed channel fails the left/right pair, which a
  magnitude-only test would pass;
- export: **disabling the analyser must change the exported frames.** Measured
  12/12 frames differ for each of the three signals. This is the only gate that
  can catch a signal that is present, deterministic and doing nothing.

### Three defects that only live pixels found

All three passed the entire unit suite. They are listed here because each one
describes a *class* of test that unit tests structurally cannot perform.

1. **The analysis call was in a code path that almost never runs.** It sat in
   the transition-snapshot capture instead of the frame loop. Demand set,
   texture present, grid valid, zero reductions in 2.5 s.
2. **A clock that never advances.** Calibration was stepped by transport time,
   so with the transport stopped `dt` was 0 forever and every signal stayed
   `warming`. Any state machine fed a clock needs a test where that clock is
   parked.
3. **A priming frame published as a measurement.** The flow field clears its
   targets on the first update after a prime — by design, so no garbage field
   exists. That legitimate zero, published, seeded the motion calibrator's low
   envelope with an extreme the source never produces.

The general rule: **a subsystem that is correct in isolation can still be
wired to a path that never executes, a clock that never ticks, or a neighbour's
initialisation transient.** Only a live run finds those.

## v0.4B — MRT: three planes, one readback

Six added signals needed six more sums than four channels hold. The ladder
became multiple-render-target: one to three RGBA32F attachments carried through
every level together, chosen by demand.

```
plane 0   R = L        G = L²      B = |∇L|    A = 1
plane 1   R = |f|      G = f.x     B = f.y     A = moving ? 1 : 0
plane 2   R = u·|f|    G = v·|f|   B = —       A = —
```

A second ladder would have been simpler to write and would have cost a second
**readback**, and the readback stall is what this subsystem actually pays for.
One extra pass stacks the three final tiles into a single target so the CPU
still pays for exactly one GPU sync.

three rewrites every `ShaderMaterial` to `#version 300 es` regardless, and with
`glslVersion: GLSL3` it stops declaring `pc_fragColor` — so these shaders keep
the repo's ESSL1 idiom (`varying`, `texture2D`) while declaring their own
`layout(location = N) out`.

### Added goldens

| fixture | asserts | measured |
|---|---|---|
| flat 0.5 | contrast and edge are 0 at any brightness | 0.000000, 0.000000 |
| split 50/50 | contrast is the theoretical max | **0.500000** |
| ramp | contrast is 1/√12 | **0.288670** |
| 16 stripes | same contrast as split, far more edge | 0.5, edge **0.096875** vs **0.003125** |
| 16-cycle sine | edge matches the square of equal amplitude | 0.097941 |
| same sine, ¼ swing | edge scales with amplitude | **0.024583** |
| flow up / down | motion.y is 1 / 0 | **1.000000** / **0.000000** |
| quarter-frame patch | activity is the AREA | **0.250000** |
| patch left / right | centroidX | **0.125** / **0.875** |
| patch top / bottom | centroidY, 0 = top | **0.125** / **0.875** |
| still | centroid INVALID, activity 0 | invalid, 0 |

`centroidTop` is the fixture that pins the vertical convention. Nothing else in
the codebase records that `centroidY = 0` means the top of the image, and a
positional signal with an unpinned axis is a coin flip.

### A fixture that records a NON-difference

A full-range ramp and a single hard edge read the **same** edge energy, because
edge energy is total variation per texel and both traverse the range exactly
once. That is correct, and it is committed as a fixture so that nobody "fixes"
it later. Contrast is what separates those two — by a factor of nearly two.

The corollary caught a wrong test of my own: a full-amplitude sine is not
"blurred" relative to a square wave of the same period. Blur removes
*amplitude*, and that is what shows up in edge energy.

## v0.4 lessons that generalise

Four defects reached working code, and every one of them was invisible to unit
tests that all passed:

- **A subsystem can be wired to a path that never runs.** The analysis call sat
  in the transition-snapshot capture: demand set, texture present, grid valid,
  zero reductions in 2.5 s of preview.
- **A subsystem can be fed a clock that never ticks.** Calibration was stepped
  by transport time, so a stopped transport pinned `dt` at 0 and every signal
  stayed `warming` forever.
- **A neighbour's initialisation transient can look like data.** The flow
  field's priming update clears its targets by design; that zero, published,
  seeded the motion calibrator's low envelope. Then the frame after it turned
  out to be just as bad: the first real solve straddles the discontinuity, and
  at a source switch it measured **9.435** texels/frame against a steady-state
  median of **0.363**.
- **One NaN can become permanent state.** A non-finite `dt` was stored in a
  mapping's smoothing state, and every later step read it back as `prev`. The
  parameter sat at NaN for the rest of the session while the mapping still
  looked enabled.

The shared shape: **correct in isolation, wrong in composition**. A unit test
proves a function; only a live run proves it is called, called with a moving
clock, called with data rather than with a neighbour's startup, and able to
recover from one bad value.

## v0.5 — the shader host

External GLSL is the first content in MATERIAL that the app did not write, so
the harness has to prove more than usual: not only that the numbers are right,
but that a shader which is wrong cannot take anything down with it.

### `shaderGoldens()`

| gate | asserts | measured |
|---|---|---|
| **identity** | the host reproduces its own input exactly | **maxDiff 0** |
| invert | the source is real, not a blank texture | exact complement |
| **uv** | `vUv` is 0..1 with (0,0) bottom-left | corners (2,2) and (253,253) |
| time | deterministic AND advancing | repeat bit-identical, differs across t |
| seed | deterministic | bit-identical |
| param | a declared parameter reaches its uniform | 0 → 0, 1 → 255 |
| resolution | the real size, not a hardcoded one | 32 → 16, 64 → 32 |
| **compile error** | caught, readable, author's line | `line 2: 'nope' : undeclared identifier` |
| **last-known-good** | a broken edit keeps the previous frame | ok → error, material retained |
| **no recompile** | a slider move is a uniform write | 20 moves, programs 1 → 1 |

Identity first, as always: nothing measured through the host means anything
until the host can reproduce what it was given.

### Anti-noop policy for hosted content

A shader that ignores its inputs is perfectly deterministic, so the export gates
alone would pass for a black rectangle. Every one has a companion:

- **identity ignoring the source** fails the identity/invert pair;
- **time ignored** fails "24/24 distinct frames" on a time-driven shader;
- **a parameter ignored** fails the export run with that parameter at the other
  end of its range (12/12 frames must differ);
- **the shader bypassed entirely** fails against the same scene under a native
  technique (12/12);
- **the ISF adapter dropping TIME or the input image** fails the ISF export
  matrix identically.

### Line numbers, and the trap in mapping them

The first implementation subtracted the prelude length from every reported line.
That worked until the ISF adapter added a prelude of its own, at which point
every error pointed into the wrong file.

The fix is to stop doing arithmetic: the host prelude ends with `#line 1`, so
the driver numbers the author's file from 1, and any adapter that prepends its
own prelude resets it again. Offsets that have to be maintained by hand are a
class of bug, not a technique.

### A static check that matched across newlines

The reserved-identifier check searched the whole source with `\b(uniform|in|out|
varying)\s[^;]*\bNAME\b`. `[^;]*` happily spans newlines, so any later mention
of a host name matched — and the ISF prelude, which is nothing but legal
`#define RENDERSIZE uMaterial_resolution` lines, reported four redeclarations at
once.

Line-anchor checks that are conceptually per-line. The regression test asserts
both directions: a `#define` mentioning a host name is fine, an actual
redeclaration is still caught.

## v0.6.1 — comparing against a real previous release

The reference for a behaviour-preserving change is a **git worktree of the
released tag**, running as a second app, not the candidate's own prior
behaviour.

```bash
git worktree add /tmp/ref060 v0.6.0
ln -s "$PWD/node_modules" /tmp/ref060/node_modules
( cd /tmp/ref060 && env -u ELECTRON_RUN_AS_NODE npm run dev )
```

Both sides are driven by the **same fixture text** (`fixtures.mjs`), so a
difference cannot come from how the two were set up.

### Every fixture declares a content floor

```js
'two-routed': { minNonBlack: 20000, minVariance: 100, ... }
```

The comparison reports `IDENTICAL` only when the hashes match **and** both
sides clear the floor. Two blank frames agreeing is two failures, not a match
— which is exactly how a v0.6 identity gate passed while nothing rendered.

### Why self-referential baselines fail

v0.6.1's own extraction introduced a bug where the export prerolls received
`undefined` parameters. Repeat determinism stayed 12/12 and every existing
test passed, because both runs were wrong in the same way. Only the v0.6.0
comparison moved: full-vs-subrange fell to 4/12 for feedback and 0/12 for
motion.

A baseline that is a copy of the thing under test can validate black against
black. It can also validate wrong against wrong.

### The three permanent gate families

| Gate | Asks | Fails when |
|---|---|---|
| **Content floor** | is there a picture at all? | the system is dormant |
| **Time liveness** | does `t1 != t2` change the frame? | a clock is frozen |
| **Anti-noop** | does disabling this change the pixels? | the feature is inert |

Determinism belongs alongside all three, never instead of them.

### The fixture has to be deterministic before the comparison means anything

v0.6.1's four-layer fixture disagreed across builds. It also disagreed
**with itself**: two captures from two sessions of the *same* v0.6.0 build
produced different hashes. The comparison was measuring session history, not
code.

Two causes, found in order, and both worth knowing:

1. **Stateful techniques accumulate on a wall clock during preview.** A
   feedback surface or a reaction-diffusion simulation carries whatever the
   app did before the capture into the first exported frame. The fixture now
   resets every layer's feedback, temporal and flow state before capturing.

2. **The reset itself has to exist on both sides.** The first fix called
   `resetFeedbackEverywhere()`, which is a v0.6.1 method; the reference fell
   back to the host's `resetFeedback()`, which is a no-op there because a host
   has no technique. So a *clean* candidate was being compared against a
   *warm* reference, and the four-layer fixture kept differing by about 0.4 in
   mean. Resetting per layer — `branchFor(id).resetFeedback()` — is the only
   spelling both builds understand.

Sequence to trust a result:

```
capture reference twice  → must be IDENTICAL to itself
capture candidate twice  → must be IDENTICAL to itself
then compare the two
```

Skipping the first two steps produces a difference report that says nothing
about the code. It cost most of an afternoon here.


## v0.7 — Performance Capture gates

`DETERMINISM != CORRECTNESS` applies with full force here, because a Take is
exactly the kind of system that can be perfectly reproducible while doing
nothing at all.

| Gate | The mutation it must fail against |
|---|---|
| **Anti-noop** | Deselect the Take. The export must differ. |
| **Time-liveness** | Freeze the Take's clock. An early frame must stop equalling a late one. |
| **Event-liveness** | Remove one discrete event. The render must change. |
| **Seek-equals-walk** | Reconstruct at time t, and walk frame by frame to t. The dispatched sequences must be identical. |
| **Cross-FPS** | Evaluate at the same composition time under 24/25/30/60. Values must match to nine decimals. |
| **Repeat** | Twelve runs of one range, byte-identical. |
| **Full vs subrange** | Every matching global frame identical, morphs included. |

The seek-equals-walk gate earned its place immediately: it caught an event at
relative t = 0 being crossed by no interval, so it fired on a seek and never
during live playback. Nothing else compared the two paths against each other.

**Cross-FPS has a trap.** A 25 fps render has no frame at 2.5 s. Comparing
"the last frame before 2.5 s" across rates compares different instants and
fails for a reason that is not a bug. Name times every rate can land on.

**A live probe needs a duration.** A generator-only project has no media, so
`playback.getDuration()` is 0 and every `seek()` clamps to zero — while the
internal composition clock happily runs past it during playback. A seek test
against such a project silently becomes five requests for t = 0. Set a duration
on the playback store first.

**The `__dev` bridge goes stale across HMR.** `main.tsx` captures module
references once at load. Edit a module Vite then hot-replaces, and
`window.__dev.<thing>` still points at the version from before the edit — so a
probe exercises old code while the app runs new code, and the result looks like
a product bug.

Measured: a Take recorded through the bridge came out with no `lookCore`
baseline minutes after the fix that adds one was committed and the suite was
green. Relaunching the dev app produced it correctly.

**After editing anything a probe reaches through `__dev`, relaunch the dev app
before believing the probe.**

It is worse than stale reads. Vite full-reloads the page for a non-component
module, which resets the store — so editing source while the app holds live
state DESTROYS that state. A 76-second recorded performance was lost this way,
mid-session, and the loss was silent: the next probe simply read a different
project. **Save the project to disk before touching source, or do not touch
source while holding anything you would mind losing.**


## Differencing preview against export

Three morph faults shipped across v0.3–v0.8 with a full green suite, because
each side was self-consistent and nothing compared them to each other. Neither
had a failing test; the divergence only existed *between* them.

**The method.** Sample the live resolved parameter at ~25 Hz while the
transport plays, run the real `createFrameEvaluator` over the same composition
span, then match each export frame to the nearest live sample within 25 ms and
take the worst absolute difference.

```
worst |export − live|   before      after
  finished morph replaced    7.0      0.13
  interrupted morph          7.0      0.06
  manual interruption   3.6 (snap)   0.002
```

**Read the residual.** A non-zero worst difference on a steep ramp is the live
sampler landing between frames, not a divergence — check that it collapses to
0.0000 outside the ramp before believing it is jitter.

**Use ABSOLUTE composition time on both sides.** Taking a relative origin after
the transport has already started shifts every live timestamp by however long
the harness slept, and the symptom looks exactly like a bug: every STEP appears
to fire early in preview by a constant amount. It cost a false positive on the
Take pass — a 0.5 disagreement on a parameter and four `layer.enable`
mismatches, all of which vanished when the origin was removed. A constant lead
on steps, rather than symmetric noise on ramps, is the tell that the harness is
wrong and not the app.

**Expect one mismatch per discrete event.** Matching each export frame to the
nearest live sample straddles a step: the export frame at the event time pairs
with a live sample from a few milliseconds before it, where the event correctly
had not fired yet. One mismatch per event is the matcher, not the app.

**What makes a case worth differencing:** anything where preview keeps runtime
state that export models differently. Morphs were the obvious one — preview has
a single `active`, export had a list. Feedback, temporal history and calibration
all have the same shape and are already covered by the export's own preroll
gates.

**Takes were differenced and are clean.** The signature fixture — four lanes,
all five event kinds, a macro fanning out, and a `beat` modulation — agrees to
**0.0000 wherever nothing is ramping**, across the primary layer's parameters
and both secondary opacities. The reason is structural rather than lucky: a
Take's two sides share one canonical evaluator, substitute at the same base
seam, and dispatch through one `TakePerformer` shape. Morphs had two
independently written models, which is exactly why they had three faults and
Takes had none.

**Parameters agreeing is not pixels agreeing.** The CHLADNI piece differenced
clean at the parameter level and still exported a grey wash the preview never
showed. Three findings came out of chasing it, in the order the evidence
forced them:

1. **Warm the preview before you capture it.** `seek(42)` + 400 ms of play is
   a cold echo (0.8 s of history missing) and a cold bloom. The first
   comparison was invalid for that reason alone. Play from ≥10 s before the
   frame you compare.
2. **Motion was frame-rate dependent** (see the v0.8.3 ADR). Found by sampling
   `branchFor(TRAIL).lastResolved.copyRotation` on both paths: 11° live, 1.5°
   exported, from the same seconds. Fixed; both read 1.52 now.
3. **The preview showed linear light.** Layer-by-layer bisection (mute through
   the Take's *baseline* — the document's `enabled` flag is overridden by it)
   isolated GLOW; every number on that branch was identical on both paths;
   the composite still differed. The gate below settled it in three minutes.

## The 128-grey gate (v0.8.3)

The cheapest possible colour-pipeline check, and the one that would have
caught the preview's gamma the day the compositor shipped:

1. A PNG with a 128 left half, a 64 right half, one white square.
2. New project, import it, `directional-smear` at `amount: 0` (identity).
3. Screenshot the preview; export one frame as a PNG sequence.
4. Read the same three points in the file, the preview and the export.

Pass: all three agree to within one code. Before v0.8.3 the preview read
**55/13** against 128/64 in the file and the export — the sRGB EOTF of the
file, exactly. Add a second layer of the same image at `0.5 screen` and both
paths must read **149/78**: the blend happens in linear light and is encoded
once. `tests/preview-color.test.ts` pins those numbers to the TS mirror of
the transfer; only the running app can show the canvas is right.

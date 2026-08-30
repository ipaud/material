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

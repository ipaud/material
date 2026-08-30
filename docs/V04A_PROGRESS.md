# v0.4A — Image / Motion Signals — progress

Checkpoint log. One entry per phase: decisions, tests, measurements, blockers.

---

## A0 — pre-work — COMPLETE

Four defects found while mapping the codebase, all blocking later phases. Every
one has the same shape: a system that looked healthy because the thing it had
stopped doing was perfectly reproducible.

### R1 — optical flow was frozen for generator sources in preview

`sourceFrameKey()` is `${texture.uuid}:${sourceFrameCounter}`, and
`sourceFrameCounter` only ticks from `requestVideoFrameCallback` — which exists
only on `HTMLVideoElement`. A generator's texture is one stable object, so the
key never changed and `OpticalFlowField.update()` early-returned forever.

**Measured, clean process, `noise` generator + Motion Mosh, 3 s of preview at
120 fps:**

| | flow updates in 3 s |
|---|---|
| before | **0** (counter stuck at 1) |
| after | **360** |

The whole Motion pack — Flow Displace, Motion Mosh, Motion Trails, Flow
Feedback, Motion RGB, Directional Smear — was dead in preview on any generator
source. Export was unaffected because CE1H passes explicit frame keys, which is
precisely why the determinism matrix read 12/12 the whole time. A frozen field
is perfectly reproducible.

Fix: a `generatorRevision` counter incremented in `renderGenerator()` when it
actually draws, folded into the frame key. The visual-signal reducer needs the
same token in A2.

### R2 — FREEZE stored two different quantities

`shapeMappingValue`'s frozen branch returned `clamp(frozenValue,0,1)` and
**skipped** the `min + (max-min)·v` scaling. Preview stored the pre-range value
(`smoothing.peek`); export stored the post-range one. So freezing a mapping with
min 0.2 / max 0.8 already jumped its contribution to the full span, and the two
paths disagreed about what the stored number meant.

This blocks A7: widening the Min/Max sliders to −1..1 for centred motion would
make a frozen "still" `motion.x` output 0.0 instead of 0.5 — a full-scale jump
at the instant of freeze. FREEZE and centred motion would have been mutually
exclusive.

Fix: extracted `shapedUnitValue()` (the 0..1 pre-range value, which is what
FREEZE stores in both paths); `shapeMappingValue` applies the range on top,
frozen or not.

### R3 — the Output never received two fields the replica reads

`toFrameMsg` dropped `sourceParams` and `transition`, though `FrameStateMsg`
declares both and `replica.ts` reads both. Consequences on the shipping build:
generators rendered on the Output with **unmodulated** params (falling back to
the low-rate `RenderInputs`), and CE1G morph transitions never appeared there at
all. v0.4A would deepen this, since visual signals modulate source params.

Fix: forward both. Still resolved values only — the replica evaluates nothing,
asserted by test.

### R4 — the source-param fallback was dead code

`this.lastSourceValues ?? evalSources(...)` with `lastSourceValues` initialised
to `{}`: `{} ?? x` is `{}`, so the fallback never fired and every `source.*`
mapping was skipped on the first frame. Now `null` until the first `transform()`,
which also gives A1 a clean way to distinguish "not evaluated yet" from
"evaluated to nothing".

### Minor

- `StatusRail` read `v.beat`, an id `evalSources` never emits (the grid sources
  are `beat:1/4` …), so the beat dot never lit. Now reads the quarter-note phase.
- `OpticalFlowField.bytes` claimed RGBA16F and under-reported by ~40%; the
  targets are `FloatType` (RGBA32F).

### Doc debt from CE1H

`MODULATION.md` and `EXPORT_PIPELINE.md` still described a **fresh** smoothing
state per export and `t = startSec + i/fps`. Both changed in CE1H. Corrected
before building on them.

### Gates

lint 0 · typecheck 0 · **1021 tests** · `tests/a0-prework.test.ts` locks all four.

**Proceeding to A1.**

---

## A1 — signal contract — COMPLETE

Three signals, dotted family ids: `image.luminance`, `motion.amount`, `motion.x`.

The design pass surfaced a property worth stating loudly: **`motion.x` needs no
per-source calibration at all.** It is the magnitude-weighted mean of the *unit*
direction, `Σ(|f|·f.x/|f|) / Σ|f| = Σf.x / Σ|f|` — the weight cancels
analytically, so it is bounded to ±1 by construction. Only `image.luminance`
and `motion.amount` go through A5.

`inactive` is expressed as **absence from the source-value record**, never 0 —
absence is the evaluator's neutral, whereas 0 with `invert` or a non-zero `min`
manufactures a contribution out of silence.

## A2 — GPU reduction — COMPLETE

One extract pass (R=luma, G=|flow|, B=signed flow.x, A=coverage) then 4×4 sum
passes down to a tile of at most 8×8. At 320×180 that is 4 draws and a **240-byte
readback**. `B` is unweighted on purpose — the weight cancels in the ratio, so
no fifth accumulator.

Out-of-range children are skipped rather than clamped; clamp-to-edge would
duplicate edge texels and bias the mean. Coverage in `A` is what makes the skip
exact.

### Goldens — clean process, measured

| case | n | exact | luma | amount | motion.x |
|---|---|---|---|---|---|
| constant 0.25 | 57600 | ✓ | 0.25098 | — | 0.5 |
| ramp `vUv.x` | 57600 | ✓ | **0.500000** | — | 0.5 |
| odd half/half 317×179 | **56743** | ✓ | **0.501577** = 159/317 | — | 0.5 |
| flow right | 57600 | ✓ | — | 3.2 | **1.000000** |
| flow left | 57600 | ✓ | — | 3.2 | **0.000000** |
| flow vertical | 57600 | ✓ | — | 3.2 | **0.500000** |
| flow still | 57600 | ✓ | — | 0 | 0.500000 |

`n === gridWidth·gridHeight` exactly in every case, including 317×179 — one
integer that proves no padded texel contributed and none was dropped.
`amount = 3.2` is exactly `0.01 uv × 320` texels. Vertical motion reads dead
centre because it has no horizontal dominance, which is correct and worth
having as a fixture. Same-key re-analysis does not re-reduce; repeated analysis
is bit-identical.

`constant` reads 0.25098 = 64/255 because the fixture texture is RGBA8, like a
real source. Tolerance is half an 8-bit LSB; tightening it would only test the
fixture's precision.

**Doctrine deviation recorded**: the product path reads `FloatType` straight
into a `Float32Array`. The encode-to-RGBA8 rule exists for signed, unknown-scale
diagnostics; sums reaching 57 600 cannot survive 8 bits.

**Proceeding to A3/A4.**

## A6 — signal diagnostics (scope) + three defects only a live run could find

The scope panel is a `CollapsibleSection` closed by default, because an open
scope registers analysis demand of its own: leaving it open would keep the GPU
reducer running for a panel nobody is reading. `{open && children}` unmounts
the body, so closing releases the demand through the same path a deleted
mapping takes.

Measured round-trip, no mappings at all in the project:

| state | `engine.visualDemand` | reducer |
|---|---|---|
| scope closed | `[]` | disposed (`visualDiagnostics === null`) |
| scope open | `['image.luminance']` | 39 reductions in 1.5 s ≈ 26 Hz |
| scope closed again | `[]` | disposed again |

Three defects surfaced only once the thing ran against real pixels. Every one
of them passed the whole unit suite first.

**1. The analysis call was in the wrong render path.** It sat in
`captureTransitionSnapshot`, which runs only when a transition opens. Demand
was set, the source texture was present, the grid was valid — and the reducer
ran zero times in 2.5 s of preview. Moved into `renderFrame`, immediately after
`syncScene()`, which is where the N−1 contract requires it.

**2. Calibration was advanced on transport time.** The sink passed
`playback.getTime()`, so with the transport stopped `dt` was 0 on every step:
`elapsedSec` never reached `warmupSec` and every visual signal stayed `warming`
forever. The analyser runs on *produced pixels* — a live camera and a
simulation generator produce them with the transport parked — so preview
calibration advances on wall time. Export is untouched: it owns a separate
store stepped by frame time, which is what keeps it deterministic.

**3. The optical-flow priming frame was published as a measurement.**
`OpticalFlowField.update()` deliberately clears its targets on the first update
after a prime, so no garbage field is ever produced. That all-zero field then
reached the reducer, and `motionAmount = 0` seeded the motion calibrator's LOW
envelope with an extreme the source never produces. Measured on a clean
calibration key before the fix:

| | raw min | raw max | calibrated mean | calibrated max |
|---|---|---|---|---|
| before | 0.419 | 0.585 | **0.894** | 1.000 (saturating) |
| after | 0.348 | 0.567 | **0.447** | 0.869 |

τ_contract = 4 s gives the range back only slowly, so one false zero flattened
the knob for ~10 s. `OpticalFlowField` now counts real Lucas–Kanade solves and
exposes `ready`; the engine passes the field to the reducer only when it is
ready, and `publish.ts` omits the motion keys entirely in the meantime —
absence, not zero, which is the same neutral the rest of the contract uses.
`reset()` clears the counter, so a seek or source switch re-primes honestly.

Calibration on a clean key, generator `noise` seed 91, 3 s of samples:

| signal | raw span | calibrated span | calibrated mean |
|---|---|---|---|
| `image.luminance` | 0.445–0.503 (0.058) | 0.119–0.605 | 0.407 |
| `motion.amount` | 0.348–0.567 (0.219) | 0.136–0.869 | 0.447 |
| `motion.x` | 0.390–0.470 | pass-through, uncalibrated | 0.434 |

A 0.058 raw luminance band becomes 0.486 of usable travel. That is the whole
point of the RAW/CALIBRATED split, and it is the CE1H `mids`/`highs` lesson
answered.

**One non-defect, recorded so it is not re-investigated.** A mid-flight source
switch stops the transport and, with a stateless generator, the preview loop is
dirty-driven — so analysis legitimately stops until playback resumes. An early
probe read this as "analysis dies on source switch"; `generatorRevision` frozen
while `getTime()` returned to 0 is what distinguishes the two.

A second false alarm cost a detour: a probe passing only `{scale, speed}` to
the `noise` generator left `detail`, `warp` and `contrast` at 0 through the
positional `GENERATOR_PARAM_ORDER` mapping, producing a **flat** field. Bit-
identical luminance across 111 reductions is the signature of a constant image,
not of a stale texture.

**Proceeding to A9.**

# Signals

Everything MATERIAL can listen to, and where each signal comes from. Two
reference documents sit either side of this one: [MODULATION.md](MODULATION.md)
describes how a continuous signal is shaped onto a parameter, and
[PARAMETER_EVALUATION.md](PARAMETER_EVALUATION.md) gives the exact order in
which every layer is combined.

## The two classes

| Class | Sources | Preview | Export |
| --- | --- | --- | --- |
| **Deterministic** | audio features, time, beat/bar/division, onsets, markers | ✓ | ✓ identical |
| **Live** | manual buttons, keyboard, MIDI | ✓ | **absent by design** |

A deterministic signal is a pure function of `(project, analysis, timeSec)`.
That single property is what lets preview and export agree frame for frame,
lets seeking show exactly what playing into that point would show, and makes
loops incapable of double-firing.

Live signals are the performer's hands. They are real in the room and absent
from the render, because an unrecorded performance is not something MATERIAL
will pretend into a file. See [PERFORMANCE.md](PERFORMANCE.md) for the
recording architecture this leaves open.

## Audio analysis

Offline, deterministic, computed once per audio file in a worker (radix-2 FFT,
2048-sample window, 512-sample hop → ~86 frames/second at 44.1 kHz). Playback
and export both read the same arrays, so a modulation value at 12.5 s is the
same number in both.

| Track | What it is |
| --- | --- |
| `master` | Overall level envelope |
| `rms` | Windowed RMS — smoother than master |
| `peak` | Per-hop maximum absolute sample |
| `bass` / `mids` / `highs` | Three band envelopes |
| `centroid` | Spectral centroid on an absolute log-frequency scale (100 Hz – 8 kHz) |
| `flux` | Positive spectral flux |
| `onset` | Log-compressed flux minus an adaptive local mean, half-wave rectified |
| `transients` | The v0.1 transient track, kept for compatibility |

Normalization choices that matter:

- The three bands share **one** reference so their relative balance is real. A
  bass-heavy passage lights `bass` and leaves `highs` low, instead of every
  band self-normalizing to full scale.
- `master` gets its own reference, so it is not crushed by the band reference.
- `centroid` is absolute, not normalized per track, so "bright" means the same
  thing across songs — and it holds its last value through silence rather than
  collapsing to zero.

Sampling outside the analysed span is clamped, never NaN.

## Tempo and the beat grid

`detectTempo` runs autocorrelation over the onset envelope across 60–200 BPM
with a log-normal prior at 120, parabolic interpolation for sub-bin accuracy,
and a comb filter for beat phase. It returns `{bpm, confidence, beatOffsetSec}`
plus a half/double-time alternative when the reading is ambiguous.

**Detection is advisory.** The manual BPM always wins, TAP is always
available, and a degenerate envelope (silence, DC, a lone impulse) returns
`null` rather than a confident-looking number. Measured on the reference
track: 78.03 BPM at 0.838 confidence.

From `{bpm, beatOffsetSec, beatsPerBar}` the grid derives beat times, bar
positions, division phases (1/2 … 1/16) and the `BAR 021 · BEAT 3 / 4`
readout. Everything downstream is arithmetic on that grid — no counters, no
accumulated drift.

## Trigger sources

Discrete events, all resolved as *times*, never as sampled thresholds:

| Source | Event times |
| --- | --- |
| `beat` | Every beat on the grid |
| `bar` | Every bar line |
| `div:1/2` … `div:1/16` | Musical subdivisions |
| `onset` | Peak-picked onset times (threshold 0.3, minimum separation 0.12 s), cached per analysis |
| `marker:<id>` | A timeline marker's position |
| `manual` | UI button — live class |
| `midi:<mappingId>` | A MIDI note — live class |

The scheduler asks each source for its events in the half-open interval
`(lastTime, now]`. An event exactly on a boundary belongs to exactly one
interval, which is why changing the frame rate, seeking onto a beat, or
looping cannot duplicate or drop a firing.

## Pulses

A pulse is an AHD envelope attached to a trigger. For deterministic sources it
is evaluated as a **pure function of time**: the value at `t` is the sum of
envelopes from events within the lookback window before `t`. No state machine,
so seeking is free and export needs no replay.

Overlapping pulses on one parameter **sum**, then clamp — a drum roll builds
energy rather than plateauing. Negative amounts pulse downward.

## Image and motion signals (v0.4A)

MATERIAL can listen to the picture it is making. Three signals, deliberately
few: each one had to survive every gate before the next was considered.

### The semantic matrix

| Id | RAW meaning | RAW domain | Public domain | Calibration | Validity |
| --- | --- | --- | --- | --- | --- |
| `image.luminance` | mean Rec.709 luma | 0..1 | unipolar | per-source envelope | warming 0.75 s |
| `image.contrast` | standard deviation of luma | 0..0.5 | unipolar | per-source envelope | warming 0.75 s |
| `image.edgeEnergy` | mean gradient magnitude | 0..~1.4 luma/texel | unipolar | per-source envelope | warming 0.75 s |
| `motion.amount` | mean flow magnitude | 0..11.3 texels/frame | unipolar | per-source envelope | absent without flow |
| `motion.activity` | fraction of texels moving | 0..1 | unipolar | **none** — already a fraction | absent without flow |
| `motion.x` | weighted mean unit direction | ±1 → 0..1 | centred | **none** — intrinsically bounded | absent without flow |
| `motion.y` | weighted mean unit direction | ±1 → 0..1 | centred | **none** — intrinsically bounded | absent without flow |
| `motion.centroidX` | first moment of flow magnitude | 0..1, 0 = left | **position** | **none** — it is a coordinate | held when motion < 0.1 texels |
| `motion.centroidY` | first moment of flow magnitude | 0..1, 0 = top | **position** | **none** — it is a coordinate | held when motion < 0.1 texels |

All nine cost the same: one shared extract, one shared ladder, one readback.

They join `MOD_SOURCES` and flow through the same evaluator as audio and beat.
Nothing about the modulation engine changed to accommodate them.

### Calibration is chosen, not automatic

Four signals calibrate. Five deliberately do not, for three different reasons:

- **intrinsically bounded** — `motion.x`/`motion.y` are magnitude-weighted
  means of the *unit* direction, so the weight cancels analytically and the
  result cannot leave ±1. Calibrating would add lag and buy nothing.
- **already a physical fraction** — `motion.activity` answers "how much of the
  frame is moving" in units a performer can reason about. Calibrated, it would
  answer "more than usual for this source", which is a different and vaguer
  question.
- **a coordinate** — `motion.centroidX`/`Y` say WHERE. Stretching a position to
  fill "usable travel" moves the effect somewhere the motion is not, which is
  the one thing a positional signal must never do.

### What separates the signals that look alike

Three pairs could plausibly be redundant. Each has a fixture that proves it is
not, and a measured correlation on real material:

| Pair | Discriminating fixture | Result | Correlation on video |
| --- | --- | --- | --- |
| luminance vs contrast | flat frames at 0, 0.5, 1 | contrast 0 at every brightness | 0.57 |
| contrast vs edgeEnergy | 16 stripes vs one split, both 50/50 black-white | identical contrast (0.5), edge **31×** apart | 0.70 |
| amount vs activity | 1/16 of the frame at 16× speed vs the whole frame slowly | identical amount, activity **16×** apart | 0.77 |
| motion.x vs centroidX | a patch moving right, on the left of frame | direction +1, position 0.125 | **0.12** |

Contrast and edge energy correlate most on real video, because a busy frame
tends to be both. They are kept apart because the fixture shows the quantities
are independent, and because they answer different questions: contrast is how
far the tones spread, edge energy is how often the image crosses that spread.

Edge energy is **total variation per texel**, which has one consequence worth
stating: a smooth full-range ramp and a single hard edge read the SAME, because
both traverse the range exactly once. Contrast is what separates those two. A
blur lowers edge energy by removing amplitude, not by being smooth.

### Where the numbers come from

One GPU chain, three RGBA planes (MRT), all nine statistics at once. An
extract pass packs, at the analysis grid:

```
plane 0   R = L          G = L²        B = |∇L|      A = 1
plane 1   R = |f|        G = f.x       B = f.y       A = moving ? 1 : 0
plane 2   R = u·|f|      G = v·|f|     B = —         A = —
```

then 4×4 **sum** passes walk the ladder down until the largest side is ≤ 8, one
tiny pass stacks the three final tiles into a single target, and only that
comes back — 5×9 RGBA floats, **720 bytes**. The frame itself is never read
back. Image-only demand uses one plane and skips the stacking pass: 4 draws and
**192 bytes**.

`L²` alongside `L` gives variance in one pass — contrast is a real standard
deviation, not an ad-hoc spread. `u·|f|` and `v·|f|` are first moments, so the
centroid is `Σ(u|f|)/Σ|f|`: a position, with no tracking model anywhere.

`A` carries the sample count, which is what removes edge bias: texels outside
an odd-sized parent contribute `(0,0,0,0)` and change neither numerator nor
denominator. `ΣA == gridWidth·gridHeight` **exactly**, for any dimensions, is
the single strongest assertion in the whole subsystem — 56 743 for a 317×179
grid, not 57 600.

`B` is the raw signed x, unweighted, because the magnitude weight cancels
analytically in `ΣB / Σ|f|`. That saves an accumulator and, more usefully,
makes `motion.x` intrinsically bounded to ±1 — which is why it needs no
calibration at all.

### RAW vs CALIBRATED

CE1H measured the failure this exists to prevent: on the reference track
`mids` never exceeds 0.181 and `highs` never exceeds 0.058. The numbers were
right and the knobs were dead.

So every calibrated signal has two layers. **RAW** is the measurement, in real
units, and it is what the scope shows you. **CALIBRATED** is RAW mapped through
a per-source envelope into usable travel, and it is what a mapping consumes.

The envelope is asymmetric and holds three numbers: expand fast toward a new
extreme (τ = 1.5 s), give range back slowly (τ = 4 s), with a floor on the
half-span so a static source's noise cannot become full scale. Measured:

| source | raw luminance span | calibrated span |
| --- | --- | --- |
| bright generator | 0.045 | 0.544 |
| video file | 0.234 | 1.000 |
| camera, still room | 0.001 | 0.266 |

The camera row is the one to read twice. A raw span of 0.001 is a source that
is doing nothing, and it still yields a quarter of the range rather than either
a dead knob or a noise amplifier.

Calibration is **runtime only**. Nothing about it is serialised: it is derived
moving state, and persisting it would make an export irreproducible from a
fresh open of the same project.

### The calibration key is the pixel origin

Neither existing handle was right — `source.id` survives a camera device swap,
and the engine's `sourceKey` has no id for files. The key tracks where the
pixels actually come from:

| Variant | Key |
| --- | --- |
| file | `file:${kind}:${path}` |
| generator | `gen:${generator}:${seed}` — params excluded, same material |
| camera | `cam:${deviceId ?? 'default'}` |
| screen | `screen:${displayId}` |
| window | `window:${chosenWindowId ?? titleHint ?? id}` |

### Absence is the neutral, never zero

A signal with nothing behind it is **omitted from the published record**, not
published as 0. Absence is what the evaluator already treats as neutral: the
mapping is skipped entirely, so `invert`, a curve or a non-zero `min` cannot
manufacture a contribution out of a source that is not there. Publishing 0 for
"no flow" would silently drive every motion mapping to its `min`.

Validity is `valid | warming | inactive`. `warming` covers the first 0.75 s
after a calibrator is seeded, where a span of ~0 would otherwise explode.

### What the signals cost

Measured on the reference machine, `noise` generator at 120 fps preview:

| mapped | analysis rate | draws | readbacks | bytes | ladder VRAM | flow VRAM | preview fps |
| --- | --- | --- | --- | --- | --- | --- | --- |
| nothing | — | 0 | 0 | 0 | 0 (released) | 0 (released) | 120.2 |
| 1 image signal | 26 Hz | 4 | **1** | 192 | 0.60 MB (256×144) | 0 | 120.0 |
| all 3 image signals | 26 Hz | 4 | **1** | 192 | 0.60 MB | 0 | 119.7 |
| 1 motion signal | 26 Hz | 5 | **1** | 720 | 2.81 MB (320×180) | 2.20 MB | 119.0 |
| all 6 motion signals | 26 Hz | 5 | **1** | 720 | 2.81 MB | 2.20 MB | 120.0 |
| **all nine** | 26 Hz | 5 | **1** | 720 | 2.81 MB | 2.20 MB | **120.0** |

Cost is **flat in the number of signals**: one image signal costs exactly what
three cost, and one motion signal exactly what six cost. One ladder pass costs
0.37–0.78 ms wall including the readback stall, against an 8.33 ms budget at
120 fps.

Analysis is demand-driven: nothing mapped and no scope open means the targets
are released, exactly like the flow service. Image-only demand never wakes
optical flow — measured, not assumed.

Mapping a motion signal also **keeps the flow field alive** even when no
technique wants it — before v0.4A the field was disposed whenever
`techniqueWantsFlow()` was false, so `motion.amount` under Mosaic would have
had nothing to measure.

### Determinism

Visual signals over deterministic sources (generator, file) are deterministic
and export. Over live sources they are the live class, exactly as the table at
the top of this document splits everything else.

Preview and export evaluate signals in **opposite order** relative to the
source render — preview evaluates after, export before. Sampling frame **N−1**
in both is what makes them agree; the one-frame delay is a correctness
requirement, not a stylistic choice. Verified: repeat export and
full-vs-subrange export are byte-identical for all signals, and disabling the
analyser changes every exported frame.

### Which signals are analysed

Demand, not configuration. A signal is analysed when a mapping uses it, when a
morph or candidate overlay's mappings use it, or when the scope is watching it.
The runtime resolves the overlay, so the runtime decides; export cannot wait
for a frame loop, so it unions every Look its morph events can reach.

Closing the last thing that wanted a signal releases the GPU targets — and if
nothing wants motion, the optical-flow field is released too.

### Validity

| state | meaning | published? |
| --- | --- | --- |
| `valid` | a measurement | yes |
| `warming` | the calibrator has been seeded for less than 0.75 s | **no** |
| `inactive` | no field, or no source | **no** |
| `held` (centroids) | motion is below the floor; the last valid position stands | yes, marked HELD |

A signal that is not published is ABSENT from the record, and absence is the
evaluator's neutral: the mapping is skipped entirely.

### Saturation

Lucas–Kanade measures over a 5×5 window and its shader clamps each component
at 8 texels, so the most the instrument can express is 8·√2 texels/frame.
Beyond about 4 the linearization has degraded, which `motionValid` records for
diagnostics — but the value is still published and still calibrated, because a
genuinely fast source should peg the knob. A 12 fps export of a moving source
legitimately displaces 5–8 texels per frame; suppressing those frames deleted
motion from 59 of 61 of them.

## Live signals

MIDI CC drives a parameter or macro in ABSOLUTE mode with pickup
(see [MIDI.md](MIDI.md)); MIDI notes and pads fire trigger actions through the
same scheduler and the same quantization as everything else. Keyboard
shortcuts are listed in [SHORTCUTS.md](SHORTCUTS.md).

None of it reaches a rendered file. During an export, incoming MIDI is
dropped at the engine entrance, and the actions that move shared render state
are blocked outright.

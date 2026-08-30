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

| Id | Unit | Domain | Calibrated |
| --- | --- | --- | --- |
| `image.luminance` | Rec.709 luma, 0..1, display-referred | unipolar | yes |
| `motion.amount` | analysis texels per frame | unipolar | yes |
| `motion.x` | unit direction, 0.5 = still | centred | no — intrinsically normalised |

They join `MOD_SOURCES` and flow through the same evaluator as audio and beat.
Nothing about the modulation engine changed to accommodate them.

### Where the numbers come from

One GPU chain, four channels, all statistics at once. An extract pass packs
`R = luma, G = |flow|, B = flow.x signed, A = coverage` at the analysis grid,
then 4×4 **sum** passes walk the ladder down until the largest side is ≤ 8, and
only that tile comes back — typically 5×3 RGBA floats, **240 bytes**. The frame
itself is never read back.

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

| mapped | analysis rate | ladder VRAM | flow VRAM | preview fps |
| --- | --- | --- | --- | --- |
| nothing | — | 0 (released) | 0 (released) | 120.2 |
| luminance | 26 Hz | 0.60 MB (256×144) | 0 | 120.0 |
| motion | 26 Hz | 0.94 MB (320×180) | 2.20 MB | 120.0 |
| all three | 26 Hz | 0.94 MB | 2.20 MB | 120.0 |

One ladder pass costs 0.37–0.78 ms wall including the readback stall, against
an 8.33 ms budget at 120 fps. Analysis is demand-driven: nothing mapped and no
scope open means the targets are released, exactly like the flow service.

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
full-vs-subrange export are byte-identical for all three signals, and disabling
the analyser changes every exported frame.

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

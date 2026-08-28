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

## Live signals

MIDI CC drives a parameter or macro in ABSOLUTE mode with pickup
(see [MIDI.md](MIDI.md)); MIDI notes and pads fire trigger actions through the
same scheduler and the same quantization as everything else. Keyboard
shortcuts are listed in [SHORTCUTS.md](SHORTCUTS.md).

None of it reaches a rendered file. During an export, incoming MIDI is
dropped at the engine entrance, and the actions that move shared render state
are blocked outright.

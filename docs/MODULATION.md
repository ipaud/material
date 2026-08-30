# Modulation

A mapping connects a **signal** to a **parameter**:

```
SOURCE SIGNAL → TRANSFORM → TARGET PARAMETER
```

Every mapping is evaluated by one deterministic evaluator, used identically by
preview and export. There is no second code path.

## Sources

| Group | Ids |
|---|---|
| Audio | `master`, `rms`, `bass` (20–250 Hz), `mids` (250–4 k), `highs` (4–16 k), `transients` |
| Time | `time` — 0→1 across the timeline |
| Beat | `beat:bar`, `beat:1/2`, `beat:1/4`, `beat:1/8`, `beat:1/16` |
| Image | `image.luminance` |
| Motion | `motion.amount`, `motion.x` |

Image and motion sources measure the frame the instrument is producing. They
arrive already calibrated to the current source, so the same mapping stays
playable when the material changes — see [SIGNALS.md](SIGNALS.md) for what RAW
and CALIBRATED mean and why `motion.x` is exempt. They are sampled from frame
N−1, and a signal with nothing behind it is absent from the record rather than
zero, so its mappings are skipped entirely rather than driven to `min`.

`motion.x` is centred: 0.5 is still. Its default mapping is `{min: -1, max: 1}`,
which is why the Min/Max sliders span −1..1.

Audio sources read **precomputed** analysis arrays (a ~10.7 ms hop, linearly
interpolated), not a live analyser. That is why a rendered frame matches the
preview at the same time exactly.

The three bands share one normalization reference so their relative energy
survives — a pure bass tone does not light up `highs`. `master`, `rms` and
`transients` are normalized individually.

Beat sources are pure functions of `(time, bpm, beatOffset)` and produce a
0→1 phase ramp per division. BPM is entered manually in the timeline;
automatic detection is not implemented.

## Transform

```
v = source(t)
v = clamp((v − inMin) / (inMax − inMin), 0, 1)   // input window, default identity
v = invert ? 1 − v : v
v = curve(v)                       // linear | exponential (v²) | logarithmic (√v)
v = smooth(v, dt)                  // EMA, time constant up to ~0.8 s
shaped = min + (max − min) · v     // output window
```

`amount` is signed and scaled by the target parameter's own range, so
`+1.0` means "the full range of this parameter" regardless of its units.

## Add and Set

Every mapping is one of two modes. **Add** is the historical behaviour and the
default; a mapping stored before v0.4C has no `mode` field at all and means
exactly what it always meant.

```
ADD      final = clamp(base + amount · shaped · paramSpan)
SET      position = paramMin + shaped · paramSpan
         final    = clamp(base + (position − base) · |amount|)
```

**Add** nudges the parameter from wherever the slider left it, so the slider
still sets the resting point. **Set** positions it inside its own range and
ignores where it sat.

Two things need Set:

- **positions.** `motion.centroidX → Feedback Center X` has to map position to
  position. "Add ±amount to the current centre" throws the meaning away, so
  positional signals arrive in Set mode by default.
- **parameters near a rail.** Measured on Feedback persistence parked at 0.98:
  a full-strength Add mapping moves it between 0.980 and 0.995 — 1.5% of
  travel, the rest eaten by the clamp. The same signal in Set mode with a
  0.50–0.99 window moves it between 0.748 and 0.990. Sixteen times the travel,
  from the same signal.

In Set mode `amount` blends between where the parameter was and where the
signal puts it, so the slider still reads as "how much does this mapping
matter": 1 is full authority, 0 is none.

### How several mappings on one parameter compose

```
base parameter value
  → at most one SET mapping positions it
  → every ADD mapping sums on top
  → clamp once
```

At most one Set, deliberately. Two mappings each claiming to *be* the parameter
have no meaningful sum, and choosing by evaluation order would make the result
depend on the order rows happen to sit in. The first enabled Set in document
order wins; the rest are inert and the UI marks them `INERT` rather than
leaving a dead row looking live.

## Input window vs calibration

They are different things and the distinction matters:

| | what it does | who decides |
|---|---|---|
| **Calibration** | adapts a signal's range to the current SOURCE | automatic, per pixel origin |
| **Input window** | narrows attention to the part of the signal you care about | you, per mapping |

Calibration is why `Luminance → Depth` survives changing from a dark clip to a
bright generator. The input window is how you say "only react above half
brightness". Doing the second by hand instead of the first is the mistake that
makes a Look source-specific.

## Invert

`1 − v`, for every signal. That is already correct for centred signals: they
publish `0.5 + 0.5 · direction`, so `1 − v` maps `+d` to `−d` exactly. A
separate bipolar inversion would break the unipolar sources that share the
evaluator.

## Freeze

Freeze captures a mapping's current shaped value and holds it. The parameter
keeps that value until released — useful for locking a look found mid-playback
without hunting for the numbers. Frozen values are stored in the project, so a
frozen mapping renders identically tomorrow.

## No cycles by construction

Targets are leaf parameters. A mapping's output never becomes another
mapping's input, so a cycle cannot be expressed. Multiple mappings on the same
target simply sum.

## Determinism

Smoothing is stateful, so a mapping depends on the frames before it. Export
therefore **replays the evaluator from the timeline origin** and steps a fixed
`dt = 1/fps`: the skipped frames are walked (cheaply, nothing is rendered) so a
subrange arrives at its first frame carrying the same smoothing and trigger
history a full export would have. Mappings with `smoothing = 0` are purely
time-addressable either way.

Before CE1H the export started from a *fresh* state at the export start, which
made any single export reproducible but let a subrange disagree with a full
export — measured at 0/12 matching frames with the reference track driving
Motion Mosh at smoothing 0.2, and 12/12 with smoothing 0.

Verified against `SHAZUNO-material.mp3`: the export evaluator and the live
preview evaluator agree to **4.2 × 10⁻¹³** over 90 frames.

## Combinations worth trying

| Mapping | Effect |
|---|---|
| `bass → maxOffsetSec` | the past reaches further out on low end (Echo Chamber) |
| `beat:1/4 → scale`, invert + exponential | rise-and-snap pump |
| `transients → jitterX/Y` | scatter on hits |
| `master → threshold` | image thins as energy rises (Slow Burn) |
| `time → rotation` | slow drift across the whole piece |
| `bass → depth` | parallax that breathes with the mix |

## Band balance on real material (measured, CE1H §17)

The three frequency bands share ONE normalization reference, deliberately, so
that a pure bass tone cannot light up the `highs` track. The consequence on
real music is worth knowing before you map anything.

Measured over the full reference track (SHAZUNO-material.mp3, 221s, 20717
analysis frames), as the fraction of the track each source spends above 0.2:

| Source | min | max | mean | usable time |
|---|---|---|---|---|
| master | 0 | 1.000 | 0.433 | 87.8% |
| rms | 0.003 | 1.000 | 0.417 | 92.4% |
| peak | 0 | 1.000 | 0.437 | 91.4% |
| centroid | 0.161 | 1.000 | 0.694 | 99.8% |
| flux | 0 | 1.000 | 0.250 | 53.6% |
| transients | 0 | 1.000 | 0.250 | 53.6% |
| bass | 0 | 1.000 | 0.237 | 45.1% |
| onset | 0 | 1.000 | 0.044 | 6.3% |
| **mids** | 0 | **0.181** | 0.055 | **0.0%** |
| **highs** | 0 | **0.058** | 0.007 | **0.0%** |

On a loud, bass-heavy mix, `mids` never exceeds 0.18 and `highs` never
exceeds 0.06 across the entire track. They are not broken and they are not
silent — they are correctly scaled *relative to the bass*, which is what the
shared reference buys.

**What to do about it — and what NOT to do.** The intuitive move is to narrow
the mapping to the band's real span. That is backwards. A mapping's
`min`/`max` are its OUTPUT range:

```
shaped = min + (max - min) * source
final  = clamp(base + amount * shaped * parameterSpan)
```

so setting `max: 0.18` makes the band contribute *less*, not more. Measured on
this track driving `time-field.depth`: narrowing to 0–0.18 shrinks the travel
below the plain 0–1 mapping.

Gain lives in **`amount`**, which multiplies the parameter's span. Raising it
to 5 gives roughly 2.4× the travel — bounded by the parameter ceiling, so gain
buys reach, not headroom. `tests/audio-driven.test.ts` asserts both directions
so this advice cannot rot.

`onset` spending only 6% of the track above 0.2 is correct and desirable —
it drives triggers, and a smeared onset track fires constantly.

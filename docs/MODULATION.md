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
v = invert ? 1 − v : v
v = curve(v)                       // linear | exponential (v²) | logarithmic (√v)
v = smooth(v, dt)                  // EMA, time constant up to ~0.8 s
v = min + (max − min) · v          // range window
final = clamp(base + amount · v · paramSpan, paramMin, paramMax)
```

`amount` is signed and scaled by the target parameter's own range, so
`+1.0` means "the full range of this parameter" regardless of its units.
Mappings are **additive on top of the parameter's own value**, so the slider
still sets the resting point.

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

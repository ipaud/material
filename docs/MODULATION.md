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
handles this by starting a **fresh** smoothing state at the export start and
stepping a fixed `dt = 1/fps`, which makes any single export exactly
reproducible. Mappings with `smoothing = 0` are purely time-addressable.

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

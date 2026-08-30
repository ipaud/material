# Roadmap

## v0.1 — shipped

Phases 0–9. Secure Electron shell; GPU mosaic; SVG and raster materials;
video and the authoritative clock; deterministic audio analysis and beat grid;
modulation with freeze; seeded Explore with locks and MUTATE; deterministic
export (PNG, PNG sequence, H.264, ProRes 422/4444 with alpha);
composition-time temporal engine with Echo, Step Print and Slit Scan;
techniques browser; autosave and crash recovery.

## v0.2 — shipped

Phases 10–17, themed MUSIC / PERFORMANCE. Audio Engine 2 (peak, centroid,
flux, improved onset) with offline tempo detection and tap tempo; a musical
clock with bar/beat/division phases and markers; the trigger engine with
pure-function pulses and one quantizing scheduler; Freeze 2.0; Looks 2.0 with
slots, thumbnails and morph; Web MIDI with MIDI Learn and pickup; the
Performance workspace with macros, trigger pads and quantized actions; and
CURRENT/CANDIDATE mutation with non-destructive preview.

## v0.3 — shipped

LIVE / OUTPUT: Camera / Screen / Window live sources with intent-gated
permissions, Display fullscreen output on a chosen monitor, passive Output
replica with live fan-out, realtime temporal history for live sources,
Pattern Engine v1 + v1.5. Project schema v3.

## v0.3.5 — Creative Expansion 01 — shipped

The creative layer. Six new primitives and the systems built on them:
HISTORY, FEEDBACK, FIELD, OPTICAL FLOW, SIMULATION and GENERATOR.

7 generator sources (Noise Field, Wave Interference, Voronoi, Grid, Chladni
Field, Reaction Diffusion, Cellular Automata) that are first-class
`SourceRuntime` implementations — the stateless ones are deterministic
`TemporalSource`s, which makes MATERIAL usable with zero imports and zero
permissions on first run. 20 techniques including the Feedback pack, Time
Field, the Motion pack and Simulation. 10 morph transition styles. 107
curated presets. A GPU numeric-testing harness (docs/GPU_TESTING.md) and a
determinism contract that every system now meets.

Project schema stays **v3** — every addition was additive and defaulted, so
projects written before Creative Expansion open unchanged.

Version note: this is 0.3.5, not 0.4. v0.4 is reserved below for Image /
Motion Signals and that promise predates this work.

## Next — v0.4A: IMAGE / MOTION SIGNALS — architecture & GPU reduction

Turn the image itself into control, without destroying performance and
without breaking the authority and determinism v0.3.5 just consolidated.

### Candidate signals

| IMAGE | MOTION |
|---|---|
| Luminance | Activity |
| Contrast | Amount |
| Edge Energy | X / Y |
| Color Energy | Direction |
| Red / Green / Blue | Centroid X / Centroid Y |
| | Spread |

### The shape it should take

```
SOURCE FRAME → GPU ANALYSIS → small reduction textures
             → 1x1 / tiny GPU result → tiny CPU readback → SIGNALS
             → existing modulation engine
```

Explicitly NOT:

```
SOURCE FRAME → readPixels 1920x1080 → CPU vision
```

The readback must be a handful of pixels, not a frame. Everything downstream
of SIGNALS is the modulation engine that already exists — signals join the
same vocabulary as audio, patterns and beat, so they inherit the authority
rule (editor resolves, Output receives values) and the determinism contract
for free.

### Design question to settle FIRST

A signal is not useful just because the number is correct — it needs a
**performative range**. Measured in CE1H on the reference track: `mids` never
exceeds 0.181 and `highs` never exceeds 0.058 across the whole song, because
the three audio bands deliberately share one normalization reference. The
number is right; the knob is dead.

Image and motion signals will have the same problem, harder: a dark clip, a
low-contrast camera and a high-contrast generator produce wildly different
raw ranges. So v0.4 is not only "add more signals" — it needs
**normalization / calibration per source**, decided before the signals are
built rather than bolted on after.

### Already in place

`OpticalFlowField` (shared GPU service, source-frame gated), the FIELD
contract (inline GLSL, zero passes), generators as deterministic sources, and
the CE1D-2 GPU numeric verification harness — which is what makes it possible
to assert a reduction is CORRECT rather than merely plausible.

Not built: GPU reductions.

## Next (pre-v0.3 list)

**Performance recording.** The single biggest gap. Every live gesture already
passes through one timestampable chokepoint (see the readiness table in
PERFORMANCE.md), and recorded morphs prove the replay pattern. What is missing
is a recorder and a replay path into the export evaluator.

**Keyframes.** The project format still reserves parameter/time/value/
interpolation. Needs a timeline lane and an evaluator that composes with
modulation rather than fighting it.

**Tempo map.** v0.2 has one global BPM. Music that drifts, ritardandos and
live drummers all want a tempo track. The beat grid is pure arithmetic over
`{bpm, offset}`, so this is a data-model change more than an engine one.

**Dedicated output window.** Fullscreen output on a second display, and the
foundation Syphon would need. The engine already renders from pushed state and
the transport already owns the liveness signal
(see BACKGROUND_RENDERING.md), so nothing blocks it.

**Candidate material mutation.** Blocked today because material state reaches
the renderer from the document rather than through the per-frame transform, so
a mutated material would be invisible in preview.

**Colour management.** sRGB today. Rec.709 and a linear working space are the
honest next step, then wide gamut. Nothing should claim to be colour-managed
until it is.

**More techniques.** Feedback, Recursion, Stutter, Freeze, Dither, Pixel Sort,
Distortion, Typography, Collage. The temporal ones now cost a definition plus a
renderer.

**Technique chains.** The data model holds an array of technique instances but
only the first enabled one renders. Real composition (Mosaic _then_ Echo) needs
render-target ping-pong.

## Considered, deliberately not done

**WebCodecs.** Would remove the `seeked` round trip and speed up temporal
priming. Current cost (~1–2 s to prime, roughly realtime 720p export) does not
justify the complexity yet. Revisit if frame access becomes the bottleneck.

**Proxy media.** Measured unnecessary: 4K H.264 and HEVC preview at 260–580 fps
with temporal active, because the temporal cache is proxy-resolution by design
and mosaic samples the source texture directly on the GPU. Revisit for 6K/8K or
long-GOP camera formats.

**Automatic BPM detection.** Manual BPM is honest and deterministic. Detection
that is sometimes wrong is worse than a number you typed.

**Stem separation / "vocals" band.** Not shipping a band-pass filter labelled
as vocal isolation.

## Out of scope for the foreseeable future

Cloud, accounts, collaboration, plugin marketplace, AI generation, mobile,
node graph, 3D scene editing, physics.

# Roadmap

## v0.6.1 — Runtime Ownership (shipped)

A behaviour-preserving refactor, no user-facing change. `RenderEngine` stopped
being one class playing two roles: `LayerRuntimeImpl` owns one creative chain,
`LayerHost` owns the set, and the composition owns the canvas, the loop and
the single frame publication. Every runtime question now carries its scope in
its name. 2044 lines to 987, verified byte-identical against a v0.6.0 worktree.


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

Version note: that release was 0.3.5, not 0.4, because v0.4 was reserved for
Image / Motion Signals. v0.4.0 below is that promise, kept.

## v0.4 — IMAGE / MOTION SIGNALS — shipped

The image itself is a control source. Nine signals, measured on the GPU, joined
to the existing modulation vocabulary. Full detail in [SIGNALS.md](SIGNALS.md).

| phase | what shipped |
|---|---|
| **v0.4A** | `image.luminance`, `motion.amount`, `motion.x`; the GPU reduction ladder; RAW/CALIBRATED with per-source calibration; the N−1 contract; export determinism |
| **v0.4B** | `image.contrast`, `image.edgeEnergy`, `motion.y`, `motion.activity`, `motion.centroidX/Y` on one shared MRT ladder |
| **v0.4C** | Set mapping mode, per-mapping input window, live meters, calibration Lock/Reset |
| **v0.4D** | sixteen curated `Reactive` Looks, including Body Follow |
| **v0.4E** | curation, QA, docs, release |

The design question this section reserved — "a signal can be right and the knob
still dead" — was answered by the RAW/CALIBRATED split. One unchanged Look
turns a 0.045 raw luminance span on a generator, 0.234 on video and **0.001**
on a still camera into 0.54, 1.00 and 0.27 of usable travel.

Cost is flat in the number of signals: 5 draws, **one** 720-byte readback and
2.81 MB whether one motion signal is mapped or all six, with preview holding
120 fps.

### Not built, and available

| IMAGE | MOTION |
|---|---|
| Red / Green / Blue | Direction (atan2) |
| Colour Energy | Spread (second moment) |

`motion.direction` waits for a mapping model that understands circular data —
mapping an angle onto a linear parameter has a discontinuity at the wrap.
Each of these needs what the nine got: a unit, a calibration decision,
discriminating fixtures, an anti-dead companion, and export proof.

## v0.5 — SHADER EXTENSIBILITY — shipped

MATERIAL stops being an instrument with a closed vocabulary. A shader pack —
**data + GLSL + metadata, never JavaScript** — adds techniques that behave like
native ones: their parameters appear in the inspector, accept audio, pattern,
MIDI and image/motion signals, are captured by Looks, interpolated by Morph,
mutated by Explore, replicated to the Output and exported deterministically.

| phase | what shipped |
|---|---|
| **v0.5A** | Shader Contract v1, the fragment host, compile safety, last-known-good, missing-pack behaviour, Output replication |
| **v0.5B** | local packs: managed storage, import/reload/remove, path validation, adversarial fixtures |
| **v0.5C** | parameter metadata into inspector, modulation, signals, Explore, Looks, Morph; pack presets |
| **v0.5D** | ISF single-pass image-filter subset |
| **v0.5E** | curation, QA, docs, release |

A custom shader costs what a native one-pass technique costs: 120 fps, one
program, and ~0.5 ms to compile once when first selected. Registration compiles
nothing — ten installed shaders cost ten strings.

Documented in [SHADERS.md](SHADERS.md), [SHADER_PACKS.md](SHADER_PACKS.md) and
[ISF.md](ISF.md).

### Deliberately not built

Custom vertex shaders · multiple texture inputs · multipass · persistent
buffers · colour and vec2 parameters · shader-supplied UI · pack signing ·
a marketplace · project dependency bundling.

Multipass and persistent buffers are the interesting refusal: they are not
missing features but a second copy of a system MATERIAL already has, and the
thing that would break is export determinism.


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

# Roadmap

## v0.1 — shipped

Phases 0–9. Secure Electron shell; GPU mosaic; SVG and raster materials;
video and the authoritative clock; deterministic audio analysis and beat grid;
modulation with freeze; seeded Explore with locks and MUTATE; deterministic
export (PNG, PNG sequence, H.264, ProRes 422/4444 with alpha);
composition-time temporal engine with Echo, Step Print and Slit Scan;
techniques browser; autosave and crash recovery.

## Next

**Keyframes.** The project format already reserves parameter/time/value/
interpolation. Needs a timeline lane and an evaluator that composes with
modulation rather than fighting it.

**Performance workspace.** Full-screen output, parameters bound to mouse,
keyboard and MIDI, preset triggering. Architecture is in place; nothing is
wired.

**Colour management.** sRGB today. Rec.709 and a linear working space are the
honest next step, then wide gamut. Nothing should claim to be colour-managed
until it is.

**More techniques.** Feedback, Recursion, Stutter, Freeze, Dither, Pixel Sort,
Distortion, Typography, Collage. The temporal ones now cost a definition plus a
renderer.

**Technique chains.** The data model holds an array of technique instances but
only the first enabled one renders. Real composition (Mosaic *then* Echo) needs
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

# Backlog

Deferred work, extracted during CE1H so nothing lives as a scattered TODO.
Nothing here is scheduled; each entry says what it is and what it depends on.

## Product decisions taken but not built

### Generator source presets — DEFERRED (CE1H §9)

**Decision: option B is the right shape; building it now is not.**

The four options were: (A) none, (B) a small generator preset list inside the
Source inspector, (C) reuse the general preset infrastructure under a source
namespace, (D) a combined Source+Technique preset system.

B is correct and architecturally cheap: generator parameters already use the
`ParamDef` vocabulary and the Source inspector already renders them, so a
named parameter-set map plus a select would not touch the `Preset` schema at
all. C would force generator state into a type built around `techniqueId`,
technique params, material, modulations and triggers — a worse fit for a
worse reason. D is a much larger design.

It is deferred because the cost is not the plumbing, it is the CONTENT. CE1H
curated 107 technique presets against four reference sources and found three
weak entries and one duplicate that had shipped unnoticed. A new preset
surface deserves the same treatment, and adding an uncurated content surface
during a release-closure phase is exactly the scope creep CE1H §83 forbids.

When built: Noise Field (Fine Grain / Marble / Cloud / Warp Field), Grid
(Technical Grid / Dot Matrix / Scan Grid), Chladni (Resonance / Node Field),
and equivalents for Wave Interference and Voronoi. Validate with the same
contact-sheet harness (`window.__dev.presetSheet`).

## Creative

- **Motion Bloom** — flow-weighted bloom. Interesting, never prototyped.
- **Motion X/Y Time Field** — per-axis motion driving temporal offset;
  the FIELD contract already supports the shape.
- **Advanced Field modes** — the FIELD contract is inline GLSL, so new modes
  cost no passes and no VRAM. Cheapest creative surface MATERIAL has.
- **Fluid simulation** — a third simulation family. Wants a pressure solve,
  so it is a real project, not a kernel.
- **Particles** — no existing primitive covers it.

### Per-band normalization option

`bass`/`mids`/`highs` share one normalization reference so relative band
energy survives — a pure bass tone must not light up the highs track. The
measured cost on a bass-heavy mix is that mids peak at 0.18 and highs at 0.06
across a whole track (see MODULATION.md). Mapping ranges are the workaround
today. An opt-in per-band normalization would make them full-travel controls
at the cost of losing band balance, so it wants to be a choice rather than a
change. Deliberately not done in CE1H: §17 forbids new analyzer work, and
changing normalization would silently alter every existing project's
modulation.

### Export transition snapshot is black when the A side is a feedback technique

Found while producing a music video, not by a gate. In a cross-technique morph
with a non-Smooth transition, export re-renders the A side (it cannot snapshot
one — a subrange has no earlier frame). That render runs against a technique
renderer the export just installed, so if A is a FEEDBACK technique its
ping-pong surface is empty and A renders black. When B is also a feedback
technique it starts cold too, and the reveal is black at both ends.

Measured: a `feedback-rgb → feedback-kaleido` morph at 109.4–115.0s produced
0.67s of total black (frames 111.33–112.00 at mean 0.0) in a 1080p30 export.
Raising `injection` on either side does not help — it is not warm-up, it is
that the A render has no surface at all.

Workarounds today: use `smooth` for cross-technique morphs between feedback
techniques (it takes no snapshot), or keep morphs same-technique.

Fix direction: the export A-side render needs the feedback surface walked
forward the way the main export path already does for the B side — the preroll
machinery exists (`prepareFeedbackForExport`), it just is not applied to the
A-side pass in `captureExportSnapshot`. Cheap to try; needs its own goldens
because it changes exported pixels.

## Platform

- **ISF host** — would let MATERIAL load external shaders. Changes the
  security posture from "generators are local trusted code" to "arbitrary
  shader input", so it needs a threat model first (see CE1H §76).
- **Shader marketplace / node graph / projection mapping / layers** — named
  here only so they are not mistaken for near-term work.
- **v0.4 Image / Motion Signals** — the reserved next major phase. Depends on
  `OpticalFlowField` (shipped), the FIELD contract (shipped), generators as
  deterministic sources (shipped) and GPU reductions (not built).

## Engineering

- **Decoder bit-parity research** — a compressed FileVideo can return
  different bytes for the same timestamp depending on the seek path. The
  temporal SCHEDULE is exact; only decoded pixels vary. Would need either a
  frame-exact decode path or an intermediate lossless cache.
- **External display physical validation** — Output fullscreen on a real
  second monitor. Never validated on hardware.
- **Packaged Screen/Window capture QA under a stable signing identity** —
  ad-hoc signatures churn the TCC identity, so permission grants do not
  persist between packaged builds.
- **Structural parameter modulation guard** — `mosaic.columns/rows`,
  `slit-scan.strips`, `echo.copies` and `step-print.copies` are allocation
  shaping parameters that are currently continuously modulatable. Measured
  cost is acceptable today; the guard is a correctness nicety, not a bug.

## Deferred from v0.4 — Image / Motion Signals

Extracted deliberately, not forgotten. None of these is started.

**Signals**

- `motion.direction` — `atan2(y, x)` is semantically valid and awkward to map:
  an angle has a discontinuity at the wrap that every linear parameter will
  show. Needs a mapping model that understands circular data first.
- `motion.spread` — second moment around the centroid. Interesting once
  centroid workflows are in real use and ask for it.
- `image.red` / `green` / `blue`, `image.colorEnergy` — cheap to compute, and
  no evidence yet that they say anything luminance does not.

**Mapping**

- Multiply mode. Spiked during v0.4C and dropped: Add plus Set covered every
  Look, and each extra mode multiplies the composition rules.
- Richer curves than linear / exponential / logarithmic. A Bézier editor was
  explicitly rejected.
- UI for resolving multiple Set mappings on one parameter beyond the current
  `INERT` badge.
- Per-signal calibration lock (today Lock is global for the session).
- Manual calibration persistence — deliberately excluded, because storing a
  moving statistic makes an export irreproducible from a fresh open.

**Bigger**

- Signal recording / automation lanes.
- Signal-to-signal modulation (a signal shaping another signal's response).
- Anything model-based: ML vision, depth, pose or object tracking. Out of scope
  by design — Motion Centre gives positional control with no model at all.


## Deferred from v0.5 — Shader Extensibility

Extracted deliberately. None of these is started.

**Host contract**

- Multi-input shaders (a texture graph rather than one source).
- Custom vertex shaders.
- Multipass custom shaders and persistent buffers. Deliberately refused in
  v0.5: they duplicate FEEDBACK / HISTORY / SIMULATION, each of which already
  has an export-determinism story that a second system would contradict.
- Colour and vec2 parameters — both need a host control that does not exist yet.
- Shader generators as SOURCES (rather than techniques).

**Packs**

- Pack signing and provenance.
- Project dependency bundling: today a project that uses a pack needs the pack
  installed, and says so clearly when it is not.
- Hot reload on file change (RELOAD is explicit, which is the safer default).
- An online gallery or marketplace.

**ISF**

- Full ISF: multipass, persistent buffers, multiple image inputs, audio and
  event inputs, generators, `IMPORTED` media, `TIMEDELTA` / `DATE` /
  `FRAMEINDEX`.

**Tooling**

- An in-app shader editor or live GLSL coding.
- Compute shaders / WebGPU.
- Collaborative or shared packs.

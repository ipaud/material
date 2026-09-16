# Backlog

Deferred work, extracted during CE1H so nothing lives as a scattered TODO.
Nothing here is scheduled; each entry says what it is and what it depends on.

## Code debt taken on knowingly

### RenderEngine.ts — DISCHARGED in v0.6.1, with a remainder

v0.6 recorded this at 2044 lines against a house rule of 800. v0.6.1 split the
branch role out and it is now **987**:

```
LayerRuntimeImpl   933   one creative chain
LayerHost          564   the layer set
RenderEngine       987   canvas, loop, view, compositor, publication
layerRuntime       118   the contract between them
```

The point was never the line count — it was that one class played two roles,
so a host could answer a branch question. That is now impossible by
construction. See the Runtime Ownership ADR.

**What is left, and why it was not done.** `RenderEngine` is still ~190 lines
over the rule. The two cohesive seams remaining:

- **`renderStill` and the export snapshot (~170 lines).** Rendering the
  composition offscreen at an arbitrary size, with the transition A/B dance.
  Cohesive, and a plausible `StillRenderer`.
- **The view transform (~90 lines).** `view`, `fit`, `zoomTo`, `zoomAround`,
  `panBy`, `updateCamera` — pure zoom/pan maths with no GPU state.

Neither was taken in v0.6.1 because the phase had already found and fixed two
of its own regressions, and each further move spends the same equivalence
budget for no behavioural gain. Both are safe to do later against the same
gates: the v0.6.0 worktree comparison, the six content-floored fixtures, the
export preroll matrix and `probeLayers`.

### Masks — DEFERRED (v0.6C)

A mask is a second source, a second sampling rule, a mask blend, inversion and
feathering — a feature of its own size. Blend modes plus modulated opacity
cover the compositing v0.6 set out to deliver. See [LAYERS](LAYERS.md).

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
- **Export: a Look switching a layer to a file or live source** — v0.8.3
  made export follow a Look's layer stack for generator sources. A file
  source would need seek-and-decode inside the frame loop (the same schedule
  `prepareTemporalForExport` builds, per switch); a live source has no export
  class at all. Today the parameters land and the picture stays on the source
  the layer had.
- **Export: secondary-layer technique / opacity / blend from a Look** —
  `createSecondaryLayerEvaluator` is built once from the document. A Look that
  changes a non-primary layer's technique or blend exports the document's
  values. Would need the secondary evaluators to be rebuilt from
  `evaluate.layerStack()` on the same identity change `followStack` watches.

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


## v0.7 — Performance Capture

Extracted from the v0.7 spec and deliberately not built. Every one of these
would grow the Take from "a performance" toward "a timeline", which is the
line v0.7 exists to hold.

**Recording**

- Punch-in and overdub recording (v0.7 always creates a new Take).
- Loop recording and multi-cycle takes. Loop is suspended while recording,
  because a wrapped playhead writes backwards time into a monotonic lane.
- Recording structural edits: adding or deleting layers, changing sources or
  techniques, editing routing and blend mode.
- Raw MIDI Take mode — capturing device + CC rather than the resolved host
  control. It would need the device and the record-time mapping to replay.
- Recording from OSC, or to OSC/MIDI out.
- Remote-control recording.

**Takes as objects**

- Several Takes playing at once.
- Takes placed as clips on a project timeline, with offsets.
- Nested Takes.
- Takes portable between unrelated projects (v0.7 Takes belong to their
  project — see the baseline).

**Editing**

- Bézier automation and per-segment easing.
- Quantisation and beat-snapping of recorded events.
- Automation import/export as a file format.
- A generic lane for any runtime property.

**Baking**

- Baking Signals, Audio or Pattern output into a Take. This is a separate
  product decision, not a missing feature: it would trade the thing that keeps
  a Take alive — re-evaluation against whatever it is replayed over — for a
  frozen recording.

**Take editor UX**

Three findings from playing a real 71-second performance were fixed in v0.7.1
(fluid lane width, domain-scaled lanes, the playhead value on the row). What
remains, and is deliberately not built:

- Zoom or scroll inside a lane. At full window width a 71-second Take is
  legible; a ten-minute one would not be. The answer when that bites is
  probably a view window over the Take, not a scrollbar.
- Snapping a dragged event to the beat grid. It is a real convenience and it is
  also the first step toward quantised editing, which v0.7 deliberately does
  not have.

**Known debt**

- `simplifyLane` is O(n^2) in the worst case. A pathological ten-minute lane
  where every sample reverses direction takes ~7 s once, at record stop; a real
  ten-minute six-lane performance simplifies in well under a second. Not worth
  an interval tree until a real gesture provokes it.
- **A repeating deterministic morph trigger sawtooths, and it is not clear that
  is wrong.** A `bar`-sourced `morphToLook` fires every bar. In export each
  firing captures `workingCore()` *before* the previous morph is applied in the
  same frame, so the state snaps back to the original and climbs again:
  2 → 9 over one bar, then 2 → 9 again. Live has the same shape for a different
  reason — `morphRuntime.start` replaces the active morph, so the previous one
  never commits and the new one captures the uncommitted document.

  So preview and export probably agree, which is why this is a note and not a
  bug. What is unverified is whether they agree *exactly*, and whether the
  sawtooth is what anyone wants from "morph to Look 2 every bar". Worth
  measuring against a real preview before changing anything: moving the applied
  pass above `scheduler.advanceTo` would settle the state first, and would also
  change the output of every existing project that uses such a trigger.


## Resolved investigations

Kept because the reasoning is the useful part, not the conclusion.

- ~~`liveTarget.morphToLook` writes a `morphEvent` for a DETERMINISTIC trigger
  morph, which the export also re-creates from the trigger itself.~~
  **Checked, and it is harmless.** Measured with a `bar` trigger and a
  recorded event over the same window: the parameter path is identical either
  way (2 → 2.875 → 5.5 → 8.125 → 9, monotonic, no backwards step), because both
  virtual morphs interpolate between the same two states. They do not fight
  over the transition either — the trigger-created one carries
  `DEFAULT_MORPH_TRANSITION`, which is Smooth, and Smooth opens no pixel
  window, so only the recorded event's style ever reaches a frame. The original
  note called it benign without checking; the conclusion was right and the
  reasoning in it was not.

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

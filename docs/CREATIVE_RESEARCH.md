# Creative Research Notes

Working document for the Creative Expansion (CE1x). Records external
vocabulary studied, license posture, and what was deliberately taken or
rejected. No external source code enters MATERIAL from this document —
concepts only; implementations are original.

## License posture (standing rule)

- MIT / BSD / Apache / CC0: may inform implementation; original code still
  preferred.
- GPL / AGPL (TidalCycles, Hydra core, many VJ tools): conceptual study
  ONLY. Confirmed precedent: Pattern Engine v1 borrowed *ideas*
  (mini-notation vocabulary, cycle semantics) with a clean-room
  implementation — same discipline applies to all CE work.
- Unclear/proprietary (Resolume, TouchDesigner, Ghost Arcade, Fosfora):
  product vocabulary and interaction research only. No implementation
  reference available anyway.
- Shader collections (Shadertoy, GLSL sandbox): per-file licenses vary
  wildly; default is DO NOT COPY — reimplement from the underlying papers.

## CE1A — Presets (this phase)

Studied for *naming and curation language*, not code:

- Vidvox ISF collection — category discipline (generator/effect split).
- Resolume/VDMX preset culture — rejected "Effect 01..N" naming.
- Analog-video terminology (tracking, phosphor, composite) — names used
  evocatively; docs state effects are procedural, no codec/CRT emulation.
- Artistic-studies framing: categories name PRINCIPLES (DATA SYSTEMS,
  RULE-BASED SYSTEMS, LIVING MOTION, MACHINE VISION, LIGHT SYSTEMS), never
  living artists.

Ideas extracted: family-first browsing; quality bar "distinct at a
glance"; presets as *performable starting points* (modulations included).

## Queued research (later CE phases — no implementation yet)

- **Feedback (CE1B)**: classic analog video feedback literature; Hydra's
  `src(o0)` composition model (concept only — Hydra is AGPL).
- **Fields (CE1C)**: displacement-map tradition; luminance-as-time from
  slit-scan photography practice.
- **Optical flow (CE1D)**: Lucas-Kanade & Horn-Schunck papers (public
  research); pyramidal GPU implementations as architecture reference;
  neural flow (RAFT et al.) explicitly out of scope for v1.
- **Simulation (CE1E)**: Gray-Scott reaction-diffusion (Pearson 1993,
  public literature); Game of Life / birth-survival mask automata.
- **Transitions (CE1G)**: gl-transitions.com collection (individual
  transitions are MIT-licensed but the plan is original implementations of
  the *categories*: dissolve, directional, noise, radial, zoom, luma).

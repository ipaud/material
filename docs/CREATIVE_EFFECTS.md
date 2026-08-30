# Creative Effects Inventory

The canonical creative inventory for **Creative Expansion 01**. One row per
public item; cost classes and VRAM are MEASURED on a clean process, never
estimated. The machine-readable form is [inventory.json](inventory.json),
generated from the live registry — `tests/catalog.test.ts` fails if the two
drift apart.

**Creative Expansion 01 totals:** 20 techniques · 7 generator sources ·
10 morph transition styles · 107 presets.

## Primitives

| Primitive | State | VRAM (measured, 1080p) | Location |
|---|---|---|---|
| HISTORY | temporal atlas, 56 slots of 256×144 | 7.88 MB | `rendering/temporal` |
| FEEDBACK | ping-pong pair at composition resolution | 15.82 MB | `rendering/feedback` |
| FIELD | none — inline GLSL contract | 0 | `rendering/shaders/fields` |
| FLOW | luma pair + flow targets, ≤320 grid | 1.32 MB | `rendering/flow` |
| SIMULATION | seeded ping-pong state, integer stepping | per grid | `rendering/simulation` |
| TRANSITION | A snapshot, only while a reveal is open | 12.78 MB | `rendering/transition` |

Only the primitives an active technique needs are allocated, and they are
released when it stops needing them (measured: allocations equal disposals
across a 10-minute soak).

## Techniques

| Technique | Family | Primitive | Passes | Persistent state | Params | Presets | Cost |
|---|---|---|---|---|---|---|---|
| Cellular | Simulation | SIMULATION | 1 | state pair | 6 | 5 | LIGHT |
| Directional Smear | Motion | FLOW | 1 + flow | flow pair | 3 | 1 | MEDIUM |
| Echo | Time | HISTORY | 1 | atlas | 10 | 9 | LIGHT |
| Feedback Bloom | Feedback | FEEDBACK | 1 + step + blur | ping-pong | 7 | 2 | MEDIUM |
| Feedback Displace | Feedback | FEEDBACK | 1 + step | ping-pong | 6 | 2 | LIGHT |
| Feedback Drift | Feedback | FEEDBACK | 1 + step | ping-pong | 5 | 2 | LIGHT |
| Feedback Kaleido | Feedback | FEEDBACK | 1 + step | ping-pong | 6 | 2 | LIGHT |
| RGB Feedback | Feedback | FEEDBACK | 1 + step | ping-pong | 7 | 3 | LIGHT |
| Feedback Rotate | Feedback | FEEDBACK | 1 + step | ping-pong | 7 | 2 | LIGHT |
| Feedback Zoom | Feedback | FEEDBACK | 1 + step | ping-pong | 6 | 3 | LIGHT |
| Flow Displace | Motion | FLOW | 1 + flow | flow pair | 3 | 2 | MEDIUM |
| Flow Feedback | Motion | FLOW + FEEDBACK | 1 + flow + step | flow + ping-pong | 4 | 2 | MEDIUM |
| Mosaic | Space | HISTORY (tile mode) | 1 | atlas (opt) | 28 | 39 | LIGHT |
| Motion Mosh | Motion | FLOW + FEEDBACK | 1 + flow + step | flow + ping-pong | 7 | 2 | MEDIUM |
| Motion RGB | Motion | FLOW | 1 + flow | flow pair | 2 | 1 | MEDIUM |
| Motion Trails | Motion | FLOW + FEEDBACK | 1 + flow + step | flow + ping-pong | 5 | 1 | MEDIUM |
| Reaction Diffusion | Simulation | SIMULATION | 1 + 4 solver iters | state pair | 9 | 6 | MEDIUM |
| Slit Scan | Time | HISTORY | 1 | atlas | 6 | 6 | LIGHT |
| Step Print | Time | HISTORY | 1 | atlas | 8 | 5 | LIGHT |
| Time Field | Time | HISTORY + FIELD | 1 | atlas | 8 | 12 | LIGHT |
All 20 techniques are deterministic in export: repeat exports are
byte-identical, and a subrange export reproduces the same global frames as a
full export. See the determinism matrix below.

## Generator sources

| Generator | Mode | Time model | Params |
|---|---|---|---|
| Cellular | simulation | seeded stepping | 3 |
| Chladni Field | stateless | deterministic f(t) | 5 |
| Grid | stateless | deterministic f(t) | 6 |
| Noise Field | stateless | deterministic f(t) | 5 |
| Reaction Diffusion | simulation | seeded stepping | 6 |
| Voronoi | stateless | deterministic f(t) | 5 |
| Wave Interference | stateless | deterministic f(t) | 5 |
Stateless generators are pure functions of composition time, which makes them
the only fully decoder-free deterministic temporal sources in MATERIAL — every
determinism measurement in this document uses one.

## Morph transition styles

Smooth · Cut · Directional · Noise · Pixel · Radial · Zoom · Displace ·
Glitch · Luma. Full contract, goldens and the export model:
[MORPH_TRANSITIONS.md](MORPH_TRANSITIONS.md).

## Preset library

107 presets across 12 curated families: Minimal, Temporal, Optical, Geometry,
Analog, Digital Damage, Studies, Live, Performance, Feedback, Motion,
Simulation. Every preset is rendered against four reference sources during
curation (graphic grid, landscape waves, synthetic motion noise, real dance
footage) and measured for flatness and duplication — see
[PRESETS.md](PRESETS.md).

## Determinism matrix

Measured end to end on a clean process with a deterministic generator source
(no decoder involved), 160×90 @12fps. *Repeat* = two exports of the same
range. *Full vs subrange* = frames of a 1–3s export against a 2–3s export.

| System | Repeat | Full vs subrange |
|---|---|---|
| Generator (stateless) | 12/12 | 12/12 |
| Feedback | 12/12 | 12/12 |
| Time Field | 12/12 | 12/12 |
| Slit Scan | 12/12 | 12/12 |
| Echo | 12/12 | 12/12 |
| Step Print | 12/12 | 12/12 |
| Flow Displace | 12/12 | 12/12 |
| Motion Mosh | 12/12 | 12/12 |
| Flow Feedback | 12/12 | 12/12 |
| Motion Trails | 12/12 | 12/12 |
| Reaction Diffusion | 12/12 | 12/12 |
| Cellular | 12/12 | 12/12 |
| Morph transition · Noise | 12/12 | 12/12 |
| Morph transition · Radial | 12/12 | 12/12 |
| Morph transition · Glitch | 12/12 | 12/12 |
| Morph transition · Luma | 12/12 | 12/12 |
| Audio-driven (Motion Mosh, smoothed) | 12/12 | 12/12 |

All byte-identical, worst pixel delta 0.

The audio row uses the reference track (SHAZUNO-material.mp3) driving Motion
Mosh through `bass → flow` at smoothing 0.2 and `transients → blockiness`. It
is listed separately because modulation carries per-frame state of its own:
the export evaluator replays from the timeline origin so smoothing and trigger
scheduling arrive at a subrange boundary with the history a full export has.
Before that fix this row read 12/12 repeat and 0/12 subrange.

**Temporal schedule correctness is not decoder pixel stability.** Everything
above uses a procedural source. A compressed FileVideo can still return
different bytes for the same timestamp depending on the seek path taken to
reach it; that is a decoder property, not a scheduling one. MATERIAL's
temporal *schedule* is exact for video too — the same composition time asks
for the same source timestamps.

## Source capability matrix

| Source | Seekable | Deterministic | Exportable | Live | Temporal random access | Stateful |
|---|---|---|---|---|---|---|
| Image | n/a | ✓ | ✓ | — | ✓ (static) | — |
| Video | ✓ | schedule ✓, bytes decoder-bound | ✓ | — | ✓ | — |
| Camera | — | — | live only | ✓ | rolling history | — |
| Screen | — | — | live only | ✓ | rolling history | — |
| Window | — | — | live only | ✓ | rolling history | — |
| Noise Field | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Wave Interference | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Voronoi | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Grid | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Chladni Field | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Reaction Diffusion | step index | ✓ | ✓ | ✓ | — | ✓ |
| Cellular Automata | step index | ✓ | ✓ | ✓ | — | ✓ |

Live sources have no composition timeline to seek: their history is whatever
has arrived, which is why they are live-only for export.

## Performance

Measured on Apple Silicon, 1080p composition, clean process, fps as the
engine's EMA over a settled scene:

| Scene | fps | Cost class |
|---|---|---|
| Mosaic (baseline) | 119 | LIGHT |
| Feedback Zoom | 120 | LIGHT |
| Feedback Bloom | 120 | MEDIUM |
| Time Field | 120 | LIGHT |
| Slit Scan | 120 | LIGHT |
| Echo | 120 | LIGHT |
| Flow Displace | 121 | MEDIUM |
| Motion Mosh | 121 | MEDIUM |
| Directional Smear | 120 | MEDIUM |
| Reaction Diffusion | 121 | MEDIUM |
| Cellular | 120 | LIGHT |

No public technique drops the editor below high-refresh at 1080p. Cost classes
are relative GPU work, not framerate: MEDIUM techniques run extra passes
(flow, blur, solver iterations) and matter at 4K or with Output mirroring.

### Worst-case VRAM

A realistic heavy scene — live source, temporal history, optical flow, a
feedback surface and a morph reveal open at once:

| Component | MB |
|---|---|
| Feedback surface | 15.82 |
| Temporal atlas | 7.88 |
| Transition snapshot (only during a reveal) | 12.78 |
| Optical flow | 1.32 |
| **Editor peak** | **≈37.8** |
| Output window (renders locally, own targets) | ≈ same for what it uses |

The Output window renders sources and effects locally and never receives GPU
state, so its cost is its own — no pixel transport, no shared targets.

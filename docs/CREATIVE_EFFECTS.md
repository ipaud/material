# Creative Effects Inventory

The product's creative architecture map (CE1x). One row per technique;
cost classes are MEASURED, not guessed.

## Primitives

| Primitive | State | Location |
|---|---|---|
| HISTORY | temporal atlas (56×256×144, ~7.9MB) | rendering/temporal |
| FEEDBACK | ping-pong pair at composition res (~16.6MB @1080p) | rendering/feedback |
| FIELD | none — inline GLSL contract, zero passes, zero VRAM | rendering/shaders/fields |
| FLOW | luma pair + flow targets at ≤320 (~1.5MB) | rendering/flow |
| SIMULATION | seeded ping-pong state, integer stepping | rendering/simulation |

## Techniques

| Technique | Family | Primitive | Passes | Persistent | Live | Export | Cost |
|---|---|---|---|---|---|---|---|
| Mosaic | space | HISTORY (tile mode) | 1 | atlas | ✓ | ✓ det. | LIGHT |
| Echo | time | HISTORY | 1 | atlas | ✓ | ✓ det. | LIGHT |
| Step Print | time | HISTORY | 1 | atlas | ✓ | ✓ det. | LIGHT |
| Slit Scan | time | HISTORY | 1 | atlas | ✓ | ✓ det. | LIGHT |
| Feedback Zoom | feedback | FEEDBACK | 1+1 step | surface | ✓ | ✓ det. (preroll) | LIGHT (0.3ms) |
| Feedback Rotate | feedback | FEEDBACK | 1+1 | surface | ✓ | ✓ det. | LIGHT |
| Feedback Drift | feedback | FEEDBACK | 1+1 | surface | ✓ | ✓ det. | LIGHT |
| Feedback Displace | feedback | FEEDBACK | 1+1 | surface | ✓ | ✓ det. | LIGHT (0.2ms) |
| Feedback Kaleido | feedback | FEEDBACK | 1+1 | surface | ✓ | ✓ det. | LIGHT |
| Feedback Bloom | feedback | FEEDBACK +4 bloom | 1+5 | surface+3 aux | ✓ | ✓ det. | MEDIUM (0.3ms) |
| RGB Feedback | feedback | FEEDBACK | 1+1 | surface | ✓ | ✓ det. | LIGHT (0.1ms) |
| Time Field | time | FIELD + HISTORY | 1 | atlas only | ✓ | ✓ det.¹ | LIGHT (120fps all 7 modes) |

All feedback params (persistence/injection/mix + per-variant) are standard
definitions: Pattern/audio/beat/MIDI/macros modulate them with no special
branches. Measured on M-series @1080p comp: every feedback technique holds
120fps in the editor (frame 0.1–0.3ms after the pixelRatio fix).

¹ File-video temporal export: repeated exports hash identically; a
SUBRANGE export's bytes can differ from the same global frames of a
full-range export because H.264 hardware decode is not bit-stable across
different seek paths (pre-existing pipeline behavior — measured identical
on Slit Scan; the temporal SCHEDULE is exact in both).

| Reaction Diffusion | image | SIMULATION | 1 + 4 solver iters | state pair | ✓ (as source influence) | ✓ det. | MEDIUM (120fps) |
| Cellular | image | SIMULATION | 1 | state pair | ✓ (tint) | ✓ det. | LIGHT (120fps) |

## Morph transitions (CE1G)

Ten pixel transition styles, applied at the identity switch of a
cross-technique morph (or across the whole morph when both sides share a
technique). `smooth` is the default and reproduces v0.3 exactly.

| Style | Passes | VRAM | Deterministic | Cost |
|---|---|---|---|---|
| smooth | 0 (no snapshot) | 0 | ✓ | free |
| cut / directional / noise / pixel / radial | 1 composite | 1 RGBA8 snapshot (12.8 MB @ retina 1080p canvas) | ✓ | LIGHT |
| zoom / displace / glitch / luma | 1 composite | same | ✓ | LIGHT |

The snapshot exists only while the reveal is open (allocations = disposals,
verified live). Full detail, goldens and the export contract:
[MORPH_TRANSITIONS.md](MORPH_TRANSITIONS.md).

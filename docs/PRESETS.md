# Preset Library (CE1A)

60 curated system presets across 9 families, built entirely on the four
existing techniques (Mosaic, Echo, Step Print, Slit Scan), the six builtin
materials, color modes, and the existing modulation vocabulary (audio,
beat, time). No new shader infrastructure — CE1A extracts creative value
from what the engine already does.

## Families

CE1B added **Feedback** (16 presets over the seven feedback techniques —
Infinite Tunnel, Spiral Echo, Boiling Wall, Living Mandala, Phosphor
Bloom, Channel Ghost…). Melt shipped as a *preset* of Feedback Displace
(Slow Melt), not an eighth technique — it was a parameter sibling (§38).


| Family | Count | Character |
|---|---|---|
| Minimal | 5 | Reduction, restraint, near-silence |
| Temporal | 12 | The temporal atlas as visible material |
| Optical | 5 | Lenses, prisms, halftone, depth |
| Geometry | 5 | Shape grids, lattices, rotation systems |
| Analog | 6 | Scanlines, tape, phosphor — procedural, honestly named |
| Digital Damage | 10 | Dropouts, tears, stutter — procedural, no real codec corruption |
| Studies | 7 | Artistic principles as categories (DATA / RULE-BASED / LIVING MOTION / MACHINE VISION / LIGHT SYSTEMS) — never artist names |
| Live | 4 | Designed for Camera/Screen input (trails, delay, presence, light-painting) |
| Performance | 7 | Audio/beat-modulated, made to be played |

## Application semantics

A preset applies over the technique's **defaults** (CE1A change): the same
preset produces the same image from any prior state. User-saved presets
capture the full parameter record and are unaffected.

Modulation targets in presets are bare parameter ids (the runtime resolves
them against the active technique). Presets never reference project-local
resources: no `pattern:` sources, no custom material asset paths — a
preset must be self-contained in any project.

## Curation record

~80 candidates were sketched; 49 new shipped (+11 pre-existing
recategorized = 60). Notable rejections and why:

- **Temporal Grid, Corrupted Feed, Concentric, Vector Study, Aperture,
  Tape Ghost** — parameter-sibling twins of Time Fracture, Broken Codec,
  Time Rings, Line Weave, Halftone, Ghost Frame.
- **CRT Amber** (slider variation of a mono phosphor look — color tinting
  isn't a real parameter yet), **CRT Green** renamed **Phosphor Grid**
  (honest: MATERIAL has no green tint control).
- **Late Night TV, Soft Sync, Riser** — required an LFO-shaped source that
  doesn't exist; `time` is a ramp and made them feel broken.
- **Camera Memory** — indistinct from Time Curtain on live input; replaced
  by **Slow Shutter** (additive light-painting, genuinely different).
- **Whisper, Frame Echo, Orbit** — final trim from 63 to 60: weakest of
  their families (sparse-grid sibling, Step-Print sibling of Frame
  Cascade, radial-echo sibling of Prism Row).

## Validation

`tests/preset-library.test.ts` validates the entire catalog mechanically:
schema parse, unique ids/names, canonical categories, every parameter
inside its definition range, select values legal, modulation sources real,
targets numeric and existing, materials builtin, no near-identical twins.
A drifting preset cannot ship silently.

## Curation methodology (CE1H)

The library is curated by LOOKING at it, not by reading parameter tables.
`window.__dev.presetSheet(atSec, cell)` renders every preset against the
current source and tiles the results into one contact sheet; the pass is run
against four reference sources so no preset is judged on the one clip it was
authored against:

| Reference | Covers |
|---|---|
| Grid generator | graphic / hard geometry |
| Wave Interference generator | landscape / smooth gradient |
| Noise Field generator | live-like synthetic motion |
| Real dance footage | human subject, real motion, real grain |

Two things about the harness are load-bearing, because both produced
confident wrong answers first:

1. **Tiles go through the export preparation path.** A bare `renderStill`
   primes no frame history, no feedback surface and no flow pair, so every
   temporal preset renders the same bare frame. The first sheet reported 292
   "duplicate" pairs that were entirely an artifact of this.
2. **Duplicate comparisons use full-resolution tiles.** Downscaled thumbnails
   average out high-frequency texture: Coral and Worm Field are identical at
   32×18 and differ by 204 at full resolution.

Signals the sheet is looking for: flat or blown tiles (a preset with no
spatial variance is dead or saturated), presets that render identically to
each other, presets that ignore the source entirely, and presets that are
still empty at the capture time (a warm-up problem, not a look).

### CE1H outcome

108 presets in, 107 out.

- **Removed — Single Line.** Slit Scan at 2 strips with interpolation is
  mathematically Time Field horizontal; it rendered byte-identical to Deep
  Curtain on all four sources. Signal Tear already covers the low-strip
  territory, and the name described something the preset never did.
- **Retuned — Memory Leak.** 36 additive copies at decay 0.985 saturated to
  pure white on every source.
- **Retuned — Field of Dots.** Dots too small against too much gap; mean
  luminance 3–10 out of 255.
- **Retuned — Chemical Bloom.** Its feed/kill pair sat in the dying region of
  Gray-Scott — dark, and crowding Coral. Moved to unused low-feed/low-kill
  territory.

After the pass: zero flat-or-blown presets, zero full-resolution duplicate
pairs. `tests/catalog.test.ts` holds the retuned values and asserts that every
Reaction Diffusion preset occupies a distinct Gray-Scott regime.

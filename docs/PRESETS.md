# Preset Library (CE1A)

60 curated system presets across 9 families, built entirely on the four
existing techniques (Mosaic, Echo, Step Print, Slit Scan), the six builtin
materials, color modes, and the existing modulation vocabulary (audio,
beat, time). No new shader infrastructure — CE1A extracts creative value
from what the engine already does.

## Families

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

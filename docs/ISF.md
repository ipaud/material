# ISF compatibility

MATERIAL hosts an **ISF single-pass image-filter subset**. That phrase is the
accurate one, and it is used deliberately in place of "ISF compatible".

An ISF file that fits the subset is converted **once, at import**, into an
ordinary MATERIAL shader pack. From that moment it is not an ISF shader being
adapted per frame — it is a pack shader, with the same lifecycle, the same
parameters, the same modulation, the same Output replication and the same
export path as anything else. Nothing downstream knows where it came from.

## Compatibility matrix

| Feature | Supported | Notes |
|---|---|---|
| Single pass | ✅ | the whole subset |
| One image input | ✅ | mapped to the technique's source frame |
| `float` input | ✅ | MIN/MAX/DEFAULT → a slider |
| `bool` input | ✅ | → a toggle |
| `long` input | ✅ | VALUES/LABELS → a menu; the shader receives its own numbers, not indices |
| `TIME` | ✅ | MATERIAL composition time — deterministic, exportable |
| `RENDERSIZE` | ✅ | real render size |
| `isf_FragNormCoord` | ✅ | → `vUv`, 0..1 |
| `IMG_PIXEL` / `IMG_NORM_PIXEL` | ✅ | |
| `IMG_THIS_PIXEL` / `IMG_THIS_NORM_PIXEL` | ✅ | |
| `IMG_SIZE` | ✅ | |
| `gl_FragColor`, `texture2D`, `varying` | ✅ | bridged by the compatibility prelude |
| `PASSINDEX` | ✅ (always 0) | exists so shaders that branch on it compile |
| `DESCRIPTION`, `CREDIT` | ✅ | carried into the pack |
| **MULTIPASS (`PASSES`)** | ❌ | refused by name |
| **PERSISTENT buffers** | ❌ | refused by name |
| **Multiple image inputs** | ❌ | refused by name |
| **Generators (no image input)** | ❌ | refused by name |
| `audio` / `audioFFT` inputs | ❌ | refused by name |
| `event` inputs | ❌ | refused by name |
| `color` inputs | ❌ | refused by name — no host control maps to it yet |
| `point2D` inputs | ❌ | refused by name |
| `IMPORTED` media | ❌ | refused by name |
| `TIMEDELTA`, `DATE`, `FRAMEINDEX` | ❌ | not provided |

## Why the line is drawn there

**Multipass and persistent buffers are not missing features — they are a
different system.** They need multiple render targets, per-pass sizing, a
lifecycle, export preroll and VRAM accounting. MATERIAL already has primitives
for exactly that shape of problem — FEEDBACK, HISTORY, SIMULATION — each with
its own determinism story. A second, parallel one imported from a file format
would be two systems disagreeing about the same thing, and the one that would
lose is export determinism.

**Multiple image inputs** would mean widening the host contract from one source
texture to a texture graph, which is a product decision, not a compatibility
one.

**Audio inputs** fit MATERIAL badly on purpose: audio here is an analysed signal
that drives parameters, which is more useful than a texture of samples and
already works on any pack parameter.

**Generators** have no image input. MATERIAL already has generator *sources*,
and a technique that ignores its input is a different shape of thing.

## Refusals are by name

An import that cannot be honoured says which ISF feature stopped it:

```
unsupported ISF feature: MULTIPASS (2 PASSES)
unsupported ISF feature: PERSISTENT_BUFFER
unsupported ISF feature: MULTIPLE_IMAGE_INPUTS (2)
unsupported ISF feature: GENERATOR (no image input) — v0.5 hosts image filters
input 'levels': ISF type 'audioFFT' is not supported
```

There is no partial multipass support anywhere: a file declaring `PASSES` is
refused, never quietly rendered as its first pass — which would look like it
worked.

## How the conversion works

A compatibility **prelude**, not a compiler. ISF's automatic variables and
`IMG_*` helpers become `#define`s and small functions over uniforms the host
already provides, and the ISF file's own source is passed through untouched.
The fewer edits made to a shader nobody here wrote, the fewer ways to break it.

Line numbers survive: the metadata comment is replaced by blank lines, and the
prelude ends with `#line 1`, so a compiler error lands on the line of the `.fs`
file the author wrote.

## Determinism

An imported ISF shader exports like any other technique. Measured on
`time-pulse.fs`, whose brightness is driven entirely by `TIME`:

| gate | result |
|---|---|
| repeat | **12/12** |
| full vs subrange | **12/12** |
| distinct frames | **24/24** — TIME genuinely advances |
| anti-noop, `rate` at 0 | **12/12** |
| anti-noop vs a different shader | **12/12** |

## Licensing

The fixtures in `tests/fixtures/isf/` are original, written for this repository.
No third-party ISF shaders are bundled. Importing someone else's ISF file
copies it into your own managed pack folder; its licence is between you and its
author.

# Shader Contract v1

MATERIAL can host shaders it did not ship. The principle the whole design
serves:

> **Extend the visual language without handing over the application.**

A shader receives a bounded visual contract — a source image, where it is on
screen, what time it is, and its own declared parameters. It does not receive
the filesystem, Electron, Node, the DOM, app state, IPC, other shaders or any
renderer internal, because nothing in the design creates a bridge to them.

A shader pack is **data + GLSL + metadata**. There is no JavaScript, no HTML and
no CSS anywhere in the format, and nothing in a pack is ever executed as code.

## The minimal shader

```glsl
void main() {
  fragColor = texture(uMaterial_source, vUv);
}
```

That is a complete, valid pack shader. You write the body; MATERIAL writes the
declarations.

## What the host provides

```glsl
uniform sampler2D uMaterial_source;      // the frame this technique receives
uniform vec2      uMaterial_resolution;  // render size, in pixels
uniform float     uMaterial_time;        // COMPOSITION time, in seconds
uniform float     uMaterial_seed;        // deterministic, from the project
uniform float     uMaterial_aspect;      // resolution.x / resolution.y

in  vec2 vUv;                            // 0..1, (0,0) is the BOTTOM-LEFT
out vec4 fragColor;
```

Plus one `uParam_<id>` for every parameter your manifest declares.

**Do not redeclare any of these.** The host already has, and a redeclaration is
refused with a clear message rather than a driver log.

| Detail | Value |
|---|---|
| GLSL version | ES 3.00 (`#version 300 es`, written by the host) |
| Vertex shader | owned by MATERIAL, not overridable in v0.5 |
| Source textures | exactly one |
| UV origin | bottom-left, `vUv` ∈ [0,1]² |
| Output | `fragColor`, one attachment |
| Passes | one |

### `uMaterial_time` is composition time

Not a wall clock. The same time, the same parameters and the same source
produce the same pixels — which is what lets a shader-driven project export
deterministically, and lets a rendered frame match the preview at that
timestamp.

### `uMaterial_seed` is the project's seed

If you need randomness, derive it from position, time and this. Never expect a
per-frame random source: there isn't one, deliberately.

## Parameters

Declared in the manifest, rendered by MATERIAL, and available to your shader as
`uParam_<id>`:

| Type | GLSL | Notes |
|---|---|---|
| `float` | `float` | `min`, `max` required; `step` optional |
| `int` | `int` | `min`, `max` required |
| `bool` | `bool` | |
| `enum` | `int` | receives its option's index, or the option's `glslValue` |

Ranges are mandatory: an unbounded slider is not a control. The host validates
each definition as a whole — `min <= max`, the default inside its own range,
an enum default that is one of its options — and clamps an unreasonable range
into something a control can express.

Every numeric parameter is automatically a **modulation target**, so audio,
patterns, beat, MIDI and the image/motion signals can all drive it with no
work from the pack. It is captured by Looks, interpolated by Morph and
mutated by Explore for the same reason.

**Moving a parameter never recompiles anything.** Only a change to the shader's
source or its parameter contract does.

## Groups

A parameter declares which inspector section it lands in: `Structure`, `Time`,
`Motion`, `Color` or `Mix`. Packs choose from the product's list rather than
inventing sections, so two packs lay out consistently.

## When something is wrong

**A compile error** names the shader and reports the compiler's own message at
**the line you wrote** — the host resets the line counter after its prelude, so
there is no offset to work out. While a revision is broken, the last version
that compiled keeps rendering. A missing semicolon does not black out a live
performance.

**A missing pack** — a project opened on a machine where it is not installed —
passes the frame through untouched and says which pack and shader are missing.
Your parameter values are preserved and come back when the pack does. MATERIAL
never substitutes a different shader.

## What this is NOT

**It is not a sandbox.** GLSL that compiles can still be expensive, and no
host-side text check can change that. MATERIAL refuses the obvious accidents —
`while (true)`, `for(;;)`, a redeclared host identifier, a pack-chosen `#version`
— and bounds source size and parameter count. It cannot bound what a
well-formed shader asks the GPU to do. A pathological shader can still stall or
crash the graphics context; MATERIAL recovers by rebuilding from the stored
definition, but the frames in between are gone.

Install packs the way you would install anything else: from people you trust.

## Not in v0.5

Custom vertex shaders · multiple texture inputs · multipass · persistent
buffers · colour and vec2 parameters · shader-supplied UI · pack signing.

See [SHADER_PACKS.md](SHADER_PACKS.md) to author one, and [ISF.md](ISF.md) for
the ISF subset.

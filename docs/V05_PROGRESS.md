# v0.5 — Shader Extensibility

The principle every phase serves: **extend the visual language without handing
over the application.** A shader receives a bounded visual contract — a source
image, where it is, what time it is, and its own declared parameters. It does
not receive the filesystem, Electron, Node, the DOM, app state, IPC, other
shaders or any renderer internal, because nothing in the design creates a
bridge to them.

## A — Shader Contract v1 and the safe runtime

### Decisions

**A pack is DATA + GLSL + METADATA. There is no JavaScript.** The manifest
schema has no field for a script, an entry point, a module or markup, and a
test asserts it stays that way. Everything a pack can do, it does by declaring
parameters the host renders and drives itself.

**MATERIAL owns the vertex shader.** A custom shader is fragment-only. That
keeps the surface small enough to keep compatible, and it means a pack cannot
change where the quad is or what `vUv` means.

**MATERIAL owns a prelude, and a pack writes only its own code.** The host
declares the uniforms, `in vec2 vUv` and `out vec4 fragColor`; the pack file
contains helpers and `void main()`. Two things follow: a pack cannot get the
declarations subtly wrong, and because the host knows exactly how many lines it
added, a compiler error is reported at the line the AUTHOR wrote.

**Custom shaders are ordinary `TechniqueDefinition`s.** There is no second
rendering universe. Once a pack shader is a technique, the inspector renders
its parameters, modulation accepts them as targets, Explore mutates them, Looks
capture them, Morph interpolates them and the Output instantiates it — with no
shader-specific code in any of those systems. If that ever stops being true,
the abstraction is wrong and the fix belongs in the host.

**Two reserved namespaces.** `uMaterial_*` for the host, `uParam_*` for pack
parameters. Ids are schema-validated as GLSL identifiers, so a generated
uniform name cannot be anything but legal.

**A missing pack yields a pass-through that says what is missing.**
Substituting a different shader would be worse than showing nothing: the
project would look wrong while appearing to work, and stored parameter values
would be silently reinterpreted against a contract that is not theirs.

**Deterministic time and seed.** `uMaterial_time` is composition time and
`uMaterial_seed` comes from the project. No wall clock, no `Math.random`, both
asserted structurally.

**Rejected for A:** custom vertex shaders, extra texture inputs, multipass,
arbitrary parameter structs, and any promise of a GPU sandbox.

### Contract v1

```glsl
uniform sampler2D uMaterial_source;    // the frame this technique receives
uniform vec2      uMaterial_resolution;
uniform float     uMaterial_time;      // COMPOSITION seconds
uniform float     uMaterial_seed;
uniform float     uMaterial_aspect;
in  vec2 vUv;                          // 0..1, (0,0) BOTTOM-LEFT
out vec4 fragColor;
// plus one uParam_<id> per declared parameter
```

GLSL ES 3.00, matching what every native technique in the repo already
compiles to.

### GPU goldens — clean process, product path, all green

| gate | asserts | measured |
|---|---|---|
| **identity** | the harness can reproduce its own input | **maxDiff 0** |
| invert | the host is not feeding a blank source | exact complement |
| **uv** | 0..1 with (0,0) bottom-left | corners (2,2) and (253,253) |
| time | deterministic and actually advancing | repeat bit-identical, differs across t |
| seed | deterministic | bit-identical |
| param | a declared parameter reaches its uniform | 0 → 0, 1 → 255 |
| resolution | the real size, not a hardcoded one | 32 → 16, 64 → 32 |
| **compile error** | caught, readable, in the author's numbering | `line 2: 'nope' : undeclared identifier` |
| **last-known-good** | a broken edit does not black out the output | ok → error, material retained |
| **no recompile** | a slider move is a uniform write | 20 moves, programs 1 → 1 |

### Export

Deterministic generator source, Soft Warp (time-driven, so a stalled clock
would show immediately):

| gate | result |
|---|---|
| repeat | **12/12** |
| full vs subrange | **12/12** |
| distinct frames | **24/24** |
| anti-noop vs a native technique | **12/12** |
| anti-noop vs the same shader at amount 0 | **12/12** |

### Runtime and cost

| configuration | fps | programs | textures | geometries |
|---|---|---|---|---|
| native mosaic (baseline) | 120 | 2 | 1 | 2 |
| custom Posterise | 119.9 | 2 | 1 | 2 |
| custom Soft Warp | 120 | 2 | 1 | 2 |
| custom Grain Field | 120 | 2 | 1 | 2 |

A custom shader costs what a native one-pass technique costs.

**Context loss** with a custom shader active: recovers, programs 2 → 2, GL
errors 0, still rendering.

**210 technique switches** mixing native and custom, starting and ending on the
same technique: programs 2 → 2, geometries 2 → 2, textures 1 → 1.

### Output

Shader definitions ride `RenderInputs` — low frequency, project-shaped. The
replica registers them in its own pack registry and compiles locally, caching
by hash so a repeated message costs nothing. No compiled program and no pixel
crosses the channel, and the replica still evaluates no modulation, no signals
and no patterns.

The set sent is the project's reach: the active technique plus every pinned
Look. Sending only the active one would break the moment a morph switched the
Output's technique id, which happens without any project change to ride along.

### Known debt

- Packs are bundled only; filesystem install is B.
- The starter pack is six shaders and has not been curated against a contact
  sheet yet (E).
- No UI for browsing or managing packs yet (B).

### Gate

Tests 1195 / 70 files · typecheck · lint · build · GPU goldens · export matrix ·
context restore · churn.

**Safe to proceed to B.**

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

## B — local shader packs

### Decisions

**Managed storage, never the folder you picked.** Import copies into
`~/Library/Application Support/material/shader-packs/<packId>/`. Running from
wherever the user happened to leave a download would make the app's behaviour
depend on a directory it does not control.

**Install copies the DECLARED FILES ONLY.** The manifest and the shaders it
names — not a mirror of the folder. An allow-list of files falls out of that
for free, and nothing incidental (a stray binary, a symlink, a `node_modules`)
can ride along. Reinstalling replaces wholesale, so a shader deleted between
versions cannot linger.

**All filesystem work is in the main process.** The renderer asks for packs and
receives validated data. It has no path API, no `fs`, and no way to name a file
— the only paths ever opened are the ones a manifest declared, resolved, and
then re-checked.

**Two independent path checks, because they catch different things.** The
lexical one refuses `..` and absolute paths before touching the disk. The
`realpath` one refuses a symlink pointing outside — which passes every lexical
check and looks entirely innocent until it is followed.

**A pack id cannot shadow a built-in.** An installed pack claiming
`material.starter` is ignored with a warning, or a project could silently
render a different shader than the one it names.

**Loading is eager, compiling is lazy.** Startup reads manifests and holds GLSL
text; nothing reaches the GPU until a shader is selected. Fifty installed
shaders cost fifty strings, not fifty programs.

### The contract weakness B found

An adversarial fixture declared `min: 1, max: 0, default: 5`. Every field was
individually valid and the schema accepted it, which would have produced a
control with no valid position.

Per the loop rule the fix went back to **A**, into the contract: parameter
definitions are now validated as a whole — `min <= max`, the default inside its
own range, and an enum default that is actually one of its options. Fixing it in
the loader that noticed would have left the next loader to find it again.

### Security fixtures — all refused, none crash

| fixture | result |
|---|---|
| `../outside.frag` | refused by the schema, never reaches disk |
| absolute `/etc/hosts` | refused |
| **symlink to a file outside the pack** | refused: "resolves outside the pack" |
| `removeShaderPack('../..')` and friends | refused; the real pack survives |
| manifest that is not JSON | refused, with the parser's own message |
| missing id / no shaders / bad semver | refused |
| wrong `materialShaderVersion` | refused |
| duplicate shader ids | refused |
| `min > max`, default out of range, NaN default | refused |
| enum with one option | refused |
| declared file that does not exist | refused: "no usable shaders" |
| shader source over 256 KB | refused: "exceeds" |

Structural: the preload exposes pack data and no path API; the import dialog
belongs to main; the loader uses no `eval`, no `Function`, no `child_process`.

### Live

A pack placed in managed storage next to a **deliberately broken one**:

| observation | result |
|---|---|
| broken pack | reports its JSON error, contributes 0 shaders |
| good pack alongside it | loads, 1 shader, no warnings |
| startup | unaffected — a bad pack cannot brick it |
| rendering the imported shader | 120 fps, no compile error, 2 programs |
| removing the pack | project keeps `{hue: 0.2, strength: 0.5}` and keeps rendering |

### Starter pack

Six shaders — Soft Warp, Scan Bands, Posterise, Ripple, Chromatic Shift, Grain
Field — written in the same on-disk format an author would use, and loaded
through the same manifest schema and host contract as anything imported. If the
format is awkward to author, it is awkward here first. Curation against a
contact sheet is E's job.

### Known debt

- Import is folder-only; there is no archive format.
- No hot reload on file change; RELOAD is explicit, which is the safer default.
- No pack signing and no dependency bundling — both in the backlog.

### Gate

Tests 1221 / 72 files · typecheck · lint · build · security fixtures · live
install/render/remove.

**Safe to proceed to C.**

## C — parameter metadata, signals and modulation

### Decisions

**Almost nothing was built.** That was the point of A's shape: a pack shader is
a `TechniqueDefinition`, so the inspector, modulation, signals, patterns,
Explore, Looks and Morph already accepted it. C's real job was to VERIFY that
claim and fix the two places where it did not hold — not to add integration
code, which would have meant the abstraction was wrong.

**Pack presets are params only.** The manifest may declare presets and they
become ordinary presets for their own technique. They carry no modulations and
no triggers: a pack preset that shipped mappings would name signals and targets
belonging to the host, break whenever either changed, and let a pack write into
parts of a document it has no business touching.

**Preset values are validated against the shader's own parameters.** A value
outside the declared range is clamped; a key the shader does not declare is
dropped. A manifest is data from outside the app and is treated that way even
when it came from the same author as the shader.

**No pack-supplied UI, ever.** No React, no HTML, no CSS — a test asserts the
schema has nowhere to put any of it. Every control is generated by the host
from the parameter metadata, which is what keeps a pack's surface to data.

### Measured

**Signals drive pack parameters with no shader-specific code.**
`motion.centroidX/Y → Set → ripple centre`, `image.luminance → Add → amount`,
`pattern → frequency`, all at once:

| target | driven by | span over 25 samples |
|---|---|---|
| `centerX` | motion.centroidX (Set 0.2–0.8) | 0.018 |
| `centerY` | motion.centroidY (Set, inverted) | 0.020 |
| `amount` | image.luminance (Add) | 0.056 |
| `frequency` | pattern sequence | **23.6** |

Centroid spans are small because the fixture is a uniform-motion generator,
which correctly has no centre of motion — the same reading v0.4D recorded for
Body Follow, for the same reason.

**Parameter count does not cost frame rate:**

| declared params | fps | programs |
|---|---|---|
| 4 | 120.3 | 2 |
| 16 | 120.0 | 2 |
| 32 | 120.0 | 2 |

**A slider move never recompiles.** 40 parameter changes on one shader: programs
3 → 3. 40 switches between two custom shaders: settles back to 2.

One reading needed explaining rather than fixing: a session with motion signals
mapped shows ~10 programs. That is v0.4's optical flow and reduction ladder
being awake, not shader leakage — with no signals mapped the same scene sits at
2–3.

### Tests

15 integration tests: registration into the shared registry, removal turning an
id MISSING while a project keeps rendering, a pack version dropping a deleted
shader, Add and Set on custom params in the parameter's own units, a centred
signal at rest contributing exactly nothing, the Set conflict rule, absence as
neutral, pack presets being params-only, out-of-range preset values clamped,
unknown keys dropped, and four structural gates asserting no feature had to
learn about shaders.

### Known debt

- `time` reads 0 on a project with no audio, so a `time → param` mapping is
  flat there. Pre-existing transport behaviour, unrelated to shaders.
- Explore mutation of custom params is exercised only through the shared
  mutation code path; there is no shader-specific Explore test.

### Gate

Tests 1236 / 73 files · typecheck · lint · build · flagship workflow · cost flat
in parameter count.

**Safe to proceed to D.**

## D — ISF single-pass subset

### Decisions

**Convert at import, not at render.** An accepted ISF file becomes an ordinary
MATERIAL pack — manifest, GLSL, managed storage — and from that point nothing
downstream knows where it came from. That reuses B's security, lifecycle,
Output replication and export path wholesale, and it is the test of whether A's
abstraction was the right one. It was: the renderer contains no ISF code path,
asserted structurally.

**A compatibility prelude, not a compiler.** ISF's automatic variables and
`IMG_*` helpers become `#define`s and small functions over uniforms the host
already provides; the ISF source is passed through untouched. Fewer edits to a
shader nobody here wrote means fewer ways to break it.

**Refusals are by NAME.** MULTIPASS, PERSISTENT_BUFFER, MULTIPLE_IMAGE_INPUTS,
GENERATOR, and each unsupported input type. "It did not load" is not something
a user can act on.

**No partial multipass.** A file declaring `PASSES` is refused rather than
rendered as its first pass — which would look like it worked. `PASSINDEX`
exists as a constant 0 only so shaders that branch on it compile.

**Deferred deliberately:** `color` and `point2D` inputs. MATERIAL has no colour
or vec2 control, and inventing one to satisfy a file format is the wrong order
of operations. Refused by name until a host control exists.

Full matrix in [ISF.md](ISF.md).

### Two defects the live run found

Both were adapter bugs, fixed in the adapter, with the host untouched.

**A duplicate fragment output.** The host prelude already declares the single
`out vec4 fragColor`; the ISF prelude declared its own, and every import failed
with *"must explicitly specify all locations when using multiple fragment
outputs"*. ISF's `gl_FragColor` is the host's own output under another name.

**ISF input names were never bound to their uniforms.** A shader references
`level`; the host generates `uParam_level`. Every input read as an undeclared
identifier. The adapter now emits one `#define` per input.

### One host improvement they prompted

Compile errors were being mapped by arithmetic — subtract the prelude length —
which the ISF adapter's own prelude then broke. The host prelude now ends with
`#line 1`, so the compiler numbers the author's file from 1 with no arithmetic
anywhere, and an adapter that prepends its own prelude resets it again.

That also exposed a real bug in the static checks: the reserved-identifier
search was source-wide, so `[^;]*` ran across newlines and a prelude full of
perfectly legal `#define RENDERSIZE uMaterial_resolution` lines read as four
redeclarations at once. The check is now line-anchored, with a test for both
directions.

### Measured

Three fixtures imported and rendered:

| fixture | exercises | result |
|---|---|---|
| `identity.fs` | `IMG_THIS_PIXEL`, `gl_FragColor` | compiles, 119 fps |
| `controls.fs` | float, bool, `long` with VALUES `[0, 3, 7]` | compiles, 120 fps, all three params |
| `time-pulse.fs` | `TIME`, `RENDERSIZE` | compiles, 119 fps |

Export, on `time-pulse.fs`:

| gate | result |
|---|---|
| repeat | **12/12** |
| full vs subrange | **12/12** |
| distinct frames | **24/24** |
| anti-noop (`rate` 0) | **12/12** |
| anti-noop (different shader) | **12/12** |

Unsupported fixtures — multipass, persistent, generator, two images, audioFFT —
all refused, each naming its own feature.

### Known debt

- `color` and `point2D` inputs are refused; a colour control is a host feature
  v0.5 does not have.
- No real-world third-party ISF files are bundled: the fixtures are original,
  so licensing is unambiguous.

### Gate

Tests 1258 / 75 files · typecheck · lint · build · ISF export matrix · every
unsupported feature refused by name.

**Safe to proceed to E.**

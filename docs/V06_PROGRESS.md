# v0.6 — Layer Composition: progress

One MATERIAL composition can hold several visual materials at once. Not a
timeline, not a node graph, not an NLE — a small stack of layers, each a
complete instrument, played together.

Phases: **A** contract + compositor · B routing + shared signals · C blend,
mask, layer modulation · D performance UX · E export, QA, release.

---

## A — Layer contract + compositor core

Status: **complete**. Schema v4 ships with migration, every branch renders,
and single-layer output is byte-identical to v0.5.0.

### Decisions

| Question | Decision | Why |
|---|---|---|
| What is a layer at runtime? | A `RenderEngine` in **branch mode** | Reuse, not fork. A branch owns one creative chain — source, generator, temporal history, flow, technique, analysis, feedback — and owns no canvas, loop or view. Two implementations of the chain would drift within a release. |
| Layer identity | The layer **id**, never the index | Reordering must rebuild nothing: a feedback surface or a simulation survives being moved up the stack. |
| Layer cap | **4** (`MAX_LAYERS`) | Measured, not guessed — see the ladder below. Four heavy layers hold vsync at 1080p, so the cap is an instrument decision rather than a performance one. |
| Schema | **v4**, with v3→v4 migration | A layer owns a source, a technique and a material; those were project-wide in v3. Migration is invisible: `composition.sourceId` + `techniques[0]` + `material` become `layers[0]`, whose id is the fixed `layer_1`. |
| Source ownership | The **layer** owns `sourceId` | `composition.sourceId` stays as the project-wide anchor (frame size, migration), and `withSelectedSource` moves both together. A layer with `sourceId: null` renders nothing and does **not** fall back. |
| Alpha in layer targets | **Premultiplied** | What the GPU produces. The compositor un-premultiplies before blending, because the blend functions are defined on colour, not on colour already scaled by its own coverage. |
| Layer clear colour | Transparent **black** | The background belongs to the composition. A layer that painted it would erase everything beneath. |
| Visual signals, N layers | The **selected** layer is measured | Preserves the v0.5 meaning of a visual signal exactly for one layer. Explicit per-layer routing is B's job. |

### What exists

- `shared/schemas/project.ts` — `layerSchema`, `MAX_LAYERS`, `blendModeSchema`,
  `MIGRATED_LAYER_ID`, `selectedLayerOf`, `withSelectedTechnique`,
  `withSelectedSource`, `emptyLayer`, `migrateV3toV4`.
- `src/rendering/layers/LayerCompositor.ts` — the single compositing stage.
  Two accumulators, ping-ponged, whatever the layer count. Seven blend modes
  with a CPU mirror (`blendChannel`, `compositeChannel`) the goldens check
  against.
- `src/rendering/layers/layerDiagnostics.ts` — `runLayerGoldens` (blend maths)
  and `probeLayers` (what each branch actually drew).
- `src/rendering/bindTarget.ts` — one documented place for how to bind an
  offscreen target, and why neither `setViewport` nor `setPixelRatio` belongs
  after it.
- `src/projects/layerActions.ts` — add, delete, select, move, update, opacity,
  blend, enable, duplicate.
- `src/rendering/engineBridge.ts` — reconciles **per layer**. The module-wide
  source/technique singletons are gone, so one layer's source change cannot
  reset another's.

### Gates

| Gate | Result |
|---|---|
| Compositor goldens (order, opacity, transparency, 7 blend modes vs CPU mirror, accumulator count) | `allOk` |
| v0.4 reduction-ladder goldens | `allOk` |
| v0.5 shader host goldens | `allOk` |
| Transition goldens | endpoints exact, monotonic, deterministic |
| **Single-layer identity vs v0.5.0** | **byte-identical** — 3/3 stills and 3/3 generator frames, hashes equal at t = 0, 1.5, 3.25 |
| v0.4 export: repeat | byte-identical |
| v0.4 export: full vs subrange | 12/12 frames identical |
| v0.4 export: anti-noop | 12/12 differ, × 3 signals |
| Suite / lint / typecheck / build | 1289 tests, all clean |

The identity gate is run against a real v0.5.0 worktree, and it reports the
non-black pixel count and mean alongside the hash. That matters: an earlier
version of this gate compared a black frame to a black frame and passed.

### Performance (1920×1080, four heavy techniques, own generator each)

Mosaic · Feedback Zoom · Reaction Diffusion · Slit Scan. Renders forced every
rAF, so the number is throughput rather than how often something happened to
invalidate the engine.

| Layers | FPS | CPU frame | Compositor passes | Accumulators | Layer targets |
|---|---|---|---|---|---|
| 1 | 120 (vsync) | 0.2 ms | 0 | 0 | 0 |
| 2 | 120 (vsync) | 0.1 ms | 2 | 16.6 MB | 16.6 MB |
| 3 | 120 (vsync) | 0.4 ms | 3 | 16.6 MB | 24.9 MB |
| 4 | 120 (vsync) | 0.4 ms | 4 | 16.6 MB | 33.2 MB |

One opaque Normal layer takes a direct path in **both** preview and export:
zero compositor passes, zero allocation, the branch draws straight where the
pre-layer engine did. VRAM at four layers is ~50 MB.

### Four bugs worth remembering

Each of these was invisible to every green gate at the time, and each now has
a regression test in `tests/layers.test.ts`.

1. **Branches held a stale renderer.** A branch caches the `WebGLRenderer` it
   was built with. StrictMode's double effect, a workspace switch and a
   restored context all build a *new* renderer on the same canvas, and a branch
   still holding the old one draws into framebuffers the host cannot read.
   Every layer went black, deterministically, with no error and no warning.
   `init()` now adopts survivors and drops their targets; `dispose()` takes the
   branches down with it.

2. **`setViewport` multiplies by the pixel ratio.** Adding it after
   `setRenderTarget` — which already installs the target's own viewport —
   installed a 2× viewport on a 2× display, so every offscreen pass rendered
   zoomed into its own target. Measured on the generator: 175 335 non-black
   pixels instead of 192 588, and a mosaic showing ten of its forty columns.
   `setPixelRatio(1)` is not the fix either: three implements it as `setSize()`
   and it reallocates the drawing buffer.

3. **A reallocated generator target was served empty.** `ensure()` rebuilds the
   target when the size changes, but the redraw cache is keyed on params and
   time — neither of which moves — so the early return handed back a blank
   texture nothing ever filled.

4. **The render loop slept through animating layers.** A live source, feedback
   and a simulation generator are the three things that keep the loop rendering
   without an explicit invalidate, and all three moved onto the branches. The
   host's own flags read false forever: 19 rendered frames per second while rAF
   ran at 120, with nothing on screen to say so.

The first two are the same lesson the project has now learned four times: a
gate that a dormant system can satisfy needs a companion that fails when
nothing happens. `runLayerGoldens` passes on synthetic inputs even when no
branch draws; `probeLayers` is the companion that reads what the branches
actually produced.

---

## B — Routing and shared signals

Status: **complete**. A layer can react to another layer's image, one camera
feeds several layers, and both survive export.

### Decisions

| Question | Decision | Why |
|---|---|---|
| How is a route addressed? | Two optional **layer ids** on a mapping: `targetLayerId`, `sourceLayerId` | Ids, never indices, so reordering the stack cannot silently re-point a route. |
| Default target | The **bottom** layer | What every migrated v0.4/v0.5 project means. Deliberately *not* the selected layer: selection is UI state, and a stored mapping that followed it would render differently depending on what happened to be selected at open time. |
| Default source | The mapping's own **target** | A layer reacting to itself is the only default that needs no UI to be useful. |
| Cross-layer cycles | **Allowed and reported**, not forbidden | Every visual signal is sampled from frame N−1, so a loop settles at one frame of latency per hop rather than deadlocking. `feedbackLoops()` reports them for the UI to label. |
| Which layers analyse | Only those something **routes from** | A layer nobody reads releases its reduction targets. Verified live: a three-layer stack reported demand `motion: [motion.amount, motion.centroidX]`, `driven: []`, `idle: []`. |
| Live device sharing | **One acquisition, many layers** | Physical constraint — a camera cannot be opened twice. The manager owns the device, the engine distributes the texture, the bridge says which layers show it. |
| Deterministic source sharing | **Not shared** — each layer builds its own | A generator or a file decodes identically from the same seed and path, so sharing buys nothing and couples two layers that may later diverge. |
| Calibration scope | The **pixel origin**, per layer | Two layers on one camera share an origin key and therefore one envelope, so a Look stays playable across both. |
| Overlay scope | The **primary** layer only | A morph or an audition is scoped to what the performer is holding; applying it to every layer would make one gesture rewrite the whole composition. |

### What exists

- `src/modulation/layerRouting.ts` — `targetLayerOf`, `sourceLayerOf`,
  `mappingsByTarget`, `crossLayerRoutes`, `feedbackLoops`.
- `ModulationRuntime.configureLayers` / `transformFor` / `setLayerVisualStats`
  / `setLayerVisualOrigin` / `visualValuesFor` / `demandByLayer`. Smoothing,
  macros, triggers and overlays stay single instances; only what a layer
  actually owns gained a layer dimension.
- `RenderEngine.setLayerParamTransform`, `setLayerVisualSink`,
  `setVisualDemandByLayer`, `setLiveSource`, `setLiveLayerKinds`.
- `createSecondaryLayerEvaluator` in the export runner, walked in the preroll.

### Gates

| Gate | Result |
|---|---|
| Cross-layer route drives a parameter (generator stack) | layer 1's `motion.centroidX` moved layer 2's `centerX` across −0.033 … +0.052 |
| Cross-layer route drives a parameter (live camera) | layer A's `motion.amount` moved layer B's `strips`, 232 … 273 |
| One camera, two layers | `sameTexture: true`, both layers live, one `getUserMedia` |
| Per-layer demand | read-from layer analyses; driven and idle layers analyse nothing |
| Export: a route changes the render | 12/12 frames differ enabled vs disabled |
| Export: repeat | 12/12 identical |
| Export: full vs subrange | 12/12 identical |
| Single-layer identity vs v0.5.0 | still byte-identical |
| Output passivity | `FrameStateMsg` carries resolved values only — no signals, no analysis, no pixels |
| Suite / lint / build | 1307 tests, all clean |

### Three more bugs of the same family

1. **A branch in export mode fell through to the LIVE transform.** With no
   supplied parameters, `syncScene()` called the preview runtime — which reads
   wall time — in the middle of a render. Export now refuses that fallback.

2. **`isFeedbackTechnique` was host-only.** The host holds no technique in
   layer mode, so the export skipped the feedback preroll while still setting
   `prerolled`; the first real frame then declared itself not-first and the
   feedback surface was never reset, so every export inherited the previous
   one's history. Two runs of the same export disagreed on every frame while
   the *evaluator* stayed identical to six decimals — which is how it was
   found.

3. **Smoothing froze whenever the transport was parked.** The evaluator steps
   `dt` from transport time, and a live camera with the transport stopped is
   exactly the v0.6 performance case: `dt` was zero, so every smoothed mapping
   held its first sample. Measured on a camera route: the raw signal moved
   0.13 → 0.20 while the driven parameter sat at 296.3042 indefinitely. Preview
   now falls back to wall clock when transport time is not advancing, the same
   rule the calibration store already followed. Export is untouched — it runs
   its own evaluator, stepped by a fixed 1/fps.

### Known gap at the time, closed in E

The Output replica rendered **one** technique: it had not been taught to
composite a stack, so it mirrored the selected layer rather than the
composition. Closed in E — see below.

## C — Blend, mask, layer modulation

Status: **complete**, with masks deliberately deferred.

### Decisions

| Question | Decision | Why |
|---|---|---|
| Modulating the layer itself | A new target namespace, **`layer.opacity`** | `motion.amount → this video's opacity` is half of why layers exist, and opacity belongs to the layer, not to any technique inside it. |
| What else is modulatable | **Nothing else** | Blend mode is a choice from a list with no continuum to interpolate along; if it ever becomes a target it has to be a trigger action. `enabled` is a switch whose whole point is that it is *not* a dimmer. |
| How layer modulation is evaluated | Through **`applyModulations`**, on a synthetic one-parameter definition | Opacity gets Add/Set composition, the single-Set rule, freeze, input windows, curves and smoothing with exactly the semantics every other target has, and cannot drift from them. |
| `enabled: false` vs `opacity: 0` | **Different on purpose** | A disabled layer is not rendered at all — no branch draw, no analysis, no compositor pass — so it costs nothing and its feedback or simulation history stops advancing. A layer at zero opacity is rendered and composited to nothing: it still costs, and its history keeps evolving, so fading it back up resumes where the material would have been rather than where it was abandoned. One is a mute, the other is a fader, and an instrument needs both. |
| Solo | Exclusive, stored, and a **view** over enabled | Nothing about the other layers' `enabled` flags changes, so releasing solo restores precisely the stack the performer had built. Resolved once in the bridge; the engine never learns the rule. |
| Masks | **Deferred out of v0.6** | A mask is a second source, a second sampling rule, a mask blend, inversion and feathering — a feature of its own size. Blend modes plus modulated opacity already cover the compositing this release set out to deliver, and shipping half a mask would be worse than shipping none. |

### Gates

| Gate | Result |
|---|---|
| A signal moves layer opacity, live | 0 → 0.44 → 0 → 0.94 → 1 → 0.04, tracking `motion.amount` from another layer |
| Solo is exclusive, non-destructive, restorable | verified live: the other layer's `enabled` untouched, state identical after release |
| Export: opacity route changes the render | 12/12 frames differ enabled vs disabled |
| Export: repeat | 12/12 identical |
| Export: full vs subrange | 12/12 identical |
| Every schema blend mode is implemented | asserted against `BLEND_MODE_INDEX` |
| Single-layer identity vs v0.5.0 | still byte-identical |
| Suite / lint / build | 1324 tests, all clean |

### One bug, and one thing that only looked like one

**Bug: `dt` was being consumed several times per frame.** Once layers arrived,
the runtime is asked for a step by the primary layer, by every secondary layer
and by every layer's opacity. `previewDt` advanced its own clock on each call,
so one frame's `dt` was split between them and every smoothed mapping ran
slower in proportion to the layer count. It is now computed once per rendered
frame, from a sink the engine calls before anything resolves a value.

**Not a bug: Set mode is spelled `replace`.** The docs and the UI call it Set;
the schema value is `'replace'`. A mapping written with `mode: 'set'` is
silently an Add mapping — and an Add mapping with a zero signal correctly
leaves the parameter alone, which is indistinguishable from a dead route. Cost
an hour. The layer-opacity test now asserts movement in **both** directions, so
a route that only appears to work cannot pass.

## D — Performance UX

Status: **complete**.

### Decisions

| Question | Decision | Why |
|---|---|---|
| Look or Scene? | **A Look is the whole composition.** No second concept. | With layers, "the look" of MATERIAL *is* the stack. Recalling a slot and getting a hybrid — this Look's technique wearing whatever else happened to be loaded — is not what anyone means by recalling a look. A Look/Scene duality would mean two strips, two sets of slots, two MIDI bindings and an explanation. |
| Looks pinned before v0.6 | Restore the **selected layer only**, exactly as they always did | Absence of a recorded stack is the honest record of "this predates layers". Inventing a one-layer stack for it would silently wipe layers the performer added afterwards. |
| A layer the Look does not mention | **Removed** | The Look is the whole composition, so recall has to be idempotent. Leaving strays behind means the result depends on what was loaded before. |
| Layer identity on recall | Matched by **id**, so survivors keep their runtime | A feedback surface or a simulation is not rebuilt because a Look was recalled — the recall is instant instead of a visible reset. |
| Solo on recall | **Not restored** | Solo is live performance state, not part of a look. Recalling must not silently re-solo something the performer released. |
| Morph across a stack | The **primary layer interpolates**; the rest arrive at the end, in the same atomic commit | There is no meaningful interpolation between "three layers" and "two": the stack is structure, not a value. One commit, so the performer never watches a stack settle piece by piece. |
| Freeze | **Unchanged** | Mapping ids are unique project-wide and one `SmoothingState` serves every layer, so freeze needed no layer dimension. Asserted, so it does not grow one by accident. |
| Strip order | **Bottom layer first, left to right** | It is the compositor's own order: what sits on the left is underneath. A top-down list would read the opposite way round from the picture. |

### The layer strip

`src/performance/ui/LayerStrip.tsx` — one cell per layer: index, name, the
technique it is running, an opacity fader, mute, solo and blend mode.

The fader carries **two** numbers whenever a signal is driving opacity: the
resting value the performer set, and the value the signal is actually
producing. Showing only the stored one makes a modulated layer look broken;
showing only the live one makes the fader impossible to aim. Verified live with
a layer whose opacity is driven by another layer's motion — the cell reads
`0.85 1.00`, the second in accent.

Keyboard-operable throughout (`role="slider"`, arrow keys, `aria-valuenow`),
because a performance surface that only responds to a mouse is not one.

### Gates

| Gate | Result |
|---|---|
| Composition recall is exact | 3 layers captured and restored identically after deleting one, changing another and adding a third |
| Recall is idempotent | applying twice equals applying once |
| Runtimes survive recall | branches stayed `L1, L2, L3` — no rebuild |
| A pre-v0.6 Look leaves the stack alone | returns the project unchanged, by identity |
| Suite / lint / build | 1341 tests, all clean |

### One bug

**Recall put the wrong technique on the wrong layer.** A Look's
`techniques`/`material` describe one layer, and that layer was being chosen by
a fallback: when the previously selected layer no longer existed, the core
landed on layer 1. Measured directly — a three-layer recall came back with
layer 2's Slit Scan sitting on layer 1. A Look now records which layer it was
pinned from, and that selection wins.

## E — Export, Output, QA, release

Status: **complete**.

### The Output gap from B, closed

The replica renders the stack now, from the same `RenderEngine` and the same
`LayerCompositor` the editor uses. What crosses the channel is unchanged in
kind: **configuration** on the low-rate message (which layers exist, what each
is made of, how it blends) and **resolved values** on the per-frame one
(parameters, opacity, source parameters). No evaluator, no store, no pixel.

`src/output-window/outputLayer.ts` holds one layer's media and renderer,
scoped by layer id — the same lifecycle the replica always had for its single
source, instanced. A live device is still acquired once per replica and shared
by every layer showing it.

| Gate | Result |
|---|---|
| Editor vs Output, two blended layers | **identical** — mean 159, non-black 46 656, across two processes |
| Replica composites the stack | branches `L1, L2`, blend and opacity honoured |
| Channel carries no pixels | asserted against declarations, not prose |
| Replica imports no evaluator | asserted for `replica.ts` and `outputLayer.ts` |

A layer running a **temporal** technique is the documented exception: the
replica accumulates its own history from the moment it opens, so its atlas is
not the editor's. Same rule as a morph opened mid-transition. Measured while
diagnosing: mean 128 against the editor's 191 with a Slit Scan layer, which is
also how a real bug was found underneath it — the replica was giving generator
layers no temporal source at all.

### Four-layer release fixture

Four techniques, four sources, four blend modes, a cross-layer technique route
and a cross-layer opacity route, at 320×180 exported to 160×90 at 12 fps.

| Gate | Result |
|---|---|
| Frames actually move | 12/12 distinct |
| Repeat export | 12/12 identical |
| Full vs subrange | 12/12 identical |
| Anti-noop (routes on vs off) | 12/12 differ |

### Soak

1280×720, four layers, two cross-layer routes, with layer add/delete, solo
cycling and enable cycling every few iterations.

Textures, geometries, programs, render-target bytes, branch count and
calibration-cache size were **constant** throughout; GL errors zero. Heap
oscillated 26–37 MB with no trend.

### Packaged QA

`npm run package` produces `release/mac-arm64/MATERIAL.app` at version 0.6.0.
It launches, renders at 130 fps, and its `app.asar` contains the v0.6 code
(`LayerCompositor`, `renderLayerToCanvas`, `authorityLayerParams`,
`OutputLayer`, the layer strip).

Note for future QA: CDP `Runtime.evaluate` does not answer in a packaged
Electron build, so the packaged pass is launch, render and artifact inspection
rather than a driven scenario. That is a property of the harness, not of the
build.

### Three more bugs

1. **Every branch published its own frame to the Output.** `syncScene` emits,
   and every layer runs it, so the replica received one message per layer per
   frame and showed whichever arrived last. The host now publishes once, after
   compositing, with the whole stack attached.

2. **The bridge declared the stack and never copied it.** `RenderInputs` grew
   a `layers` field that `toInputsMsg` did not forward, so the replica kept its
   single-source path and rendered one technique — the exact shape of the CE1F
   and CE1G defects, where a field was declared, read by the replica, and never
   written by the sender. Now gated on both messages.

3. **The Output ignored the opacity it had just been sent.** `effectiveOpacity`
   consulted the live sink before the authority value, and the replica has no
   sink, so it fell through to the stored value. Authority now wins first — in
   the replica and during an export alike.

### Docs

`docs/LAYERS.md` (new), `docs/PROJECT_FORMAT.md` (schema v4 and the migration),
`docs/ARCHITECTURE.md` (branch-mode engine and what it implies),
`docs/RELEASE_NOTES.md` (v0.6.0).

---

## Release

Tagged **v0.6.0**. Schema v4. Every gate in this document was run against the
code that shipped, not against an earlier revision of it.

The one number worth carrying forward: **eleven** defects were found in this
release, and every one of them was invisible to a green gate at the time.
Nine were the same shape — something that used to be true of one engine
quietly staying written for one engine, so a host-level predicate kept
answering for itself while the work had moved onto the branches. A stale
renderer, a sleeping render loop, a feedback preroll that never ran, a frame
message published once per layer, a field declared and never copied.

None of them threw. Each produced a deterministic wrong answer, which is why
the gates stayed green: determinism is not correctness, and a gate a dormant
system can satisfy needs a companion that fails when nothing happens. In v0.6
that companion was `probeLayers` — reading what the branches actually drew —
and an identity comparison against a real v0.5.0 build that reports pixel
counts alongside its hash, so black-against-black cannot pass for a match
again.
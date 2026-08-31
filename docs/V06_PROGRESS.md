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

### Known gap, carried to E

The Output replica renders **one** technique. It has not yet been taught to
composite a layer stack, so it currently mirrors the selected layer rather than
the composition. Passivity is unaffected — the channel already carries only
resolved values — but the replica needs the layer list and per-layer resolved
parameters before it shows what the editor shows.

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

Not started.

## E — Export, QA, release

Not started. No `v0.6.0` tag until A–E all pass.

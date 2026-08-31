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

Not started.

## C — Blend, mask, layer modulation

Not started. The seven blend modes are implemented and gated in the
compositor; C decides opacity modulation, Solo, enabled-vs-opacity-0 semantics
and whether masks land in v0.6 at all.

## D — Performance UX

Not started.

## E — Export, QA, release

Not started. No `v0.6.0` tag until A–E all pass.

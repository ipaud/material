# Render runtime: ownership

## The problem this document exists to prevent

v0.6 shipped eleven defects. Nine were one shape:

> A host-level predicate kept answering for itself after the work moved onto
> the layer branches.

`generatorActive`, `liveSourceActive`, `isFeedbackTechnique`, visual demand,
frame publication — each asked a question whose scope had silently changed.
None threw. Each produced a deterministic wrong answer, so every gate stayed
green: a render loop that slept through animating layers, an export that
inherited the previous export's feedback history, an Output that showed
whichever layer's message arrived last.

The cause is structural, not a sequence of oversights.

## R1 — Responsibility audit (v0.6.0, before extraction)

`RenderEngine.ts` is 2044 lines, and it is **one class playing two roles**:

```
new RenderEngine() + init(canvas)      → HOST    owns canvas, loop, view, layers
new RenderEngine() + initBranch(gl)    → BRANCH  owns one creative chain
```

`isBranch` decides which. Every field exists on both, so a host instance has a
`generator`, a `flow`, a `temporal` and a `techniqueRenderer` that are
permanently null — and every predicate reading them answers `false` for the
host while being *true of the composition*. That is the bug family, expressed
as a type.

### Inventory by responsibility

| Class | Members | Belongs to |
|---|---|---|
| **A. Orchestration** | `init` · `dispose` · `loop` · `renderFrame` · `getStats` · `invalidate` · `dirty` · `fpsEma` · `frameSink` | HOST |
| **A. View** | `view` · `fit` · `zoomTo` · `zoomAround` · `panBy` · `wellColor` · `checkerboard` | HOST |
| **B. Layer lifecycle** | `branches` · `layerStates` · `selectedLayerIndex` · `syncLayers` · `branchFor` · `layerIds` · `layerCount` · `ensureLayerTarget` · `disposeBranch` | HOST → **LayerHost** |
| **B. Layer render** | `visibleLayers` · `singleOpaqueLayer` · `renderDirectLayer` · `renderComposition` · `effectiveOpacity` · `resolvedOpacity` | HOST → **LayerHost** |
| **B. Layer authority** | `layerParamTransform` · `layerStateSink` · `authorityLayerParams` · `authorityLayerOpacity` · `layerVisualDemand` · `layerVisualSink` · `applyBranchVisualDemand` · `onBranchVisual` | HOST → **LayerHost** |
| **C. Source acquisition** | `setSource` · `sourceTexture` · `liveSourceActive` · `watchSourceFrames` · `sourceFrameKey` · `sourceFrameCounter` | BRANCH |
| **C. Shared live devices** | `liveTextures` · `liveLayerKinds` · `setLiveSource` · `setLiveLayerKinds` · `distributeLiveSources` | HOST → **LayerHost** |
| **D. Generator** | `generator` · `sourceParams` · `sourceParamTransform` · `resolvedSourceParams` · `renderGenerator` · `hasGenerator` · `generatorActive` · `prepareGeneratorForExport` | BRANCH |
| **E. Signals** | `visualStats` · `visualDemand` · `latestVisual` · `visualGrid` · `updateVisualStats` · `updateVisualStatsForExport` · `visualSignalStats` · `visualDiagnostics` | BRANCH |
| **F. Optical flow** | `flow` · `flowIsNeeded` · `techniqueWantsFlow` · `updateFlowService` · `resetFlowPair` · `prepareFlowForExport` · `flowStats` | BRANCH |
| **G. Temporal** | `temporal` · `temporalEnabled` · `temporalSource` · `resetTemporal` · `getTemporalStats` · `prepareTemporalForExport` · `isTemporalActive` | BRANCH |
| **H. Feedback** | `feedbackActive` · `resetFeedback` · `prepareFeedbackForExport` · `isFeedbackTechnique` · `lastFeedbackExportSec` | BRANCH |
| **I. Technique + material** | `techniqueRenderer` · `techniqueParams` · `materialState` · `materialTexture` · `boundaryMode` · `syncScene` · `scene` · `camera` · `updateCamera` · `originalQuad` | BRANCH |
| **J. Output publication** | `publishComposition` · `lastResolved` | HOST (publishes) / BRANCH (records) |
| **K. Export** | `exportMode` · `beginExportMode` · `endExportMode` · `setExportPreviousTime` · `renderStill` · `captureExportSnapshot` · `exportParamLog` | BOTH — see EXPORT.md |
| **L. Compositor** | `layerCompositor` · `blit` · `blitScene` · `liveTarget` · `ensureLiveTarget` | HOST |
| **L. Transition** | `transitionState` · `setTransition` · `captureTransitionSnapshot` · `releaseTransitionSnapshot` | HOST |
| **M. Context lifecycle** | `renderer` · `canvas` · `onContextLost` · `onContextRestored` · `handleContextRestored` · `initBranch` · `isBranch` | BOTH — split |
| **N. Diagnostics** | `compositorStats` · `exportParamLog` | HOST |

### What the audit concludes

The extraction the v0.6 backlog imagined — pull a `LayerHost` out and leave
`RenderEngine` otherwise intact — would move rows **B** and half of **C** and
stop there. It would shrink the file. It would **not** remove the defect
family, because a host `RenderEngine` would still carry a `generator`, a
`flow`, a `temporal` and a `techniqueRenderer` it never uses, and every
predicate over them would still compile and still answer `false`.

So the boundary is not "extract the layer code". It is:

```
LayerRuntime   one creative chain. Has a generator, flow, temporal,
               feedback, analysis, technique. Renders to a target.

LayerHost      owns the LayerRuntime map, keyed by layer id. Answers
               questions ABOUT THE SET.

RenderEngine   owns the canvas, the loop, the view, the compositor.
               Has no creative state at all, so it cannot be asked a
               creative question.
```

The last line is the point. After extraction `renderEngine.generatorActive`
is not wrong — it does not exist.

## Scope is part of the question

Permanent rule, and the direct lesson of v0.6:

> Every runtime query must make its scope unmissable at the call site.

A function that can be answered without knowing *which* thing is being asked
about is still ambiguous.

| Banned | Replacement | Scope |
|---|---|---|
| `generatorActive` | `layerHost.anyLayerNeedsContinuousRender()` | ANY layer |
| `isFeedbackTechnique` | `layerHost.anyLayerUsesFeedback()` | ANY layer |
| `liveSourceActive` (host) | `layerHost.hasLiveSourceConsumers()` | ANY layer |
| `feedbackActive` (host) | `runtime.usesFeedback()` | THIS layer |
| — | `layerHost.requirementsFor(layerId)` | THIS layer |
| — | `layerHost.exportRequirements()` | EXPORT graph |
| — | `sourcePool.consumerCount(identity)` | THIS source identity |

Prefixes carry the scope: `any*` / `all*` over the set, `*For(layerId)` for
one, `export*` for the export graph, bare methods on `LayerRuntime` for itself.

## Frame authority order

One pass, one direction, no re-entry. Documented so a branch can never read a
pre-authority value.

```
1  clock          → ONE FrameTiming for the whole frame (dt computed once)
2  sources        → shared acquisition, source frames advance
3  signals        → analysis publishes frame N-1 values
4  mappings       → audio, pattern, MIDI, macros, routes resolve
5  resolved state → per-layer params + per-layer opacity
6  apply          → resolved values pushed onto each LayerRuntime
7  render         → each runtime draws to its own target
8  composite      → one blend chain
9  publish        → exactly ONE FrameState for the Output
```

`dt` is computed at step 1 and reused. It was being consumed once per layer,
so smoothing ran slower in proportion to the layer count.

Publication happens at step 9 and nowhere else. Branches were each publishing,
so the Output received one message per layer per frame.

---

# R2–R5 — the boundary as built

## The three classes

| | LOC | Owns | Cannot |
|---|---|---|---|
| **`LayerRuntimeImpl`** | 933 | One creative chain: source, generator, temporal history, optical flow, technique, image analysis, feedback | Reach a canvas, a loop, a view or the bus |
| **`LayerHost`** | 564 | The runtime map by layer id, layer targets, the compositor, shared live devices, authority values, analysis demand | Know what a technique *is* |
| **`RenderEngine`** | 987 | Canvas, animation loop, view transform, transition compositor, the single frame publication | Answer a creative question — it has no fields to answer one from |

`layerRuntime.ts` (118) holds the contract between the first two. The host
depends on the interface, never on the concrete class, so the set of things a
host may ask a layer is a short, reviewable list.

## Ownership table

| Object | Owner | Key | Shared | Disposed by | Reset when |
|---|---|---|---|---|---|
| `LayerRuntimeImpl` | `LayerHost` | layer id | no | layer removed · `disposeAll` | never reused across ids |
| Layer target | `LayerHost` | layer index | no | size change · renderer swap · layer removed | composition resize |
| Compositor accumulators | `LayerHost` | — | across layers | `disposeAll` · context loss | context restore |
| `WebGLRenderer` | `RenderEngine` | — | by every runtime | `dispose()` | `adoptRenderer` on replacement |
| Camera / capture feed | the manager, published via `setLiveSource` | device kind | **yes**, across layers | last consumer | acquisition stop |
| `OpticalFlowField` | `LayerRuntimeImpl` | — | no | `disposeBranch` · demand drops | source identity change · seek |
| `TemporalFrameProvider` | `LayerRuntimeImpl` | — | no | `disposeBranch` | context restore (**reallocated**) · seek |
| Feedback surface | the technique renderer, inside a runtime | — | no | renderer swap | source change · candidate release · context restore |
| `GeneratorSource` | the bridge, attached to one runtime | layer id | no | source change · layer removed | target realloc forces redraw |
| Calibration envelope | `calibrationStore` | pixel origin | **yes**, by origin | project change | project change |

Nothing is owned by "the engine, generally".

## Scope is part of the question

The rule this phase exists to install:

> A function that can be answered without knowing *which* thing is being asked
> about is still ambiguous.

| Question | Where it lives | Scope in the name |
|---|---|---|
| Does anything need a frame? | `layerHost.anyLayerNeedsContinuousRender()` | ANY |
| Does anything carry feedback history? | `layerHost.anyLayerUsesFeedback()` | ANY |
| Is anything showing a live device? | `layerHost.hasLiveSourceConsumers()` | ANY |
| Does anything address frame history? | `layerHost.anyLayerUsesTemporalHistory()` | ANY |
| What does this layer need? | `layerHost.requirementsFor(layerId)` | ONE |
| What does the export need? | `layerHost.exportRequirements()` | EXPORT GRAPH |
| How many layers show this device? | `layerHost.consumerCountFor(kind)` | ONE DEVICE KIND |
| Does *this* layer use feedback? | `runtime.isFeedbackTechnique` | ITSELF |

`branchesAnimating` was deleted rather than renamed: the loop asks the host
directly, so the scope is visible at the call site instead of hidden in a
helper's body.

## What the split bought, structurally

Two invariants stopped being guards and became facts:

- **One publication per frame.** `LayerRuntimeImpl` has no `runtimeBus`
  import, so there is exactly one `emitFrame` call in the tree and it is
  `RenderEngine.publishComposition()`, after compositing.
- **A host cannot answer a creative question.** `renderEngine.generatorActive`
  is not wrong — it does not exist.

## Regressions this refactor introduced, and how each was caught

Recorded because they are the argument for the reference worktree.

| Regression | Symptom | Caught by |
|---|---|---|
| Authority params kept in two places | Export prerolls got `undefined`; feedback subrange 4/12, motion 0/12 — while **repeat stayed 12/12**, because both runs were wrong identically | v0.6.0 comparison |
| `handleContextRestored` invalidated instead of reallocating | Would raise `INVALID_OPERATION` on the first pass after a restore (CE1H measured 1282) | feedback reset-matrix gate |
| Replica's FrameState technique sync deleted with its legacy block | A cross-technique morph would not switch the Output's technique | output-replica A→B→A test |

The first is the important one. A self-referential baseline — comparing the
candidate against its own previous behaviour — would have shown nothing,
because the failure was invisible to every determinism check.

## A bug that predated the refactor, fixed here

A remount rebuilds every layer runtime, but the bridge's per-layer memo is
keyed on SOURCE identity and short-circuits before attaching anything. The new
runtime got no source and no technique, and the composition went black and
stayed black. Confirmed present in v0.6.0 by running the same
dispose/init/resync sequence against the v0.6.0 worktree, so it is a fix, not
an artefact. The memo now records the runtime object it describes.

---

# R6 — equivalence against v0.6.0

Six fixtures × four composition times, both apps freshly started, driven by
the same fixture text:

| Fixture | Result | Content |
|---|---|---|
| single still generator | IDENTICAL | 39 348 non-black, var 8 918 |
| single animated generator | IDENTICAL | 41 904, var 8 205 |
| single stateful (feedback) | IDENTICAL | 43 092, var 8 011 |
| two layers, blend + opacity | IDENTICAL | 46 656, var 6 955 |
| two layers, cross-layer routes | IDENTICAL | 57 600, var 2 005 |
| four layers, 4 techniques, 2 routes | IDENTICAL | 57 600, var 884 |

Every frame clears a declared non-black and variance floor, so a blank result
cannot pass as a match.

**The four-layer fixture was wrong before it was right**, and the sequence is
worth repeating: it disagreed across builds, then was found to disagree with
*itself* across sessions of the same build, because stateful techniques
accumulate on a wall clock during preview. After resetting per-layer history
it still differed — because the reset was spelled with a v0.6.1-only method
and the reference silently no-opped, comparing a clean candidate against a
warm reference. Both are recorded in GPU_TESTING.md. A gate has to be shown
deterministic against itself before a difference it reports means anything.

# R7 — soak, performance, package

## Soak

11.0 minutes, 750 iterations at 1280×720 with four layers and two cross-layer
routes, churning throughout: add/delete, reorder, solo, enable/disable, source
switches between generators, composition resize, StrictMode-style remounts
(~68 of them) and freeze/unfreeze.

| | first half | second half |
|---|---|---|
| textures | 37.0 | 37.0 |
| geometries | 22.9 | 22.7 |
| render targets | 17.7 MB | 17.7 MB |
| layer runtimes | 4.0 | 4.0 |
| **stale runtimes** | **0.0** | **0.0** |

Zero GL errors. The render-target figure oscillates between 13.5 and 21.1 MB
because the soak deliberately resizes the composition; the means match.

`staleRuntimes` holding at zero across ~68 remounts is the load-bearing
number: no runtime ever kept a renderer the host had replaced.

## Heap, and why it is not a regression

JS heap rises under this workload. Measured as RETAINED heap — a forced
collection before every sample — from a freshly started app, five minutes
each, same script:

| | start | end | slope | total |
|---|---|---|---|---|
| v0.6.0 | 23 MB | 35 MB | +0.337 MB/sample | +12.1 MB |
| v0.6.1 | 23 MB | 34 MB | +0.324 MB/sample | +11.6 MB |

Identical within noise, candidate marginally lower. The growth predates the
refactor and belongs to the churn workload, not to the ownership change. It is
recorded here rather than claimed as clean.

The first attempt at this measurement was invalid and worth naming: the
candidate was sampled on an app that had already been running fifteen minutes,
so it started at 47 MB against the reference's 23 and looked like a leak. Both
sides have to start from the same place.

## Performance

1920×1080, four heavy techniques each with its own generator, renders forced
every rAF.

| | v0.6.0 | v0.6.1 |
|---|---|---|
| 1 layer | 120 fps · 0.1 ms | 120 fps · 0.0 ms |
| 4 layers | 120 fps · 0.1 ms | 126 fps · 0.1 ms |
| VRAM at 4 layers | 47.5 MB | 47.5 MB |
| textures / geometries | 15 / 14 | 15 / 14 |

Vsync-capped on both sides with identical GPU resources.

## Packaged

`release/mac-arm64/MATERIAL.app` at version 0.6.1. Launches, stays up, quits
cleanly on TERM, no errors in its log. The `app.asar` carries `LayerHost`,
`LayerRuntimeImpl`, `anyLayerUsesFeedback`, `exportRequirements` and
`adoptRenderer`. The remote debugging port is `isDev`-guarded exactly as in
v0.6.0 and is **closed** in the packaged build, verified by connecting.

CDP `Runtime.evaluate` does not answer in a packaged Electron build, so the
packaged pass is launch, liveness, artifact inspection and clean shutdown —
not a driven scenario. That is a property of the harness and is unchanged
since v0.6.

## Security

`electron/preload/index.ts` and `electron/main/index.ts` are **byte-identical**
to v0.6.0. No new IPC channel, no new `contextBridge` surface, no change to
`nodeIntegration`, `sandbox` or `contextIsolation`, no new filesystem or
shader surface. This phase moved renderer-process code only.

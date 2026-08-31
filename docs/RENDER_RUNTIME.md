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

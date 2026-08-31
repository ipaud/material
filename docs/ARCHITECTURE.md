# Architecture

## Processes

```
main (Node)                        renderer (Chromium, sandboxed)
├─ window + macOS menu             ├─ React UI
├─ typed IPC (zod-validated)  ◄──► ├─ Zustand stores
├─ material:// media protocol      ├─ RenderEngine (Three.js / WebGL2)
├─ ffprobe / FFmpeg                ├─ TemporalFrameProvider
├─ project + preset + recovery I/O ├─ AudioEngine + analysis worker
└─ export encoder sessions         └─ modulation runtime
```

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The
renderer reaches the system only through the preload bridge, and every IPC
payload is validated in main with zod before it touches the filesystem or a
child process.

## Why the engine lives outside React

Slider interaction is the product. If a parameter change re-rendered the React
tree, the instrument would feel like a form.

React writes into stores; a bridge (`rendering/engineBridge.ts`) subscribes and
pushes state into `RenderEngine` imperatively. The engine keeps its own state
and renders on demand in its own `requestAnimationFrame` loop. Parameter drags
never re-render anything above the slider itself.

## Layers are branches of the same engine

A composition is up to four layers, and a layer is a `RenderEngine` in
**branch mode** — the same class, constructed differently. A branch owns one
creative chain (source, generator, temporal history, optical flow, technique,
analysis, feedback) and owns no canvas, no loop and no view transform, because
those belong to the composition hosting it.

Reuse rather than a second implementation, deliberately: two renderers for one
job drift within a release. The host owns the canvas, the animation loop, the
view and one `LayerCompositor`, and owns no creative state of its own.

Two consequences worth knowing:

- **Anything the host asks about itself must also ask its branches.** Every
  predicate that used to answer for one engine — "is a live source active",
  "is this a feedback technique", "what should I analyse" — is now a question
  about the stack. Each one that was missed produced a silent, deterministic
  wrong answer rather than an error: a render loop that slept through
  animating layers, an export that inherited the previous export's feedback
  history. See [LAYERS](LAYERS.md).
- **A single opaque Normal layer skips the compositor entirely**, in preview
  and in export, drawing exactly where the pre-layer engine drew. That is both
  the fast path and the reason single-layer output stays byte-identical to
  v0.5.

The whole mosaic is **one `InstancedBufferGeometry` and one draw call**. Grid
layout, sampling, luminance mapping and temporal offsets are computed in the
vertex shader from `gl_InstanceID` and uniforms — no per-instance attribute
uploads, so changing a parameter costs a uniform write.

## Stores

| Store | Holds | Undoable |
|---|---|---|
| `projectStore` | the serializable project | yes — with transient coalescing so one drag is one entry |
| `uiStore` | workspace, panels, toasts, offline sources | no |
| `playbackStore` | play state, time, duration, loop | no |
| `audioStore` | decoded analysis and waveform peaks | no |
| `exploreStore` | variations, thumbnails, selection | no |
| `exportStore` | export dialog and progress | no |

## Registries

Techniques, materials and modulation sources are data, not branches.

- `techniques/registry.ts` — `TechniqueDefinition` per technique. Adding one is
  a definition plus a renderer; nothing in the engine changes. See
  [TECHNIQUE_API](TECHNIQUE_API.md).
- `materials/builtins.ts` — SDF shapes, index-matched to the GLSL `sdShape`.
- `modulation/sources.ts` — signal ids and how to evaluate them at a time.

## Time

One authoritative clock (`playback/PlaybackController.ts`). Audio is master
when loaded (AudioContext time), video slaves to it with drift correction;
otherwise the video element is master. Measured A/V drift during playback:
0.0 ms.

Frame history is separate and composition-time addressed — see
[TEMPORAL_ENGINE](TEMPORAL_ENGINE.md).

## Performance Capture sits above the runtime, not inside it

A Take never touches the engine. It resolves to two things — a set of base
values and a set of semantic actions — and hands them to the layers that
already existed.

```
gestures.ts     the ONE place that records AND applies. UI, keyboard, MIDI,
                pads call it.
   |            (livePerformer.ts applies through the primitives underneath
   |             and has no import path back — anti-recursion is the module
   |             graph, not a flag)
   v
recorder.ts     samples, epsilon, simplification, baseline
   v
takes[]         project data
   v
evaluate.ts     THE canonical evaluator. Pure for lanes, ordered for events.
   |
   +--> player.ts        -> modulationRuntime base + livePerformer  (preview)
   +--> exportRunner.ts  -> working copy + LayerHost authority      (export)
```

The engine gained exactly one method for all of it —
`setAuthorityLayerEnabled`, alongside the opacity and params authorities it
already had. Everything else routes through seams that predate v0.7:
`ActionTarget`, `TriggerScheduler`, `createFrameEvaluator`'s working copy, and
the base-parameter position in `modulationRuntime.transform`.

Full semantics in [AUTOMATION](AUTOMATION.md).

## Determinism

Same project + same seed + same frame time ⇒ same image. Seeded PRNG
(mulberry32) for anything random, precomputed audio analysis sampled by time,
beat phase as a pure function, and a fixed `dt` for smoothing during export.
This is what makes export reproducible; see
[EXPORT_PIPELINE](EXPORT_PIPELINE.md).

## Directory map

```
electron/   main, preload, ipc, media (ffprobe/ffmpeg/svg), filesystem, export
shared/     schemas (zod) + IPC contract + constants — the only cross-process types
src/
  app/          shell, title bar, workspace tabs, recovery prompt
  rendering/    RenderEngine, engineBridge, shaders, temporal/
  techniques/   registry + one folder per technique + preview renderer
  materials/    builtins and custom texture loading
  modulation/   sources, evaluator, runtime, actions
  audio/        AudioEngine, FFT, analysis, worker, beat grid, waveform
  explore/      seeded exploration and the Explore workspace
  export/       export runner, dialog, still export
  performance/  looks, morph, macros, candidate, and take/ (Performance Capture)
  projects/     project/preset/look actions, autosave
  viewport/ timeline/ inspector/ library/    panels
  state/ hooks/ utils/ types/
```

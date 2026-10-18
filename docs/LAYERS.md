# Layers

Several visual materials can coexist in one composition and be played
together. Up to **four**.

That is the whole idea. MATERIAL is not a timeline compositor, a node graph or
an NLE, and layers do not make it one: there is no nesting, no groups, no
adjustment layers, no arbitrary routing matrix. A layer is one complete
instrument, and a composition is a small stack of them.

```
LAYER 1   Camera            → motion signals ─┐
LAYER 2   Reaction Diffusion   centre ────────┤ driven by layer 1
LAYER 3   Video                opacity ───────┘
          ─────────────────────────────────────
          COMPOSITE
```

## What a layer owns

A source, a technique, a material, a blend mode, an opacity, and its own
running state — feedback history, simulation state, optical flow, image
analysis. Nothing is shared implicitly. Reordering the stack rebuilds nothing,
because a layer is identified by its **id** and never by its position.

Since v0.6.1 that is a class of its own, `LayerRuntimeImpl`, held by a
`LayerHost` that owns the set. The composition — `RenderEngine` — keeps the
canvas, the loop, the view and the compositor, and holds no creative state at
all, so it cannot be asked a question about a source or a technique. Every
question about the SET is named for its scope: `anyLayerUsesFeedback()`,
`requirementsFor(layerId)`, `exportRequirements()`. See
[RENDER_RUNTIME](RENDER_RUNTIME.md).

## The cap is eight

Measured, not guessed. At 1920×1080 with four heavy techniques, each with its
own generator, the composition holds vsync with ~0.4 ms of CPU per frame and
about 50 MB of layer targets and accumulators. The limit is not the GPU: it is
that an instrument you can play has a small number of things to reach for.

### Raised from four to eight (post-0.8.4)

Four was an instrument decision: four heavy layers hold vsync at 1080p. A long
piece that stages many effects through activity windows (below) needs more
layers than a performer can play at once, and export is not vsync-bound. Eight
1080p flow-displace layers exported 50 frames in ~2.8 s wall time including
app start (1 layer: 3.0 s, 4 layers: 2.3 s), i.e. no measurable slowdown at
this size; live playback with more than ~4 heavy layers will still drop
frames. Not measured: a 3:40 1080p25 piece.

## Activity windows

`layer.activity = { start, end, fadeIn, fadeOut }` (seconds). Outside
`[start, end]` the layer's opacity is multiplied by exactly 0, so the layers
beneath show untouched; inside, each fade is a smoothstep (`shared/activity.ts`).
`end: null` stays on until the end. The gate multiplies LAST, after Take and
modulation, in both the preview (`engineBridge` opacity sink) and the export
(`createSecondaryLayerEvaluator.opacityAt`), so a windowed layer cannot be
driven back on from outside its window. A layer at opacity 0 still renders and
its feedback/simulation history keeps advancing (see "Mute, fade and solo");
mute it if it should stop costing anything. UI: the **W** button on a layer
cell in the Perform strip opens in / out / fade-in / fade-out fields.

## Series: `input: "below"`

`layer.input` is `"source"` (default; every file written before it) or
`"below"`.

- **`source`**: the layer's technique processes the layer's own source and the
  result is blended over the layers beneath it, by blend mode and opacity. Layers
  stack in **parallel**. Rendering is byte-identical to before the field existed
  (75 frames of a three-layer project compared).
- **`below`**: the technique processes the **composite of the layers beneath it,
  as it stands at this frame**, and that result is then blended back over the
  same composite. Effects chain in **series**: each one is applied to the result
  of the previous ones, like separate passes but in one render. The layer's own
  `sourceId` is ignored while `below`. The bottom layer has nothing beneath it, so
  it sees the composition background and the UI disables the selector there.

How it is drawn: `LayerCompositor.composite` blends layers bottom-first into two
ping-pong accumulators. A serial layer carries a `before(backdrop)` hook; the
compositor calls it with the accumulator holding everything beneath, the layer is
drawn with that texture as its input, and only then is it blended. Layers with the
default input are drawn eagerly, in the same order as before. **No extra buffer
is allocated**: the accumulator that already existed is the input.

An inactive serial layer (outside its window, or opacity 0) blends at exactly
0, so the composite beneath passes through unchanged and with no colour drift:
seven inactive serial layers over a flat grey left it at the same level
(`scripts/serial-gate.mjs`).

State on a serial layer follows its input, not a source:

| State | How it is fed in export |
|---|---|
| Feedback | stepped inside the composite, after the input exists |
| Optical flow, image signals | prepared inside the composite (the pair is the composite's) |
| Frame history (echo, step print, slit scan…) | each frame the composite is pushed into the ring (no source to seek) |

Because none of that can be recomputed from a source, an export that starts
after 0 replays the stack first: feedback from 0, the rest for the 3 s before the
range, drawing the whole composite each walked frame. The gate proves it:
a 1 s range matches the same 25 frames of a 4 s export for serial feedback, echo and
motion, and fails 20/25, 15/25 and 1/25 respectively with the replay turned off.

Cost: measured at 1080p with seven layers and a mix of stateful techniques,
50 frames: parallel 10.8 s, serial 5.3 s wall (both include ~1.5 s of app start).
Serial was *faster* here because a serial history layer pushes the composite instead
of seeking the video element again (a parallel one seeks per layer). One run each,
not a benchmark. Unmeasured: a long piece, and preview frame rate with serial layers.

Limits: a serial layer with no technique shows its input unchanged (a copy; with
`add` blending that doubles it). The Output window mirrors `input`, but it was not
run with serial layers.

## A layer with no technique

A layer with a source and no technique passes the source through untouched
(it used to render nothing). A layer with no source still renders nothing,
deliberately. A windowed layer outside its window keeps rendering at opacity 0
so its feedback/simulation history is not lost; there is no "skip render when
inactive" because that would change what a layer remembers when it re-enters.

## Blend

`normal · add · screen · multiply · difference · lighten · darken`

Applied bottom-up, one pass per layer, through two ping-ponged accumulators
whatever the layer count. A single opaque layer in Normal skips the compositor
entirely and draws straight to the canvas, which is both faster and how
single-layer output stays byte-identical to v0.5.

Layer targets hold **premultiplied** alpha, because that is what the GPU
produces. The compositor un-premultiplies before blending, since the blend
functions are defined on colour and not on colour already scaled by its own
coverage.

## Mute, fade and solo are three different things

|  | What it does | What it costs | What happens to history |
|---|---|---|---|
| **Mute** (`enabled: false`) | Not rendered at all | Nothing | Stops advancing |
| **Fade** (`opacity: 0`) | Rendered, composited to nothing | Full | Keeps advancing |
| **Solo** | Everything else is hidden | Nothing for the hidden | Theirs stops |

Fading a feedback layer to zero and back resumes where the material would have
been. Muting it and back resumes where it was abandoned. Both are useful and
they are not interchangeable.

Solo is a **view**: it never touches anyone's `enabled`, so releasing it
restores exactly the stack you had.

## Routing between layers

A mapping carries two optional layer ids:

- `targetLayerId` — whose parameter it drives.
- `sourceLayerId` — whose visual signals it reads.

Both default usefully. With neither, a mapping drives the bottom layer from
the bottom layer's own signals, which is exactly what "the project's one
technique, driven by the project's one image" meant before layers existed —
so every v0.4 and v0.5 project keeps working untouched.

`sourceLayerId` defaults to the target, so a layer reacts to **itself** unless
told otherwise. That is the only default that needs no UI to be useful.

Targets deliberately do **not** follow the selected layer. Selection is
something you change by clicking; a stored mapping whose meaning followed it
would render differently depending on what happened to be selected when the
project was opened.

### Layer targets

Beside technique parameters, a mapping can drive the layer itself:

```
layer.opacity        0..1
```

Just the one. Blend mode is a choice from a list with no continuum to
interpolate along, and `enabled` is a switch whose whole point is that it is
not a dimmer.

### Loops are allowed

Layer B can react to layer A while A reacts to B. Every visual signal is
sampled from frame N−1 on every path, so a loop settles at one frame of
latency per hop instead of deadlocking. MATERIAL reports such loops rather
than forbidding them — a slow mutual feedback between two layers is a good
sound, not a bug.

## What is shared, and what is not

**Live devices are shared.** A camera cannot be opened twice, so one
acquisition feeds every layer pointed at it — one `getUserMedia`, one decode,
and because they share a pixel origin, one calibration envelope. A Look
written against that camera stays playable on both layers.

**Deterministic sources are not.** A generator or a file decodes identically
from the same seed or path, so sharing buys nothing and couples two layers
that may later diverge.

**Analysis follows demand.** Only a layer something actually routes *from* is
analysed; the rest release their reduction targets. Adding a layer nobody
reads costs no analysis at all.

## Looks are compositions

A Look pinned from v0.6 on captures the whole stack: every layer's source,
technique, material, blend and opacity, plus which layer was selected.
Recalling it restores the composition, matching layers by id so a survivor
keeps its runtime and a feedback surface does not visibly reset. A layer the
Look does not mention is removed, so recall is idempotent.

A Look pinned **before** v0.6 has no stack recorded and does exactly what it
always did: applies to the selected layer and leaves the rest alone.

Morph interpolates the **primary** layer and delivers the rest of the target's
composition at the end, in the same atomic commit. There is no meaningful
interpolation between "three layers" and "two" — the stack is structure, not a
value.

## Export and Output

Export resolves every layer, not just the selected one, and walks every
layer's smoothing through the preroll so a subrange enters with the same
history a full export would have. Measured on a four-layer composition with
four techniques, four blend modes and two cross-layer routes: repeat export
byte-identical, full-vs-subrange byte-identical, and disabling the routes
changes every frame.

The Output window composites the same stack from the same code, driven
entirely by resolved values — parameters, opacity, source parameters — with no
evaluation of its own and no pixel crossing the process. Measured parity on a
two-layer blended composition: identical mean and identical non-black count
across the two processes.

A layer running a **temporal** technique is the one exception, and it is not a
defect: the replica accumulates its own history from the moment it opens, so
its atlas is not the editor's. Same rule as a morph opened mid-transition.

## What layers are not

- Not nested, and not groupable.
- Not a routing matrix: a mapping reads one layer's signals, not a mix.
- Not unlimited: eight.
- No longer "not a timeline" or "parallel only": a layer has an activity window
  (above) and an input (below). There are still no adjustment layers as a
  separate kind: a serial layer IS the adjustment layer, and it carries a technique.

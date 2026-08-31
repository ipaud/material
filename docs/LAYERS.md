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

## The cap is four

Measured, not guessed. At 1920×1080 with four heavy techniques, each with its
own generator, the composition holds vsync with ~0.4 ms of CPU per frame and
about 50 MB of layer targets and accumulators. The limit is not the GPU: it is
that an instrument you can play has a small number of things to reach for.

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
- Not a timeline: they do not have in and out points.
- Not a routing matrix: a mapping reads one layer's signals, not a mix.
- Not unlimited: four.

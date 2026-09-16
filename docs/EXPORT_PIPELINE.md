# Export Pipeline

## Principle

Export never screen-records the viewport. Every frame is rendered offscreen at
full project resolution from an exact composition time.

```
# the evaluator replays from the ORIGIN; only [startFrame, startFrame+N) is written
for globalFrame in startFrame..startFrame+N:
    t      = (round(startSec*fps) + i) / fps   # addressed by GLOBAL FRAME INDEX
    params = evaluateModulation(t, dt = 1/fps) # history replayed from frame 0
    seek video to exactly t                    # awaits 'seeked'
    rgba   = engine.renderStill(w, h, params)  # offscreen render target
    send rgba -> main -> ffmpeg stdin (rawvideo)
```

## Determinism guarantees

| Property | Guarantee |
|---|---|
| Frame time | `(round(startSec*fps) + i)/fps` — addressed by global frame index, so the same frame is the same float in every export containing it |
| Audio features | Precomputed analysis arrays, linearly interpolated at `t` |
| Beat sources | Pure function of `(t, bpm, beatOffset)` |
| Randomness | Seeded (mulberry32); the GPU hash is a pure function of instance id + seed |
| Smoothing | EMA stepped with fixed `dt = 1/fps`, replayed from the timeline **origin** |
| Re-runs | Same project + same range + same fps → identical parameter sequence |

Verified in `tests/export-determinism.test.ts` and live against
`SHAZUNO-material.mp3`: two export runs produced identical sequences, and the
export evaluator matched the live preview evaluator to **4.2e-13** (float noise).

### Why smoothing is history-dependent (and why that's still deterministic)

An EMA-smoothed mapping depends on the frames before it. Until CE1H each export
initialised that state at its own start frame, so a subrange and a full export
disagreed during the settling window — measured at **0/12** matching frames with
the reference track driving Motion Mosh at smoothing 0.2, and 12/12 with
smoothing 0, which is what isolated it.

The evaluator now replays from the timeline origin: skipped frames are walked
(one cheap CPU evaluation each, nothing rendered) so a subrange reaches its
first written frame carrying the history a full export has. Both are exactly
reproducible **and** they agree with each other. Mappings with `smoothing = 0`
remain purely time-addressable.

## Process architecture

- **Renderer** owns the frame loop, GL readback, and progress state.
- **Main** owns the FFmpeg child process; frames arrive over validated IPC
  (`export:frame`), and payload size is checked against `width*height*4` before
  a single byte is written to stdin.
- Cancel kills the child and removes partial H.264 output.

## Formats

| Format | Encoder | Notes |
|---|---|---|
| PNG still | Canvas encode in renderer → validated PNG write in main | Signature-checked before write |
| PNG sequence | `-c:v png` → `frame_%05d.png` | Directory chosen by the user |
| H.264 MP4 | `libx264 -crf 18 -preset medium -pix_fmt yuv420p +faststart` | Optional AAC audio muxed from the project's audio source, trimmed to the export range |

Encoders are detected at startup (`ffmpeg -encoders`). ProRes 422/4444 and
alpha/EXR are **not** exposed yet — the architecture supports them, but nothing
is offered that the machine cannot actually produce.

## Known limitation — temporal techniques (fixed in Phase 8)

The Phase 3.5 frame ring buffer captures on the **on-canvas** render path with
wall-clock throttling. Offscreen export renders do not feed it, so an export of
Video Tile + time offset uses whatever the ring held when playback stopped:
the spatial time-offset pattern is present, but the past frames do not advance
with export time.

Phase 8 re-times capture to composition time (`RingBufferMode: 'timeline'`,
already reserved in the API), which makes temporal techniques export-exact.
Until then, temporal exports are flagged as preview-fidelity, not final.

## Color (corrected in v0.8.3)

What this section said until v0.8.3 — "sRGB throughout" — described the
intent, not the pipeline. The pipeline is **linear working, sRGB storage**:

- Source textures and every render target are tagged `SRGBColorSpace`. On
  three r152+ that means `SRGB8_ALPHA8`: the GPU **decodes** on sample and
  **encodes** on write. A shader handles linear light; a target stores sRGB
  bytes.
- Blending (compositor, echo, feedback, transitions) therefore happens in
  linear light. Two 128-greys at half `screen` read 149, not 160.
- Export reads the final SRGB8 target's bytes. It has always been right: a
  128/64 grey PNG through an identity technique exports as 128/64.
- The **canvas** is the one destination that is not an SRGB8 target. Until
  v0.8.3 the preview blit was a raw `texture()` copy, so the screen showed the
  decoded value — the same PNG previewed as **55/13**. Every mid-tone the
  performer saw was gamma-crushed; white and black were exact, which is why
  it survived every golden and every parameter-differencing pass.
- v0.8.3 applies the sRGB transfer at exactly one place: the preview's canvas
  write (`RenderEngine.blit(..., encode)`, and the transition compositor's
  `uEncode` when its destination is the canvas). A blit into another SRGB8
  target still passes no encode — the hardware does it. The single-opaque
  fast path now draws into the layer's own target so it, too, goes through
  that one write (measured at the display's full 120 Hz).

Gate: the 128-grey round-trip in `docs/GPU_TESTING.md`. No Rec.709/HDR
handling; the storage remains 8-bit sRGB.

## Frame-accurate video sampling (v0.2)

Each exported frame waits for **two** signals before it is rendered:

1. `seeked` — the element reached the requested time.
2. `requestVideoFrameCallback` — a decoded frame has actually been presented.

Waiting only for `seeked` was silently wrong: it reports that the seek
finished, not that a new frame is available to the texture. Rendering there
uploaded whichever frame the texture still held, and roughly a fifth of the
frames in a non-temporal export differed between two runs of the same project
(measured 11–16 dB PSNR — a different image, not codec noise). The temporal
path was unaffected because it primes from exact timestamps rather than the
element's current frame.

The first frame of an export also forces a real seek, because a freshly
opened project has no decoded data at all.

## Isolation while exporting (v0.2)

Parameters are already snapshot-isolated: `createFrameEvaluator` captures the
project once, and trigger actions mutate a working copy. Two things cannot be
snapshotted, because they are shared hardware state that the store bridge
drives live:

- the `<video>` element's position, and
- the technique / material renderers.

So for the duration of an export MATERIAL blocks the handful of actions that
move them — applying a Look, starting a Morph, applying a Candidate, and
seeking — each with a toast explaining why. Preview rendering pauses, and all
incoming MIDI is dropped at the engine entrance.

Verified: an export run while macros were swept, Looks were clicked, seeks
were requested and candidates were generated throughout produced a
**byte-identical** file to the same export run in silence.

## v0.6.1 — export requirements come from the SET

What an export needs is aggregated across every layer that will render, never
read off the selected technique:

```ts
layerHost.exportRequirements()
  → { needsFeedbackPreroll, needsTemporalHistory, needsGenerator, ... }
```

`isFeedbackTechnique` on the composition is `anyLayerUsesFeedback()`. Asking
the host answered "no" while layer 3 ran Feedback Zoom, so the preroll was
skipped, `prerolled` was still set, the first real frame declared itself
not-first, and every export inherited the previous one's history.

**v0.8.4 — the temporal gate was still the selected layer's.** The feedback
gate took `exportRequirements()` in v0.6.1; the temporal one kept asking
`selectedRuntime.isTemporalActive`. A secondary Echo's atlas was therefore
never written during an export — `filled 0, seeks 0` for a whole run — and
the technique sampled whatever the preview had last left in it, frame after
frame, deterministically. Found because the leftover frames happened to be a
transition the preview no longer showed. `isTemporalActiveAnywhere` had
existed, unused, since v0.6. Any temporal technique (echo, slit-scan,
step-print, time-field, mosaic-temporal) on a non-selected layer exported
wrongly before v0.8.4.

**Regression fixture, permanent:** four layers where the stateful technique is
on a layer that is *not* selected, for feedback, simulation and motion. Each
must repeat byte-identically and match full-vs-subrange. All three are 12/12
against the v0.6.0 reference.

### Authority values have one owner

Resolved per-layer parameters and opacities live on `LayerHost`. The engine
keeps no copy.

This mattered more than it sounds. During the v0.6.1 extraction the engine
briefly kept a second `authorityLayerParams` field while the prerolls read the
host's, so they were handed `undefined` and prerolled from live state. Repeat
determinism stayed a perfect 12/12 — both runs were wrong identically — and
only full-vs-subrange moved, to 4/12 and 0/12. It was found by comparing
against a real v0.6.0 worktree, and by nothing else.

### Live and export never share a clock

A layer in export mode does not fall back to the live parameter transform,
which reads wall time. Asserted structurally: `syncScene` guards on
`this.paramTransform && !this.exportMode`.

## v0.7 — a Take is an export program

The project's selected Take drives the render. It is evaluated **inside**
`createFrameEvaluator`, not beside the export loop, and that placement is the
whole correctness argument.

The runner already calls `evaluate(f)` for every frame from zero before a
subrange begins — that is the preroll walk. Putting the Take inside it means a
Take that changed a stateful parameter at t = 2 has that change applied over
the whole history a subrange starting at t = 8 never rendered. Reconstructing
only the parameter's *value* at t = 8 and using it for all of history is the
failure this arrangement prevents: feedback, simulation and motion state depend
on the control history, not on the control's final value.

### What the Take supplies

| | |
|---|---|
| Continuous lanes | the BASE parameters, opacities and macro values, before macros and modulation |
| Discrete events | the same `working` copy the trigger `ActionTarget` writes |
| Baseline | restored once at evaluator construction, including a `LookCore` if the Take recalls Looks |

A recalled Look reaches `working` through `applyLookToWorking`, so a Look
recalled by a Take and one recalled by a beat trigger are indistinguishable
downstream. A morph launched by a Take pushes a `VirtualMorph` into the same
list `morphEvents` populate — and appends no `morphEvent` of its own, because
two records would replay one gesture twice.

### The stack itself (v0.8.3)

A v0.6D Look carries a *layer stack* — which source each layer reads, its
technique, opacity and blend. Preview recalls the whole stack. Until v0.8.3
export recalled only the primary layer's **core**: a Look that pointed the
plate at a different generator changed the mosaic parameters and left the
picture on the old generator. Found by making a piece whose three Looks were
three Chladni plates — preview showed three figures, export showed one figure
dressed three ways. No test had ever recalled a Look that switched a source.

`working` now carries `layers`. `applyLookToWorking` runs
`projectWithLayerLooks` first (the same function the live path uses) and
`applyCoreToWorking` on the result, so the core lands on the layer the Look
selects. The export loop watches `evaluate.layerStack()` by **identity** —
the array is replaced only when a Look changed it — and on change calls
`syncLayersForExport`, which reconciles every layer's source through the
bridge's own `syncLayerSource` so its memo of what it configured stays
truthful. `resyncFromStore()` in the `finally` puts the document back.

Only **generator** sources swap. A file or live source cannot be seeked and
decoded inside a frame, so a Look that switches a layer to one is honoured for
parameters and left on the source it had. `createSecondaryLayerEvaluator`
remains static for secondary-layer technique, opacity and blend: a Look that
changes *those* on a non-primary layer still exports the document's values.
Both are open in BACKLOG.md.

### Layer visibility

`setAuthorityLayerEnabled` is a separate channel from
`setAuthorityLayerOpacity`, and deliberately not folded into it: `LayerHost`
keeps drawing at opacity 0 so a stateful branch does not lose what it has
accumulated, while disabling stops the branch. A replayed mute has to reproduce
whichever the performer actually did.

Both are set during the preroll walk as well as during the real frames, so a
branch the Take muted early stops accumulating from that point rather than from
the export start.

### Gates

`tests/take-signature.test.ts` runs anti-noop, time-liveness, event-liveness,
12× repeat, full-vs-subrange over three offsets, and cross-FPS at 24/25/30/60
against a committed twelve-second performance fixture.

The anti-noop gate is the one that matters most here, for the reason
`docs/GPU_TESTING.md` keeps repeating: a perfectly deterministic export that
ignores the Take passes every determinism check ever written.

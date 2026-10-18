# Automation — the technical semantics of a Take

`docs/PERFORMANCE_CAPTURE.md` is the user-facing account. This is the contract.

## 1. What is recorded

Three classes, and the line between them is "did a hand cause this".

| Class | Storage | Examples |
|---|---|---|
| **A — discrete intent** | `TakeEvent` | Look recall, Morph launch, Freeze on/off, layer enable |
| **B — continuous human control** | `TakeLane` of `(t, v)` | Layer opacity, macro position, a dragged performable parameter, a MIDI CC after mapping |
| **C — generated control** | *not recorded* | Audio analysis, Image/Motion Signals, Pattern output, calibration, every derived modulation result |

Class C re-evaluates during replay and export. A Take is therefore a
performance rather than a recording of one: replay it against a different song
and the Signals react to the new song while the gestures stay as played.

Structural edits — adding or deleting a layer, changing a source or technique,
editing routing or blend mode — are composition changes, not performance, and
are excluded. A Look recall may change a technique; that is the Look's doing
and it is already recorded as one event.

## 2. Time

Event and sample times are **seconds relative to `take.startSec`**, which is
the composition time recording began. Composition seconds as a double; no
ticks. MATERIAL's composition time is already an exact float derived from a
frame index (`compositionTimeAt` — see `docs/EXPORT_PIPELINE.md`), so the
accumulated-frame drift that would justify integer ticks does not exist here.

Nothing wall-clock is ever persisted. `Date.now()` appears once, in
`createdAt`, which is a label.

Before `startSec` a Take contributes nothing — that stretch is the project's
own state. Past `startSec + durationSec` its lanes **hold their last values**:
the performer stopped with the faders where they were, and releasing would put
a jolt at the end of every export.

### Ordering

`event.order` is a monotonic sequence number stamped at record time. Two events
at the same `t` replay in the order they were played. Sorting is
`(t, order)` — JS sort stability is not staked on. `order` is identity, not
position: editing never renumbers it.

### Frame-rate independence

Lane evaluation is a pure function of `t` alone — no cursor, no previous call.
The same Take sampled by a 24, 25, 30, 60 or 120 Hz loop returns identical
values at identical composition times. A rate that cannot land on a given time
(25 fps has no frame at 2.5 s) simply samples elsewhere; the semantics are
exact, the sampling instants are not shared.

## 3. Continuous lanes

One lane per control target. Targets carry their scope:

```
layer:<layerId>:opacity     0..1
macro:<macroId>             0..1
param:<layerId>:<paramId>   the parameter's own domain
```

Never an index — a reorder must not repoint a lane. A target string that does
not parse (a Take from a newer build) is dropped rather than failing the load.

**Parameter lanes store the parameter's own value**, not a normalised position,
so a Take and a Look agree about the same parameter. Opacity and macro lanes
are natively 0..1.

### Sampling

- Maximum **60 Hz** stored per lane.
- Values below **0.002 × the control's span** from the last *accepted* sample
  are held as pending rather than stored, so slow drift still accumulates into
  a real change.
- The value the control was resting at is written as the lane's first sample,
  backdated one sample period. Two samples cannot share a timestamp, and
  putting both at the touch instant let the first movement overwrite the
  resting value — so the stretch before a gesture replayed at the value the
  performer dragged *to*.
- The final value is flushed on stop, whatever the rate limiter was holding.
- With the transport parked, a gesture collapses onto the single instant it
  happened at, latest value winning.

### Simplification

Ramer–Douglas–Peucker on the `(t, v)` polyline, tolerance in the **value**
domain (vertical distance to the chord, not perpendicular — perpendicular mixes
seconds into the value domain and makes the tolerance depend on gesture speed).
Endpoints always survive. Iterative, not recursive.

Default tolerance `0.004 × span` — about one pixel of a 300 px fader.
Measured: 81.5 % of samples removed on a continuously-moving hand, with a
maximum value error of 0.00399.

Stored points are rounded to **4 decimal places** in both `t` and `v`: a 0.05 ms
time error against a 16.7 ms frame, and a value error eighty times under the
tolerance the gesture has already been through. It halves the bytes.

### Interpolation

Linear, held at both ends. No Bézier, no easing — a recorded gesture already
contains its own shape at 60 Hz.

## 4. Discrete events

Four kinds. Freeze and layer enable store an explicit **boolean state**, never
a toggle: a toggle replayed from a different starting state inverts the rest of
the performance.

```ts
'look.recall'   { lookId }
'morph.start'   { lookId, morph: { durationMode, durationValue, curve } }
'freeze.set'    { on }
'layer.enable'  { layerId, on }
```

A Morph records its **resolved schedule** — the quantized start is the event's
own `t`, and the duration is in seconds. Re-quantizing on replay would push
every playback one boundary further out than the last.

Looks are addressed by stable id, never by slot: a slot is a keyboard shortcut
the performer reassigns.

## 5. Baseline

The state a Take starts from. Without it, replay means "whatever the project is
now, plus these gestures", and a subrange export starting mid-Take could not
reconstruct the frames before it.

```ts
baseline = {
  lanes:        { [target]: value },        // captured on first touch
  layerEnabled: { [layerId]: boolean },     // captured at record start
  frozen:       { [mappingId]: number|null },
  lookCore:     LookCore | null,            // captured on first Look recall
  activeLookId: string | null,
}
```

`lookCore` is the only large item and it exists only in Takes that recall
Looks. It is needed because a recall *replaces* params, modulations and
triggers: without it, seeking back before the first recall left that Look on
screen, since nothing else remembered what it overwrote.

Continuous baselines are never written back to the document. A lane holds its
first sample backwards, which is the same value, so the overlay already answers
for every controlled target — writing them would make stopping a Take silently
rewrite stored parameters.

## 6. Evaluation order

A Take enters at the **base**, the same seam the human drag it recorded entered:

```
base parameters (document, or a Look/Morph overlay)
  → TAKE lanes substitute the values they recorded
  → macros (with any macro value the Take is playing)
  → continuous modulation, freeze inside
  → pulses
  → clamp
```

Applying a Take *after* modulation would let a replay overwrite the very
Signals it was performed against. This is the ordering in
`docs/PARAMETER_EVALUATION.md`, unchanged; the Take only supplies a different
base.

A recorded macro replays as macro **intent** and fans out through whatever
mappings the macro carries *now* — edit a macro's targets after recording and
the Take drives the new ones. That is the point of recording the hand rather
than the twelve parameters it moved.

## 7. Replay

Two different questions, two functions, and the distinction is the design:

| | |
|---|---|
| `replayDiscreteBetween(take, from, to, performer)` | The playhead **crossed** these. A Look recall fires once, not once per frame. |
| `replayDiscreteUpTo(take, at, performer)` | The playhead **teleported**. Restore the baseline, then replay every event from the origin in order. |

Reconstruction replays all events rather than sampling the last of each kind:
a Look at 2 s followed by a Morph at 6 s means the morph interpolates *from*
that Look. Event counts are small — tens of button presses — so replaying them
is cheaper than any scheme clever enough to avoid it.

Continuous lanes need neither: pure function of `t`, binary search.

The interval is half-open `(from, to]` **except at the Take origin**, which is
inclusive because nothing precedes it. Without that, an event played in the
very frame recording started was crossed by no interval and vanished from live
playback while a seek still had it.

### `TakePerformer`

The operations a Take needs, with two implementations — the same shape
`ActionTarget` already has for triggers:

- `livePerformer` writes the editor's store, inside `runSilently`, so replay
  leaves no undo entry and no dirty flag.
- the export performer writes `createFrameEvaluator`'s working copy.

Deliberately **not** `ActionTarget` itself: that vocabulary addresses Looks by
slot.

### Stop

The composition stays where the Take left it. The discrete side is automatic;
the continuous side is committed as one undo entry, because lanes drive an
overlay that never writes and releasing alone would snap every fader back to
its stored value the instant you stopped. Playing from the beginning always
restores the baseline.

## 8. Recording seams

`src/performance/take/gestures.ts` is the only module that both records and
applies. The UI, keyboard, MIDI engine and pads call it; `livePerformer.ts`
applies through the primitives *underneath* it and has no import path back.

Anti-recursion is therefore a property of the module graph, not a flag every
future call site has to remember to pass. `TriggerScheduler` takes an optional
capture hook; the export scheduler is constructed without one, and only
non-deterministic trigger sources reach it — the same `isDeterministicSource`
predicate export already trusts to decide what it replays.

MIDI is captured as the **semantic host control** it resolved to, never as
device plus CC number, so a Take replays with nothing plugged in and does not
depend on a mapping that may since have been reassigned.

## 9. Export

The Take is evaluated **inside** `createFrameEvaluator`, not beside the export
loop. That is what makes stateful preroll correct: the runner already calls
`evaluate(f)` for every frame from zero, so automation that changed feedback
persistence at t = 2 is applied over the whole history a subrange starts after,
rather than its final value being smeared backwards over frames that never saw
it.

Layer visibility gets its own authority channel (`setAuthorityLayerEnabled`)
rather than being folded into opacity: `LayerHost` deliberately keeps drawing
at opacity 0 so a stateful branch does not lose its accumulation, while
disabling stops the branch, and a replayed mute has to reproduce whichever the
performer actually did.

A morph launched by a Take does **not** append a `morphEvent`. It is already
recorded, in the Take; two records would give the export two virtual morphs for
one gesture.

## 10. Gates

Beyond determinism, which a dormant system satisfies trivially:

| Gate | Fails when |
|---|---|
| **Anti-noop** | The same export with the Take deselected produces identical frames |
| **Time-liveness** | An early frame equals a late one |
| **Event-liveness** | Removing a discrete event changes nothing |
| **Seek-equals-walk** | Reconstruction and crossing disagree |
| **Cross-FPS** | The same composition time resolves differently at 24/25/30/60 |
| **Repeat** | Twelve runs of a range are not identical |
| **Full vs subrange** | A matching global frame differs |

`tests/take-signature.test.ts` runs all of them against a committed twelve-
second performance fixture.


## Headless CLI (post-0.8.4)

The app doubles as a command line. It opens no visible window and exits with a
status code; `render` drives a hidden window through the SAME export code the
dialog uses (`runAnimationExport`), so a CLI render and a GUI export of the
same range are the same pipeline.

```
MATERIAL render <project.material> --out <file> [--codec prores422hq|prores4444|h264]
                [--fps N] [--range start:end] [--audio <file>] [--json-progress]
MATERIAL validate <project.material>
MATERIAL analyze-audio <audio> --json
```

Dev: `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron out/main/index.js render …`
(unset `ELECTRON_RUN_AS_NODE` if your shell sets it). Relative paths resolve
against the working directory. stdout carries one JSON object per line
(`progress`, `done`, `error`, `validate`, `result`); human messages go to stderr.

| Exit | Meaning |
|---|---|
| 0 | ok |
| 1 | usage error |
| 2 | project invalid (every schema problem is listed) |
| 3 | project valid but media files are missing |
| 4 | the job failed |

Defaults mirror the export dialog: fps = the source footage's rate (30 if
unknown), size = the composition. A project with no media clock needs
`--range`. A video the viewer cannot decode (e.g. ProRes) fails with a message
instead of hanging. `--audio` replaces the audio muxed into the file (modulation
still reads the project's own audio source); `--codec prores` means
`prores422hq`. `analyze-audio` returns bpm, confidence, beat offset, onsets and
suggested markers (checked on a 120 BPM kick track: 119.89). Determinism: two renders of one project give identical frames
(verified by frame md5). `MATERIAL_CLI_SHOW=1` shows the window for debugging.

`npm run gate:identity` drives this CLI to check colour consistency (flat grey
as video vs PNG through every technique).

## Aiming triggers and mappings at one layer

- A modulation mapping with `targetLayerId` drives only that layer's technique
  parameter; other layers do not react. Its input window (`inMin`/`inMax`) works
  as a threshold: with `inMin: 0.5` a soft hit does nothing.
  (`tests/kick-to-one-layer.test.ts`, example `examples/staggered-decay`.)
  UI: the **Layer** selector in a mapping's expanded detail.
- A trigger with `targetLayerId` pulses only that layer; untargeted pulses act
  on the primary layer only. Before this, the preview pulsed every layer that
  had the parameter while the export pulsed only the primary one, and
  secondary layers exported with no pulses at all. UI: the **Layer** selector
  in a pulse trigger's expanded detail.

# v0.7 — Performance Capture: phase log

Working notes, appended per phase. The stable documentation is
`docs/PERFORMANCE_CAPTURE.md` (what it is) and `docs/AUTOMATION.md` (how it
works); this file records what was decided, what was rejected, and what broke.

---

## v0.7A — Performance event contract + clock

### Audit: what already existed

The audit's most useful result was finding that MATERIAL already had most of
the machinery, in a shape v0.7 could adopt rather than duplicate.

| Thing v0.7 needs | Already present |
|---|---|
| A semantic action vocabulary with two backends | `ActionTarget` (`src/signals/scheduler.ts`): `liveTarget` writes the store, `virtualTarget` writes the export working copy |
| A composition-time event dispatcher | `TriggerScheduler.advanceTo(now, …)` — one class, both paths |
| Timed performance persisted as replayable data | `project.morphEvents` — a morph is already recorded as `{startTime, endTime, curve, sourceSnapshot, targetLookId}` and replayed by the export evaluator |
| A per-frame authority order | `base → macros → modulation (freeze) → pulses → clamp` (`modulationRuntime.transform`, `docs/PARAMETER_EVALUATION.md`) |
| A working copy the export mutates without touching the store | `createFrameEvaluator`'s `working` |
| A preroll that walks state forward frame by frame | `exportRunner.ts` — one walk, per-subsystem start frames |
| Transient gesture batching | `projectStore.beginTransient/commitTransient` — a slider drag is already ONE undo entry |
| MIDI resolved to host control | CC → `writeParam` / macro value; Note → a synthesized `TriggerMapping`. Raw device data never reaches state |

So no parallel action system was created. The Take rides the existing seams.

### What is recorded

| Class | Policy | Examples |
|---|---|---|
| A — discrete intent | RECORDED as an event | Look recall, Morph trigger, Freeze on/off, layer enable |
| B — continuous human control | RECORDED as a lane of samples | Layer opacity, macro position, direct performable param, MIDI CC after mapping |
| C — generated control | NOT recorded; re-evaluated | Audio, image/motion Signals, Pattern, calibration, every derived modulation result |

The line is "did a hand cause this". A macro's value is a hand; the twelve
parameters it fans out to are not, and recording them would freeze the fan-out
against the mapping the performer had at the time (§82/§83).

### Decisions

**Event set is four kinds, not eight.** `look.recall`, `morph.start`,
`freeze.set`, `layer.enable`. Blend mode, routing, source/technique changes and
add/delete layer are composition EDITS, not performance gestures, and are
excluded (§41/§90/§91/§92). Pads were considered and dropped: a pad fires a
trigger, and a trigger is already replayable state.

**Freeze and layer-enable store explicit booleans.** A toggle replayed from a
different starting state inverts the remainder of the performance.

**Continuous lanes, not continuous events.** Per-target sorted `(t, v)` arrays.
This is what makes evaluation a pure function of `t` (binary search, no
cursor), which is in turn what makes seek and subrange export possible at all.
An interleaved event list would have forced a scan or a cursor, and a cursor is
history.

**Param lanes store the parameter's own value; opacity and macro lanes store
0..1.** Considered normalising everything for one uniform epsilon. Rejected:
Looks store actual parameter values, so a normalised Take and a Look would
disagree about the same parameter after any range change, and a Take is
supposed to be replayable next to the Looks it recalls. Epsilon becomes
domain-aware instead — one multiplication.

**Take time is seconds relative to `startSec`.** Composition seconds as a
double; no ticks. Composition time in MATERIAL is already an exact float
derived from a frame index (`compositionTimeAt`), and the accumulated-frame
dependence §11 warns about does not exist here. Integer ticks would have added
a conversion at every boundary to solve a drift problem the clock does not
have.

**`order: number` breaks same-timestamp ties.** Monotonic within a Take, never
an array index, so editing cannot renumber what came before. JS sort stability
is not staked on.

**Held at both ends.** Before a lane's first sample the value holds — and that
is exact, not an approximation, because the recorder writes the pre-gesture
value as sample 0 the instant a control is first touched. Past the recorded end
it holds too: the performer stopped with the faders where they were, and
releasing back to the document would put a visible jolt at the end of every
export.

**Before `startSec` the Take contributes nothing.** That stretch is the
project's own state, which is exactly what the baseline restores to.

**Baseline stores only what the Take touches**, plus the full frozen map (one
nullable number per mapping — restoring "not frozen" is as much a restoration
as restoring a held value).

**Missing targets go inert, and are reported.** No retargeting by index or by
name. A lane whose target string does not parse at all — a Take from a newer
build — is dropped rather than failing the project load.

### Schema

Version 4 → 5. The shape is additive (`takes: []`, `activeTakeId: null`, both
defaulted) and `migrateV4toV5` is a stamp, like v2 → v3. The number moved for
the REVERSE direction: without it, v0.6.1 would open a v0.7 project, strip the
recorded performance as an unknown key, and save that back. A refused version
is a fixable message; a dropped performance is not.

### Rejected

- **Recording resolved FrameState per frame.** Destroys semantics and
  portability, bakes Signals, and makes a 10-minute take a 200×18 000 matrix.
- **Recording raw MIDI CC.** Replay would then need the device and the mapping
  that existed at record time. Backlogged as an explicit "raw MIDI Take mode".
- **Extending `ActionTarget` with continuous methods.** It is the trigger
  engine's vocabulary and addresses Looks by SLOT. A Take addresses them by
  stable id — a slot is a shortcut the performer reassigns. Separate
  `TakePerformer` interface, same two-implementations shape.
- **Integer tick time.** See above.

### Tests

`tests/take-contract.test.ts`, 29 assertions: target scoping and round-trip,
namespaced param ids, index rejection, interpolation, end-holding, empty-lane
null (not a neutral 0), binary search vs linear scan on 5 000 samples,
frame-rate independence across 24/25/30/48/60/120, order independence,
same-timestamp ordering under shuffle, crossed-vs-state separation, boundary
double-fire, seek-equals-walk, absolute morph placement, explicit-state
idempotence, simplification error bound and endpoint preservation, 36 000-sample
stack safety, missing-target reporting.

### Bug found in A

**An event at relative t=0 was crossed by no interval.** `replayDiscreteBetween`
used a half-open `(t0, t1]` throughout, so an event played in the very frame
recording started was dropped during live playback — while a seek, which
reconstructs from the origin, still had it. Deterministic, silent, and only
visible because the seek-equals-walk gate compares the two paths against each
other. Fixed: the interval is inclusive at the Take origin, because nothing
precedes it.

### Safe to proceed?

Yes. Contract, clock, ordering, interpolation, baseline shape and missing-target
policy are all defined and tested against a pure evaluator with no engine
dependency.

---

## v0.7B — Record / replay engine

### The capture seam

`src/performance/take/gestures.ts` is the only module that both records and
applies. UI, keyboard, MIDI engine and pads call it; `livePerformer.ts` applies
through the primitives underneath it.

That asymmetry — **record ABOVE the primitive, replay THROUGH it** — makes
anti-recursion a property of the import graph rather than a boolean every
future call site has to remember to pass. It is the same move as v0.6.1's
`LayerRuntimeImpl` having no `runtimeBus` import: a thing that cannot be
reached cannot be got wrong.

The seam ended up in five places, all of which existed already:

| Gesture | Where it is captured |
|---|---|
| Layer opacity, macro, param drag | the `perform*` wrappers in `gestures.ts` |
| Look recall, Morph, Freeze, layer enable | the same wrappers |
| MIDI CC → param / macro | `midiEngine.writeParam` / `handleMacroCc`, as the resolved host control |
| MIDI note, pad, keyboard, manual button, quantized action landing | `TriggerScheduler`'s optional `onLiveAction` hook |
| Anything deterministic (beat, bar, onset, marker) | **nowhere** — `isDeterministicSource` excludes it |

The export's `TriggerScheduler` is constructed without a hook, so a replayed
trigger cannot record itself.

### Replay

Continuous lanes are an **overlay**, never a store write: they enter
`modulationRuntime` as the base, the same seam a human drag writes to. Discrete
events do write the store, inside a new `projectStore.runSilently` scope, so
replay leaves neither an undo entry nor a dirty flag.

`runSilently` scopes the store rather than duplicating a silent variant of
every action, which keeps one implementation of what a Look recall means.

### Rejected

- **Extending `ActionTarget`.** It is the trigger engine's vocabulary and
  addresses Looks by slot. A Take addresses them by stable id.
- **An `origin` enum as the anti-recursion mechanism.** Kept on the event as
  diagnostics; not load-bearing.
- **Writing lanes to the store on every frame.** Thousands of writes per
  second, undo pollution, and a dirty document from pressing play.

### Bugs found in B

1. **The resting sample and the first movement shared a timestamp**, so the
   movement overwrote the resting value and the whole stretch before a gesture
   replayed at the value the performer dragged *to*. Fixed by backdating the
   resting sample one sample period. Caught by the record→replay round trip.
2. **A Take-replayed morph committed a `morphEvent`**, so the next export
   replayed the same gesture twice — once from the Take, once from history —
   and every replay dirtied the project. `ActiveMorph.record` now says who owns
   the record.
3. **Seeking back before a Take's first Look recall left the Look on screen.**
   A recall replaces params, modulations and triggers, and nothing remembered
   what had been there. Measured live: a recall at 1.77 s still showed at a
   seek to 0.2 s. Fixed with a lazily-captured `lookCore` in the baseline.

### Safe to proceed?

Yes.

---

## v0.7C — Minimal automation editing

Edit operations are pure `Take → Take` in `src/performance/take/edit.ts`, so
the store wraps each in one undo entry and the replay evaluator needs no
invalidation.

**Trim** is the substantive one. It plants a sample at each new boundary so
replay begins at the value the gesture actually had there, and it folds
trimmed-off state back in: a Take cut to start after its Freeze still replays
frozen, and a morph whose window was cut away is re-emitted as a recall of its
target — the state the kept stretch inherits. Only the last event of each
identity, in recorded order.

**Points are addressed by index, events by stable id.** An event is something
the performer did and may want to move later; a point is one sample of a
gesture with no identity worth persisting. Thirty-six thousand string ids would
triple a Take's size for nothing.

### Simplification, measured

Ramer–Douglas–Peucker with the tolerance in the **value** domain — vertical
distance to the chord, not perpendicular, because perpendicular mixes seconds
into the value domain and makes the tolerance depend on gesture speed.

| Gesture | Raw | Simplified | Removed | Max error |
|---|---|---|---|---|
| 10 s slider move (in, out) | 600 | ≤ 8 | > 98 % | 0.004 |
| 1 min, 6 lanes, continuous hand | 21 600 | 3 994 | 81.5 % | 0.00395 |
| 10 min, 6 lanes, continuous hand | 216 000 | 40 061 | 81.5 % | 0.00399 |

Tolerance is `0.004 × span` — about one pixel of a 300 px fader.

Known debt: RDP is O(n²) worst case. A pathological ten-minute lane where every
sample reverses direction takes ~7 s once, at record stop. A real ten-minute
six-lane performance simplifies in well under a second.

### Safe to proceed?

Yes. No NLE creep: no clips, no tracks, no waveform, no curve handles.

---

## v0.7D — MIDI / Looks / Morph / layer capture

MIDI is captured as the semantic host control it resolved to. CC → a parameter
or macro value; note → a synthesized trigger, captured at the scheduler. Replay
needs no device and does not depend on a mapping that may since have been
reassigned.

The **signature Take** (§96) is committed as a project fixture,
`tests/fixtures/v07-signature.material`, generated by
`scripts/generate-signature-take.mjs`. Twelve seconds containing every control
class the contract admits: a Look recall, a parameter drag, a layer opacity
ramp, a macro sweep, a two-second morph, a Freeze pair, and a layer faded then
muted. `tests/take-signature.test.ts` runs the whole gate matrix against it.

Two things the fixture taught, both now comments in the code:

- **A Look recall REPLACES the modulation set.** A Look pinned with no mappings
  silently removes what a later Freeze event would have frozen. Correct, and
  invisible until something depends on it.
- **A 25 fps render has no frame at 2.5 s.** Cross-rate comparison has to name
  times every rate can land on, or it fails for a reason that is not a bug.

### Safe to proceed?

Yes.

---

## v0.7E — Deterministic replay + export

One canonical evaluator, `src/performance/take/evaluate.ts`, used by preview,
seek and export. The Take is evaluated **inside** `createFrameEvaluator`, which
is what makes stateful preroll correct for free: the runner already calls
`evaluate(f)` for every frame from zero.

`setAuthorityLayerEnabled` is the single method the engine gained. Layer
visibility is not expressible as opacity 0 — `LayerHost` deliberately keeps
drawing an invisible layer so a stateful branch does not lose its accumulation,
while disabling stops the branch.

### Gate results

| Gate | Result |
|---|---|
| Anti-noop (Take deselected) | frames differ |
| Time-liveness | 20+ distinct values over 12 s |
| Event-liveness | removing the Look recall changes the render |
| Repeat | 12/12 identical |
| Full vs subrange | identical at three offsets, 165 global frames |
| Cross-FPS 24/25/30/60 | identical at four composition times |
| Seek-equals-walk | identical dispatch sequences |
| Automation through preroll | a step at t = 2 is applied over the whole 0→8 walk |

The harness itself was wrong first: it constructed the evaluator at
`startSec` instead of 0, and the full-vs-subrange gate caught it. That is what
the gate is for.

### Safe to proceed?

Yes.

---

## v0.7F — Performance UX + QA / release

### UI

REC / PLAY TAKE / STOP sit in the PERFORM strip with everything else a hand
touches mid-song, plus `R` and `T` on the keyboard. Never in a settings panel.

The editor is a ruler, one polyline per lane, one tick per event, and three
buttons. Verified rendering in the running app.

### Measurements

**Idle overhead** (§136), same scene, four capture states:

| State | fps | delta |
|---|---|---|
| capture off | 119.8 | — |
| armed, not recording | 119.3 | −0.4 % |
| recording, idle hands | 119.9 | +0.1 % |
| recording, two lanes at 60 Hz | 119.2 | −0.5 % |
| replaying a Take | 119.9 | +0.1 % |

All within measurement noise. Recording costs a boolean per frame when nobody
is using it, asserted structurally as well as measured.

**Replay cost** (§137), binary-searched lanes:

| Take | Cost |
|---|---|
| 1 min, 6 lanes (3 994 pts) | 0.29 µs/frame |
| 5 min, 6 lanes (19 992 pts) | 0.27 µs/frame |
| 10 min, 6 lanes (40 061 pts) | 0.33 µs/frame |

Flat in take length, which is the point of the binary search (§138).

**Take size** (§134/§135), six lanes moving continuously — a deliberate worst
case; real performances touch two or three and pause:

| Length | Raw samples | Stored | kB | kB/min |
|---|---|---|---|---|
| 1 min | 21 600 | 3 994 | 96 | 96 |
| 5 min | 108 000 | 19 992 | 494 | 99 |
| 10 min | 216 000 | 40 061 | 996 | 100 |

Four-decimal storage cut this by 42 % (1.73 MB → 996 kB at ten minutes) for a
time error of 0.05 ms and a value error eighty times under the simplification
tolerance already accepted.

**Soak** (§139/§140): 11 minutes, 141 cycles of record → replay → six seeks →
simplify → delete.

| | first half | second half |
|---|---|---|
| heap | 53.0 MB | 55.3 MB |
| fps | 112.8 | 119.4 |
| textures | 0 growth | 0 growth |
| geometries | 0 growth | 0 growth |

Heap oscillated 39–69 MB throughout; the +2.3 MB between half-averages is
inside that band. The v0.6.x baseline recorded ~12 MB retained growth per five
minutes of churn, so **no v0.7-specific retained growth is detectable above
existing noise** (§141). Zero GL errors, take count stable.

### QA scenarios

**Rapid Look / Morph while recording** (§144): twelve Look recalls and three
morphs in 2.2 s. 25 events captured, **zero `morphEvents` written**, no stale
morph left armed. One gesture, one record — holding under churn.

**Freeze churn with seeks** (§145): ten alternating Freeze events, then six
out-of-order seeks run twice. Both rounds byte-identical — freeze counts, Look
ids and resolved opacities all reproduce.

**Layer routing** (§146): a Take driving layer B's opacity while an
`image.luminance` route from layer A also drives it. Stored 0.8, Take base
0.782, resolved 0.982. The Take supplies the base and the route adds on top —
no ownership conflict, which is the whole reason the Take enters at the base
seam.

**Output passivity** (§147/§148): structural. `outputBridge`, `replica`,
`outputLayer` and `outputChannel` import nothing from `performance/take`, so
the Output cannot evaluate a Take even by accident. It follows because the
editor's authority resolves the Take before publishing.

**Persistence** (§132): a recorded Take survives serialise → parse → replay
identically. Selecting one does not dirty the project; editing one does, as a
single undo entry.

### Bug found in F

**A Take-replayed Look recall left the Look applied after seeking back before
it.** Recorded above under B, because the fix belongs to the baseline contract;
it was found here, by a live probe, and by nothing the test suite was asking.

### Known debt

- `simplifyLane` is O(n²) worst case (~7 s on a pathological ten-minute lane
  where every sample reverses direction; well under a second on a real one).
- `liveTarget.morphToLook` still writes a `morphEvent` for a DETERMINISTIC
  trigger morph that the export also re-creates from the trigger. Pre-dates
  v0.7 and is visually a no-op; `ActiveMorph.record` is the mechanism that
  would fix it. Backlogged.
- Physical MIDI hardware remains untested — all MIDI validation used the
  virtual transport, as in v0.4.

### Safe to release?

Yes.

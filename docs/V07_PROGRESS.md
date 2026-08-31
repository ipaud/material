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

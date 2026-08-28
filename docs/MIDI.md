# MIDI

Phase 14. MATERIAL is physically playable from a MIDI controller. MIDI is
**live-class input**: it drives the instrument in the room, and it is never
part of a deterministic export (see “Live vs deterministic” below).

## Backend

**Web MIDI inside Electron** (no native dependency). The renderer calls
`navigator.requestMIDIAccess({ sysex: false })`; the main process grants the
permission for our own renderer only.

Platform note (documented in DECISIONS.md): Chromium ≥ M119 routes **all**
Web MIDI access through the `midiSysex` permission gate, even sysex-free
requests. The main process therefore grants `midi` and `midiSysex` at the
permission-handler level, while the renderer only ever requests
`sysex: false` — `access.sysexEnabled === false` is verified in QA. No sysex
data can flow. All other permissions remain denied.

The engine sits behind an injectable `MidiTransport` seam
([src/midi/transport.ts](../src/midi/transport.ts)): `WebMidiTransport` in
production, `FakeMidiTransport` in tests. System messages (clock, active
sensing, start/stop, program change, aftertouch, sysex) are dropped inside
the transport parser and never reach the engine.

MIDI access is requested **only when needed**: when a project containing
MIDI mappings loads, or when the user presses ENABLE MIDI / starts a Learn.

## Device model

`MidiMapping.deviceId` stores the platform id; `deviceLabel` stores
`manufacturer · name`. Rebinding on hot-plug: exact id first, then a
**unique** label match (CoreMIDI ids change across reconnects); an ambiguous
label match stays unbound rather than guessing hardware. Mappings persist in
the project when the controller is offline — rows show OFFLINE, nothing is
deleted, and a compatible device re-attaches automatically on hot-plug.

## CC mappings — ABSOLUTE + pickup

A CC mapping drives its parameter in **ABSOLUTE** mode: the knob is the base
value. Shaping reuses the modulation vocabulary (invert → curve → min/max
window; smoothing via the shared `SmoothingState` EMA). The schema reserves
`mode: 'modulate'` for a future Signal-system contribution mode; only
`absolute` is implemented.

**Pickup (soft takeover, default).** A knob whose physical position differs
from the software value must cross the current normalized value before it
takes control. Until then the row shows PICKUP (waiting); after crossing it
shows LIVE. `jump` mode is available per mapping. After a Look apply, a
morph completion, undo/redo or a preset change, engaged pickup mappings
whose knob no longer matches drop back to waiting — switching Looks with
keys 1–9 never causes a knob-position jump.

Gestures are one undo entry: CC movement runs through the store's transient
system and commits ~0.6 s after the last event.

Relative encoders are **future work** — the mapping metadata (messageType +
mode) leaves room for `relative` variants; only absolute CC is implemented.

## Note mappings — trigger actions

Note On fires a trigger action through the **existing** TriggerScheduler
(`fireLive`) — apply/morph/freeze/pin/next/prev — with the existing
quantization (Off / Beat / Bar / 2 / 4 Bars); there is no second quantizer.
A pad pressed mid-bar with quantize=Bar executes exactly on the boundary.
Velocity is stored on the synthesized trigger (`amount = velocity/127`) and
shown in diagnostics; velocity-scaled pulses are future work. Note Off has
no semantics in this phase.

## MIDI Learn

- Parameter: right-click a technique parameter → **MIDI Learn** → move a
  control → bound. CC learn requires a meaningful movement (≥ 4 steps from
  the control's first seen value) so controller noise and the first stale
  value can't bind.
- Action: MIDI panel → choose action (+ slot / quantize) → **LEARN NOTE** →
  press a pad. Note On only.
- ESC cancels. Learning the same target again replaces the old binding.
- After binding, the row shows device, channel and CC/Note number.

## Interaction rules

- **Freeze (§17):** a parameter whose modulation mapping is frozen ignores
  MIDI entirely (row shows FROZEN). The knob may move; the frozen state
  survives. Unfreeze is explicit. (Our freeze holds the modulation
  contribution; blocking the base too is what makes a frozen look
  physically safe under a live controller.)
- **Morph (§19):** while a morph is armed, CC application is suspended (row
  shows MORPH) — the overlay owns the state, and stored Look endpoints can
  never absorb knob movement. On completion the document holds the target
  look; pickup re-evaluates and MIDI resumes after crossing.
- **Looks (§18):** applying a look changes software values, not knob
  positions → affected mappings return to WAITING FOR PICKUP.
- **Export (§26):** while an export is running, **all incoming MIDI is
  ignored** at the engine entrance. Verified: exporting the same document
  with and without a continuous CC/note stream produces byte-identical
  files. (Mid-export document writes would rebuild instanced geometry from
  live params — blocking input at the source is the guarantee.)

## Live vs deterministic

Raw knob movement and pad presses are not exportable and never will be by
accident: synthesized triggers use source `midi:<mappingId>`, which is
live-class (`isDeterministicSource` → false). What **is** exportable is
deterministic state a MIDI action created: a pad-launched morph records a
`MorphEvent` on completion, and that event replays in export like any other.
Recording raw performance input is future work — the reserved
`PerformanceEvent {time, source, target, value}` shape stays unblocked.

## Evaluation order

```
base parameter        ← MIDI ABSOLUTE writes here (engaged CC, live only)
  → morph overlay     (armed morph replaces the state; MIDI suspended)
  → continuous modulation (FREEZE lives here; frozen target blocks MIDI)
  → trigger pulses
  → clamp
```

## Diagnostics

MIDI panel footer: events/sec, last CC (number=value), last note (+velocity),
LEARN armed. Per-row: live shaped value (imperative, UI-rate) and status
(LIVE / PICKUP / FROZEN / MORPH / OFFLINE).

## Latency (measured, virtual CoreMIDI device)

- MIDI event → parameter written to store: **0.17 ms mean, 0.5 ms worst**
  (40 samples).
- Store write → next rendered frame: **5.7 ms mean, 9.2 ms worst** (rAF).
- Total controller-to-pixels ≈ one display frame. No React work happens on
  the per-event path; UI readouts poll at UI rate.

## Exclusions (this phase)

MIDI Clock sync, MIDI output/LED feedback, sysex, motorized faders, OSC,
relative encoders, velocity→pulse scaling, controller preset library,
performance recording.

## Physical controller QA checklist

All MIDI validation to date used a **virtual CoreMIDI source**, not hardware.
The architecture, latency and pickup logic are verified; the *feel* is not.
Anyone with a controller should walk this list and tune the defaults:

- [ ] **Smoothing.** Default is 0 (raw). Sweep a knob fast and slow — if the
      image steps audibly, raise smoothing per mapping and consider a new
      default.
- [ ] **Pickup epsilon.** Currently 0.015 (1.5% of range). Too small and a
      knob feels like it refuses to catch; too large and it jumps. Test by
      applying a Look, then sweeping slowly through the software value.
- [ ] **Rapid CC.** Spin a knob as fast as it goes; watch for lag or stuck
      values. Endless encoders will misbehave — they are absolute-only in
      v0.2 (see Relative encoders above).
- [ ] **Multiple simultaneous knobs.** Move four at once, including two mapped
      to the same parameter family.
- [ ] **Pads.** Check velocity is reported in diagnostics; check double-hits
      at speed do not double-fire quantized actions.
- [ ] **Disconnect / reconnect.** Unplug mid-performance: mappings must show
      OFFLINE and survive. Replug: they must re-bind by name.
- [ ] **Look switch pickup.** Apply a Look from the keyboard while holding a
      knob still. The mapping must return to WAITING and not jump when the
      knob next moves.
- [ ] **Morph completion pickup.** Same check immediately after a morph
      commits.
- [ ] **Channel filtering.** If the controller sends on a non-zero channel,
      confirm learn captured it and omni behaves.

Until this list has been walked on hardware, MATERIAL's release notes say
physical controllers are untested. Do not claim otherwise.

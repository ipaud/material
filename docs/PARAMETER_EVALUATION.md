# Parameter Evaluation

The exact order a parameter value is assembled, per frame, everywhere —
preview and export share this pipeline function-for-function.

```
base value                     (slider / project state / engaged MIDI CC —
                                ABSOLUTE mode writes the base, live only)
  → morph overlay              (armed morph replaces base+mappings+triggers
                                with the interpolated look core — pure fn of t)
  → macros                     (Σ macro.value shaped × amount × paramSpan,
                                additive; live performance layer ON TOP of
                                look/morph state — never written into Looks)
  → continuous modulation      (signal × amount × paramSpan, additive; FREEZE lives here)
  → trigger pulses             (Σ envelope × amount × paramSpan, additive)
  → clamp to parameter range
  → final value → renderer uniforms
```

(Automation/keyframes will slot in between base and continuous modulation
when they gain a UI; the data model reserves the position.)

## Morph layer

While a morph is armed, the state at composition time `t` is a **pure
function** of `(sourceSnapshot, targetLook, startTime, endTime, curve, t)` —
`interpolateLookCore` at the curved progress. Seeking anywhere inside,
before, or after the window reconstructs the exact state; no scheduler
history is consulted. Crossing the end during playback commits the target
into the project as one undo entry and records a `MorphEvent`; export replays
those events with the same interpolation function.

Interpolation rules (tested in `tests/morph.test.ts`):

- Numbers lerp; booleans/enums/strings switch at the midpoint (p ≥ 0.5).
- A key present on only one side switches at the midpoint (absent = that
  side's technique default) — endpoints stay byte-exact.
- Different techniques: the whole block (id + params) switches at midpoint —
  no shader crossfade. Material identity likewise; material numerics lerp.
- Modulations matched by id: amount/min/max/smoothing lerp, topology switches
  at midpoint. Both frozen → frozen values lerp; mixed → winning side from
  the midpoint. **Unmatched** mappings fade: A-only rides amount×(1−p) to
  zero, B-only rises with amount×p.
- Triggers matched by id: envelope numerics lerp, topology switches at
  midpoint. Unmatched triggers hard-switch at the midpoint (exactly one side
  active at any p — no duplicate firings, no half-fired envelopes).
- Seed switches at midpoint.

Pulses stay live through a morph: the morphed core feeds the pipeline above,
so `morphed base → modulation → freeze → pulses → clamp`. A trigger only
sounds during the morph if it exists on the active side of the interpolation
(matched ids play throughout).

Musical durations resolve to exact seconds **at morph start**; a BPM change
mid-morph does not move the end time. Quantized starts use the same
`nextBoundary` as trigger quantization.

## Where FREEZE sits — a deliberate choice

Freeze captures the mapping's **shaped continuous-modulation value** and holds
it. Pulses apply **after** freeze, on top of the frozen value.

Why: freeze means "hold this sustained state" — the breathing, the drift, the
level the music had settled into. Pulses are accents. A frozen image that
still snaps on the beat is the musically useful combination; freezing the
accents too would just mute the instrument. To silence pulses, disable the
trigger mapping — a separate, explicit act.

## Pulse combination — additive, then clamp

Multiple overlapping pulse envelopes on one parameter **sum**, and the final
value clamps to the parameter's definition range. Rapid hits therefore build
energy (a drum roll ramps the parameter up) instead of plateauing, which is
what max-combining would do. The clamp is the safety net; it is per-parameter
and always the last step.

Negative `amount` gives downward pulses (polarity), and mixed-sign pulses on
the same parameter interfere like signals — intended.

## Determinism classes

| Class | Sources | Preview | Export |
|---|---|---|---|
| Deterministic | beat, bar, divisions, onset, markers | ✓ | ✓ identical schedule |
| Live | manual button, keyboard shortcuts, MIDI | ✓ | **absent by design** |

Deterministic pulse values are **pure functions of composition time**: the
value at `t` is the sum of envelopes from trigger events within the envelope
window before `t`, and those event times come from grid arithmetic, the
precomputed onset event list, or marker positions — never from a UI tick.
Consequences, all by construction rather than by bookkeeping:

- Seeking to `t` shows exactly what playing into `t` would show.
- Loops cannot double-fire or drop pulses.
- Export at any fps reproduces preview exactly.

Discrete actions (freeze, look switches, resets) do need execution. One
scheduler class fires every deterministic event in `(lastTime, now]` exactly
once; preview drives it from the playback clock, export drives it frame by
frame against a **working copy** of the project — exported freezes and look
switches never touch the live document. Seeks and loop restarts reset the
scheduler and drop pending quantized actions: events from before a seek can
never fire after it.

Live-class triggers execute in preview (optionally quantized to the next
beat/bar/2-bars/4-bars boundary) but are **not reproduced in export** — an
unrecorded performance is not pretended into the render. When performance
recording exists (`PerformanceEvent {time, type, source, value}` is the
reserved shape), recorded live input will replay through the same scheduler.

## Cooldown

A mapping's cooldown suppresses events closer than `cooldownSec` to the last
accepted one. For pulses this is applied over a bounded lookback window
(envelope span + 8 cooldowns) — deterministic because the same pure filter
runs everywhere. For discrete actions the scheduler tracks the last firing;
that chain resets at seeks, identically in preview and export.

## Macro layer

Macros (Phase 15) are pure and stateless: `applyMacros(base, macros, def)`
adds `amount × shaped(macro.value) × paramSpan` per enabled mapping, clamped
to the definition range, BEFORE continuous modulation. Macro values are
project state — export uses the stored snapshot; live macro movement is
unrecorded live input (see docs/PERFORMANCE.md). A frozen modulation rides
on the macroed base: freeze holds the modulation's shaped value, not the
final number, so moving a macro under a frozen mapping still shifts the
final value by the macro delta — freeze protects the modulation layer, the
macro is the performer's hand.

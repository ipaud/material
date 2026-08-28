# Parameter Evaluation

The exact order a parameter value is assembled, per frame, everywhere —
preview and export share this pipeline function-for-function.

```
base value                     (slider / project state)
  → continuous modulation      (signal × amount × paramSpan, additive; FREEZE lives here)
  → trigger pulses             (Σ envelope × amount × paramSpan, additive)
  → clamp to parameter range
  → final value → renderer uniforms
```

(Automation/keyframes will slot in between base and continuous modulation
when they gain a UI; the data model reserves the position.)

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
| Live | manual button, keyboard (future), MIDI (future) | ✓ | **absent by design** |

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

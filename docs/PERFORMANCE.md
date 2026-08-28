# Performance Workspace

Phase 15. CREATE builds systems; PERFORMANCE plays them. The workspace is a
strip under a dominant output: LOOKS (9 slots) → MACROS (up to 8) → ACTIONS
(freeze / pin / morph / pads / quantize) → STATUS (bar·beat, BPM+tap, queue
line, signal dots, MIDI). Tab toggles a minimal HUD (output + looks +
macros + compact status; a FROZEN chip stays visible).

## Macros

One 0–1 control fanned out to several parameters — depth for designing,
simplicity for playing. Definition lives in CREATE (Inspector → Macros):
per-target `amount / min / max / invert / curve / enabled`. Evaluation is
pure and stateless (`applyMacros`), sharing the modulation arithmetic
(`amount × shaped × span`, additive, clamped to the parameter range):

```
look/morph state → base params
  → MACROS                    (live performance layer)
  → continuous modulation     (freeze holds its shaped value here)
  → trigger pulses
  → clamp
```

Key properties:

- Macros ride ON TOP of look/morph state — applying a Look or completing a
  Morph never resets or absorbs macro values, and macro movement never
  writes into stored Looks or base params.
- Macro VALUES are project state (persisted, deterministic in export as a
  snapshot). Live macro MOVEMENT is unrecorded live input and does not
  export as a history (§41) — the reserved PerformanceEvent shape covers it
  later.
- MIDI CC → macro uses the Phase 14 engine unchanged (`targetType:
  'macro'`): pickup/soft-takeover against the macro's current value,
  smoothing/curves/device handling shared. External macro changes re-arm
  pickup exactly like look switches do for parameters.
- Slider gestures and MIDI gestures both coalesce into one undo entry via
  the transient system.

## Quantized performance actions

One global setting (OFF / BEAT / BAR / 2 BARS / 4 BARS, default BAR,
persisted) governs Look apply, Morph starts, and keyboard 1–9 in the
workspace. Everything rides the ONE `TriggerScheduler` — queued actions are
its pending list (`getPending`), shown on the tile (dashed + QUEUED) and in
the status line (`LOOK 5 QUEUED → 4.4 BEATS`). Esc cancels pending actions
(never fires them); with nothing queued, Esc cancel-and-keeps an armed
morph. No BPM grid → quantized requests execute immediately rather than
silently dropping.

## Trigger pads

Four large pads (Z X C V) firing live-class trigger actions. A pad EMBEDS
its trigger payload — `project.triggers` is look-core state and is replaced
by every look apply/morph commit, so pads deliberately do not reference into
it (found the hard way in QA: referenced pads died after the first look
switch). `velocityScale` is reserved for MIDI-velocity → pulse-amount
scaling (future).

## Keyboard

| Key | Action |
| --- | --- |
| Space | play/pause |
| 1–9 | apply look (quantized in PERFORMANCE) |
| Shift+1–9 | overwrite slot with current state |
| P | pin current look |
| F | freeze all / release all |
| Q | cycle quantization |
| M | morph to selected target (right-click a tile to select) |
| Z X C V | trigger pads |
| Tab | minimal HUD |
| Esc | cancel queued action / cancel-and-keep morph |

## State safety

Live actions never silently overwrite stored Looks, presets, media or
mappings — divergence shows as `●` on the active tile; UPDATE LOOK remains
explicit (Inspector). Pinning with all 9 slots full pins unslotted and says
so; slots are never stolen. Undo: macro gesture = one entry; freeze, pin,
look apply, morph completion as before; pad pulses create no history.

## PerformanceEvent readiness (§43)

Everything the surface does is already funnelled through singular,
timestampable chokepoints, so future recording is a tap, not a redesign:

| Live gesture | Chokepoint today | Event shape later |
| --- | --- | --- |
| Macro movement | `setMacroValue(id, v)` | `{time, source:'macro:id', target, value}` |
| Look switch | scheduler `execute('applyLook')` | `{time, 'look', slot}` |
| Trigger pads / MIDI notes | `TriggerScheduler.fireLive` | `{time, 'trigger', mappingId, velocity}` |
| Freeze | `freezeAll`/`freezeMapping` | `{time, 'freeze', mappingId}` |
| Morph | already recorded as `MorphEvent` | unchanged |
| MIDI CC | `midiEngine.writeParam`/`handleMacroCc` | `{time, 'cc', mappingId, value}` |

Required future change: a recorder subscribing at those chokepoints plus a
replay path feeding the export evaluator (the deterministic scheduler
already replays recorded shapes — MorphEvents prove the pattern).

Until then the UI tells the truth: live controls are not recorded (tooltip
on the MIDI status chip); export reproduces deterministic timeline state
only.

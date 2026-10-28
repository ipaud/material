# Performance Workspace

Phase 15. BUILD builds systems; PERFORM plays them. The workspace is a
strip under a dominant output: LOOKS (9 slots) → MACROS (up to 8) → ACTIONS
(freeze / pin / morph / pads / quantize) → STATUS (bar·beat, BPM+tap, queue
line, signal dots, MIDI). Tab toggles a minimal HUD (output + looks +
macros + compact status; a FROZEN chip stays visible).

## Macros

One 0–1 control fanned out to several parameters — depth for designing,
simplicity for playing. Definition lives in BUILD (Inspector → Macros):
per-target `amount / min / max / invert / curve / enabled`. Evaluation is
pure and stateless (`applyMacros`), sharing the modulation arithmetic
(`amount × shaped × span`, additive, clamped to the parameter range):

`min` / `max` shape each destination's output window; signed `amount` sets its
direction and strength. Invert and curve shape the macro's response. Each
destination exposes these controls in BUILD.

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

| Key       | Action                                                  |
| --------- | ------------------------------------------------------- |
| Space     | play/pause                                              |
| 1–9       | apply look (quantized in PERFORM)                   |
| Shift+1–9 | overwrite slot with current state                       |
| P         | pin current look                                        |
| F         | freeze all / release all                                |
| Q         | cycle quantization                                      |
| M         | morph to selected target (right-click a tile to select) |
| Z X C V   | trigger pads                                            |
| Tab       | minimal HUD                                             |
| Esc       | cancel queued actions / cancel-and-keep morph           |
| G         | mutate: generate a candidate from CURRENT               |
| Shift+G   | mutate again, using the candidate as parent             |
| B (hold)  | audition the candidate; release returns to CURRENT      |
| Enter     | apply the candidate (quantized)                         |
| Backspace | discard the candidate                                   |

## State safety

Live actions never silently overwrite stored Looks, presets, media or
mappings — divergence shows as `●` on the active tile; UPDATE LOOK remains
explicit (Inspector). Pinning with all 9 slots full pins unslotted and says
so; slots are never stolen. Undo: macro gesture = one entry; freeze, pin,
look apply, morph completion as before; pad pulses create no history.

## PerformanceEvent readiness (§43)

Everything the surface does is already funnelled through singular,
timestampable chokepoints, so future recording is a tap, not a redesign:

| Live gesture              | Chokepoint today                        | Event shape later                          |
| ------------------------- | --------------------------------------- | ------------------------------------------ |
| Macro movement            | `setMacroValue(id, v)`                  | `{time, source:'macro:id', target, value}` |
| Look switch               | scheduler `execute('applyLook')`        | `{time, 'look', slot}`                     |
| Trigger pads / MIDI notes | `TriggerScheduler.fireLive`             | `{time, 'trigger', mappingId, velocity}`   |
| Freeze                    | `freezeAll`/`freezeMapping`             | `{time, 'freeze', mappingId}`              |
| Morph                     | already recorded as `MorphEvent`        | unchanged                                  |
| MIDI CC                   | `midiEngine.writeParam`/`handleMacroCc` | `{time, 'cc', mappingId, value}`           |

Required future change: a recorder subscribing at those chokepoints plus a
replay path feeding the export evaluator (the deterministic scheduler
already replays recorded shapes — MorphEvents prove the pattern).

Until then the UI tells the truth: live controls are not recorded (tooltip
on the MIDI status chip); export reproduces deterministic timeline state
only.

## CURRENT / CANDIDATE (Phase 16)

CURRENT is the committed project state — what is on output. A CANDIDATE is a
generated mutation held **entirely outside the project**: it lives in
`candidateRuntime`, never in the store, so generating one cannot alter what
the audience sees.

```
CURRENT ──MUTATE──▶ CANDIDATE ──┬── hold B ── audition on output
                                ├── APPLY ─── becomes CURRENT (quantized)
                                ├── PIN ───── saved as a Look, output untouched
                                ├── MUTATE AGAIN ── lineage step
                                └── DISCARD
```

### Preview isolation

`resolveOverlay()` returns the candidate core as a pure value consumed by the
modulation runtime for rendering only — the same mechanism as the morph
overlay. Nothing writes to the document, so releasing preview restores
CURRENT (freeze state included) **by construction**, not by save/restore
bookkeeping. Preview is hold-to-audition (button or `B`), never a toggle, so
the safe state is the one you fall back to when you let go.

Discrete trigger ACTIONS keep running against CURRENT while previewing: the
scheduler is fed from `project.triggers` by the engine bridge, and the
candidate runtime never touches it. Only the visual layers — modulation and
pulses — see candidate topology, so a candidate whose triggers would apply
looks or freeze mappings cannot do so from inside a preview.

### Quantized apply

Apply honours the global performance quantization through the ONE scheduler
(action `applyCandidate`). Queued applies are visible and safe: regenerating,
discarding, resetting or pressing Esc sweeps the pending entry, and commit
re-checks the candidate id, so a stale candidate can never land. Measured
boundary error at 78.03 BPM: 0 ms.

### Mutation model

`mutateLookCore(parent, definition, seed, intensity, locks)` is pure:
identical inputs always produce an identical candidate. Values wander ±sigma
of each parameter's EXPLORE range (never its raw min/max). Modulation
source/target topology is never randomized — only amount / smoothing / curve.
Macros are never touched: they are the performer's hands, not material.
Material is not mutated in v0.2 because material state reaches the renderer
from the document rather than through the per-frame transform, so a mutated
material would be invisible in preview.

Two tuning rules came out of measuring 36 candidates across the six official
looks:

- **Sparsity beats magnitude.** Touching every eligible parameter produced
  10–15 changes per candidate — not a variation but a new random state — and
  the changes compounded into near-black results. A mutation rate per
  intensity (LOW 0.22 / MED 0.4 / HIGH 0.6) brought that to ~4.6 changes and
  kept the parent recognisable.
- **Coverage correlation.** Several parameters each shrink how much of the
  frame carries image (smaller elements, wider gaps, higher cut threshold,
  stronger luminance-to-scale). Individually good, together lethal. Parameter
  definitions now declare `explore.coverage: 'up' | 'down'`, and a candidate
  may make at most ONE coverage-reducing move; coverage-increasing moves are
  unrestricted.

Intensity: LOW = 0.10 sigma, MED = 0.25 (the established Explore sigma),
HIGH = 0.45. Locks exposed in Performance: TECH (all technique params, the
superset), TIME (temporal/offset/scan sections), COLOR (sampling/colour
sections), SIGNALS (modulation shaping). Detailed per-parameter locks stay in
Explore.

### Persistence

A candidate is transient and is **not** saved with the project or captured by
autosave — it is an audition, not a document state. Pinning or applying turns
it into ordinary project state, which persists normally. Undo/redo and
project switches drop the candidate and sweep any queued apply.

### Undo

Generate, preview, regenerate and discard create no history. Apply is one
undo entry; Pin is one undo entry.

### Export

Export renders committed CURRENT state only. An un-applied candidate is
live-only and cannot reach a frame: the export evaluator's action target
implements `applyCandidate` as an explicit no-op, and preview lives in the
render overlay that export never consults.

## Creative Expansion 01 — measured (CE1H)

Apple Silicon, 1080p composition, clean process, fps as the engine's EMA over
a settled scene. Frame time is CPU-side only (GPU work is asynchronous), so
fps is the honest number here.

| Scene | fps | Cost class |
|---|---|---|
| Mosaic (baseline) | 119 | LIGHT |
| Feedback Zoom | 120 | LIGHT |
| Feedback Bloom | 120 | MEDIUM |
| Time Field | 120 | LIGHT |
| Slit Scan | 120 | LIGHT |
| Echo | 120 | LIGHT |
| Flow Displace | 121 | MEDIUM |
| Motion Mosh | 121 | MEDIUM |
| Directional Smear | 120 | MEDIUM |
| Reaction Diffusion | 121 | MEDIUM |
| Cellular | 120 | LIGHT |

No public technique drops the editor below high-refresh at 1080p. Cost classes
describe relative GPU work, not framerate — MEDIUM techniques run extra passes
(flow, blur, solver iterations) and that shows at 4K or with Output mirroring.

### VRAM per primitive

| Component | MB | Allocated when |
|---|---|---|
| Feedback surface | 15.82 | a feedback technique is active |
| Temporal atlas | 7.88 | a temporal technique is active |
| Transition snapshot | 12.78 | only while a morph reveal is open |
| Optical flow | 1.32 | a technique asks for flow |
| JS heap | ~22 | always |

Allocation is demand-driven and released when the need ends — the transition
snapshot returns to zero on completion *and* on cancel, and allocations equal
disposals across a full soak.

### Worst realistic case

Live source + temporal history + optical flow + a feedback surface + an open
morph reveal ≈ **37.8 MB** of editor GPU allocations. The Output window
renders locally with its own targets and never receives GPU state, so its cost
is separate and additive, not shared.

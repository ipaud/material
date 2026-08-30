# v0.4A — Image / Motion Signals — progress

Checkpoint log. One entry per phase: decisions, tests, measurements, blockers.

---

## A0 — pre-work — COMPLETE

Four defects found while mapping the codebase, all blocking later phases. Every
one has the same shape: a system that looked healthy because the thing it had
stopped doing was perfectly reproducible.

### R1 — optical flow was frozen for generator sources in preview

`sourceFrameKey()` is `${texture.uuid}:${sourceFrameCounter}`, and
`sourceFrameCounter` only ticks from `requestVideoFrameCallback` — which exists
only on `HTMLVideoElement`. A generator's texture is one stable object, so the
key never changed and `OpticalFlowField.update()` early-returned forever.

**Measured, clean process, `noise` generator + Motion Mosh, 3 s of preview at
120 fps:**

| | flow updates in 3 s |
|---|---|
| before | **0** (counter stuck at 1) |
| after | **360** |

The whole Motion pack — Flow Displace, Motion Mosh, Motion Trails, Flow
Feedback, Motion RGB, Directional Smear — was dead in preview on any generator
source. Export was unaffected because CE1H passes explicit frame keys, which is
precisely why the determinism matrix read 12/12 the whole time. A frozen field
is perfectly reproducible.

Fix: a `generatorRevision` counter incremented in `renderGenerator()` when it
actually draws, folded into the frame key. The visual-signal reducer needs the
same token in A2.

### R2 — FREEZE stored two different quantities

`shapeMappingValue`'s frozen branch returned `clamp(frozenValue,0,1)` and
**skipped** the `min + (max-min)·v` scaling. Preview stored the pre-range value
(`smoothing.peek`); export stored the post-range one. So freezing a mapping with
min 0.2 / max 0.8 already jumped its contribution to the full span, and the two
paths disagreed about what the stored number meant.

This blocks A7: widening the Min/Max sliders to −1..1 for centred motion would
make a frozen "still" `motion.x` output 0.0 instead of 0.5 — a full-scale jump
at the instant of freeze. FREEZE and centred motion would have been mutually
exclusive.

Fix: extracted `shapedUnitValue()` (the 0..1 pre-range value, which is what
FREEZE stores in both paths); `shapeMappingValue` applies the range on top,
frozen or not.

### R3 — the Output never received two fields the replica reads

`toFrameMsg` dropped `sourceParams` and `transition`, though `FrameStateMsg`
declares both and `replica.ts` reads both. Consequences on the shipping build:
generators rendered on the Output with **unmodulated** params (falling back to
the low-rate `RenderInputs`), and CE1G morph transitions never appeared there at
all. v0.4A would deepen this, since visual signals modulate source params.

Fix: forward both. Still resolved values only — the replica evaluates nothing,
asserted by test.

### R4 — the source-param fallback was dead code

`this.lastSourceValues ?? evalSources(...)` with `lastSourceValues` initialised
to `{}`: `{} ?? x` is `{}`, so the fallback never fired and every `source.*`
mapping was skipped on the first frame. Now `null` until the first `transform()`,
which also gives A1 a clean way to distinguish "not evaluated yet" from
"evaluated to nothing".

### Minor

- `StatusRail` read `v.beat`, an id `evalSources` never emits (the grid sources
  are `beat:1/4` …), so the beat dot never lit. Now reads the quarter-note phase.
- `OpticalFlowField.bytes` claimed RGBA16F and under-reported by ~40%; the
  targets are `FloatType` (RGBA32F).

### Doc debt from CE1H

`MODULATION.md` and `EXPORT_PIPELINE.md` still described a **fresh** smoothing
state per export and `t = startSec + i/fps`. Both changed in CE1H. Corrected
before building on them.

### Gates

lint 0 · typecheck 0 · **1021 tests** · `tests/a0-prework.test.ts` locks all four.

**Proceeding to A1.**

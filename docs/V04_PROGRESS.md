# v0.4 — Image / Motion Signals, phases B → E

v0.4A (vocabulary of three, GPU reduction, calibration, export determinism) is
recorded in [V04A_PROGRESS.md](V04A_PROGRESS.md). This file continues from
there.

## B — signal vocabulary expansion

### Decisions

**Six signals added, three deferred families rejected for now.** Every added
signal had to answer the same six questions before a line was written: what it
measures, why it is not another signal, what it unlocks, its domain, its
calibration, and what a dead implementation would look like.

| Signal | KEEP / REJECT | Why |
|---|---|---|
| `image.contrast` | **KEEP** | standard deviation of luma — a real statistic, free from the ladder given `L²` |
| `image.edgeEnergy` | **KEEP** | total variation per texel; separates graphic from soft material at equal contrast |
| `motion.y` | **KEEP** | completes the directional pair; mirrors `motion.x` exactly |
| `motion.activity` | **KEEP** | area, not speed — proven distinct by fixture and by 11× vs 4× dynamic range on video |
| `motion.centroidX` | **KEEP** | position, the flagship capability: motion drives *where* rather than *how much* |
| `motion.centroidY` | **KEEP** | same, vertical |
| `motion.direction` | **DEFER** | atan2 is circular; nothing in the mapping system can use circular data yet (§21) |
| `motion.spread` | **DEFER** | second moment is interesting but not core until centroid workflows ask for it |
| RGB / colour energy | **DEFER** | no evidence they say anything luminance does not; easy is not a reason (§23) |

**Calibration became a per-signal choice rather than a pipeline stage.** Four
signals calibrate. Five do not, for three distinct reasons — intrinsic bounds,
an already-physical fraction, and coordinates that must not be moved. The
`SignalDef` states which and the store honours it; nothing runs through
calibration by default any more.

**Positional signals hold rather than snap.** When motion falls below
`CENTROID_MIN_TEXELS` the centroid is not a measurement — dividing noise by
noise produces a position that wanders the frame and looks exactly like
tracking. The reducer holds the last valid position and the scope reports
`HELD`, because a gesture that stops should leave the effect where it ended
without the UI claiming that is live data.

### Architecture

The ladder became **MRT**: one to three RGBA32F attachments carried through
every level together, chosen by demand. Six new sums did not fit in four
channels, and the alternative — a second and third ladder — would have tripled
the readback stalls, which are what this subsystem actually pays for.

```
plane 0   R = L        G = L²      B = |∇L|    A = 1
plane 1   R = |f|      G = f.x     B = f.y     A = moving ? 1 : 0
plane 2   R = u·|f|    G = v·|f|   B = —       A = —
```

Two configurations exist, not nine:

| demand | planes | draws | readbacks | bytes | ladder VRAM | flow woken |
|---|---|---|---|---|---|---|
| nothing | — | 0 | 0 | 0 | 0 | no |
| any image signals (1 or 3) | 1 | 4 | **1** | **192** | 0.60 MB | **no** |
| any motion signals (1 or 6) | 3 | 5 | **1** | **720** | 2.81 MB | yes |
| all nine | 3 | 5 | **1** | **720** | 2.81 MB | yes |

Cost is flat in the number of signals — mapping one image signal costs exactly
what mapping three costs, and the same for one motion signal against six. The
extra draw in the motion configuration is the pack pass that stacks the three
final tiles so the CPU still pays for exactly **one** GPU sync.

Preview held **120 fps** in every configuration.

### Fixtures

GPU goldens, clean process, product path — all green (`allOk: true`):

| fixture | expected | measured |
|---|---|---|
| flat 0.5 | contrast 0, edge 0 | **0.000000**, **0.000000** |
| split 50/50 | luminance 0.5, contrast 0.5 | **0.500000**, **0.500000** |
| ramp | contrast 1/√12 = 0.288675 | **0.288670** |
| 16 stripes | contrast 0.5, edge ≫ split | 0.5, **0.096875** vs split 0.003125 |
| 16-cycle sine, full swing | edge ≈ stripes | **0.097941** |
| same sine at ¼ swing | edge ≈ ¼ | **0.024583** |
| flow up / down | motion.y 1 / 0 | **1.000000** / **0.000000** |
| flow up | activity 1 | **1.000000** |
| quarter-frame patch | activity 0.25 | **0.250000** |
| patch left / right | centroidX 0.125 / 0.875 | **0.125** / **0.875** |
| patch top / bottom | centroidY 0.125 / 0.875 | **0.125** / **0.875** |
| still | centroid INVALID | **invalid**, activity 0 |

`centroidTop` is the fixture that pins the vertical convention — the shader
flips v so that 0 is the top of the image, the way a person describes it, and
nothing else in the codebase records that choice.

Anti-noop gates, one per added signal: contrast replaced by a constant fails
the flat/split pair; edge replaced by a constant fails stripes-vs-split;
`motion.y` under `abs()` or a flipped sign fails the up/down pair; activity
derived from mean magnitude fails the equal-amount fixture; a constant 0.5
centroid fails left-vs-right.

### Measurements on real material

Four generators, 20 samples each:

| source | luminance | contrast | edgeEnergy |
|---|---|---|---|
| noise (soft) | 0.566 | 0.263 | 0.050 |
| grid (graphic) | 0.457 | 0.490 | **0.161** |
| waves | 0.500 | 0.324 | 0.037 |
| chladni (hard edges) | 0.542 | **0.496** | 0.057 |

Grid and chladni have nearly the same contrast (0.490 vs 0.496) and edge
energies 2.8× apart — the separation the synthetic fixture predicts, on real
material. Luminance ordering is unrelated to both.

On a real video (146 MB export, 40 samples), pairwise correlation:

| pair | r |
|---|---|
| luminance ↔ contrast | 0.566 |
| contrast ↔ edgeEnergy | 0.701 |
| amount ↔ activity | 0.773 |
| motion.x ↔ centroidX | **0.122** |

Direction and position are effectively independent, which is the pair the
flagship workflow depends on. Contrast and edge correlate most, because a busy
frame tends to be both — kept apart on the strength of the fixture and of their
different dynamic ranges (amount spans 11× on this material where activity
spans 4×).

### Known debt

- `motion.direction` and `motion.spread` remain unbuilt; direction needs a
  mapping model that understands circular data.
- Contrast and edge energy are the weakest-separated retained pair on real
  video (r = 0.70). If phase E finds no Look distinguishes them, one should go.
- Centroid hold has no decay: it holds the last valid position indefinitely
  until the source changes. Playable, and honest because the scope reports
  HELD, but a slow return to centre may prove nicer in performance.

### Gate

Tests 1117 passing / 65 files · typecheck · lint · build · GPU goldens green ·
cost flat in signal count · image-only demand does not wake optical flow.

**Safe to proceed to C.**

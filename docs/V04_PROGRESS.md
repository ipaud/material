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

## C — mapping & performance UX

### Decisions

**Two modes, not five.** `add` (default, unchanged) and `replace`. Multiply was
spiked and dropped: nothing in the Look vocabulary needed it that a Set window
could not express, and every extra mode multiplies the composition rules.

**`mode`, `inMin`, `inMax` are OPTIONAL, not defaulted.** Absent and `'add'`
mean the same thing everywhere. Defaulting them would have rewritten every
stored project on first save to say something it already meant, and forced 52
construction sites to spell out three fields they do not care about. Schema
stays **v3**.

**At most one Set mapping per parameter.** Two mappings each claiming to *be*
the parameter have no meaningful sum, and picking by evaluation order would
make the result depend on row order. First enabled Set in document order wins;
the rest are inert and the UI marks them `INERT`.

**Positional signals default to Set at full weight.** A centroid added to
wherever a parameter happens to sit is not a position. `addMapping` reads the
signal's `domain` and picks the mode, so the default is right without the
performer knowing the rule exists.

**`amount` stays meaningful in both modes.** In Set it blends between the
parameter's current value and the mapped position, so the slider still reads as
"how much does this mapping matter".

**Invert stays `1 − v`.** For centred signals that IS the bipolar inversion,
because they publish `0.5 + 0.5·direction`. A separate bipolar path would have
broken the unipolar sources sharing the evaluator, to compute the same number.

**Calibration Lock / Reset added, runtime-only.** Lock freezes the envelopes;
RAW and CALIBRATED keep moving, the range stops adapting underneath a lit
scene. Reset forgets one pixel origin's ranges. Neither is persisted — storing
a moving statistic would make an export irreproducible from a fresh open.

**Rejected for now:** a dead zone for `motion.x/y` (the direction gate at the
signal layer already suppresses sub-noise-floor jitter — a second suppressor
would be duplicated noise policy); extra curves beyond the existing three; a
Bézier editor; Multiply.

### Measured gates

**Position — the flagship.** `motion.centroidX → Feedback Center X` in Set mode
with a 0.15–0.85 window, on a parameter whose range is −0.5..0.5:

| centroidX | 0.05 | 0.25 | 0.50 | 0.75 | 0.95 |
|---|---|---|---|---|---|
| resolved centerX | **−0.315** | −0.175 | **0.000** | +0.175 | **+0.315** |

Monotone, symmetric, and centred exactly when the motion is centred.

**Near-ceiling rescue.** Feedback persistence parked at 0.98, luminance driving
it from dark to bright:

| mode | dark | bright | travel |
|---|---|---|---|
| Add, amount 1 | 0.980 | 0.995 | **1.5%** |
| Set, window 0.50–0.99 | 0.748 | 0.990 | **24%** |

Sixteen times the travel from the same signal. This is the failure the mode
exists for, and it is not hypothetical — it is the feedback-persistence problem
observed since CE1B.

**Directional.** `motion.x → X Drift` in Add mode with a −1..1 window, on a
−3..3 parameter: left **−3**, still **0** exactly, right **+3**. A centred
signal at rest contributes nothing at all rather than a constant bias.

### Tests

23 new mapping goldens, every expectation a closed-form number: Add
compatibility, output window semantics, summation, absence-as-neutral, Set
positioning, Set travel windows, the ceiling rescue, amount-as-blend,
Set-then-Add ordering, conflict inertness, disabled Set not claiming a target,
input window renormalisation and clamping, identity default, degenerate window,
centred invert, and centred rest contributing zero.

Structural: the Output replica references no evaluator, no mapping mode, no
calibration and no reducer; the frame channel carries no signal or mapping
type; both apply paths go through one `composeTarget`.

Compatibility: a mapping serialised before v0.4C parses with the new fields
absent and evaluates bit-identically to an explicit `add`.

### Known debt

- The mapping row's live meter polls at 10 Hz while the section is open. It
  reads the evaluator's last resolved values, so it costs a lookup and no
  analysis, but it is a poll rather than a subscription.
- Set mode has no UI affordance for "which parameter does this own" beyond the
  `SET`/`INERT` badge.
- Calibration Lock is global rather than per signal. Per-signal lock would need
  a state model the performance UI cannot currently show compactly.

### Gate

Tests 1140 passing / 66 files · typecheck · lint · build · three product gates
measured · old projects bit-identical.

**Safe to proceed to D.**

## D — signal-driven presets / Looks

### Decisions

**No new content system.** A preset already carries a technique, its params, a
material and its modulations, so a signal-driven Look is an ordinary preset
whose modulations come from the picture instead of the music. They live in
`src/projects/signalPresets.ts` because curating them is a different job from
curating technique starting points, but they are the same type and use the same
apply path.

**A new category, `Reactive`.** Filing them under Motion would have hidden what
makes them different — Motion is about what the technique does, Reactive is
about where the control comes from.

**Sixteen Looks.** Every retained signal has at least one Look that shows what
it is for, and a test asserts that.

| Look | technique | driven by |
|---|---|---|
| **Body Follow** | feedback-zoom | centroidX/Y → centre, amount → zoom |
| Movement Memory | time-field | amount → depth |
| Directional Drag | feedback-drift | x → driftX, y → driftY |
| Structure React | mosaic | edgeEnergy → scale, spacing |
| Light Breath | feedback-zoom | luminance → zoom |
| Activity Mosh | motion-mosh | activity → injection, blockiness |
| Edge Memory | feedback-bloom | edgeEnergy → persistence |
| Motion Zoom | feedback-zoom | amount → zoom |
| Luma Pulse | mosaic | luminance → scale |
| Vector Drift | feedback-drift | activity → persistence, x → driftX |
| Contrast Bloom | feedback-bloom | contrast → gain, threshold (inverted) |
| Follow Kaleido | feedback-kaleido | centroidX → rotation, activity → segments |
| Slit Follow | slit-scan | centroidX → offsetSec, amount → spanSec |
| Chroma Motion | feedback-rgb | x → redShift, y → blueShift |
| Edge Grid | mosaic | edgeEnergy → spacing, luminance → opacity |
| Still Life | time-field | activity **inverted** → depth |

Still Life is Movement Memory backwards on purpose: having both proves the
vocabulary reads in either direction rather than only flattering one.

### Two defects found by building the content

**A single NaN `dt` permanently poisoned a mapping's smoothing state.** The EMA
stored the NaN and every later step read it back as `prev`, so the parameter sat
at NaN for the rest of the session while the mapping still looked enabled — a
silent, unrecoverable failure. `SmoothingState.step` now treats an unusable dt
as no time passing and refuses to store a non-finite value. Found because a
probe passed a technique id where the evaluator takes a time; the same could
reach production from any NaN in the transport clock.

**The first optical-flow solve after a discontinuity was seeding the motion
calibrator.** Measured on a generator source switch: the first solve read
**9.435** analysis texels/frame against a steady-state median of **0.363**,
because it compares the two frames that straddle the switch. As the calibrator's
seed it set the entire envelope, and `motion.amount` published **0** for several
seconds afterwards — every motion-driven Look pinned at one end of its window.

v0.4A had already established that the *priming* update is not a measurement;
this is the frame after it. `OpticalFlowField.ready` now requires **two** solves.
After the fix the same switch reads a maximum of 1.852 and the knob publishes
0.766 within six seconds.

### Measured gates

**Anti-dead, all 16 Looks on a moving generator** — every Look's targets move:

| Look | measured travel |
|---|---|
| Luma Pulse | scale 1.178 → 1.853 |
| Contrast Bloom | gain 1.074 → 1.364 |
| Chroma Motion | redShift 1.495 → 1.876, blueShift 2.382 → 2.854 |
| Directional Drag | driftX −0.457 → −0.108, driftY −0.229 → 0.194 |
| Edge Grid | spacing 0.178 → 0.196, opacity 0.806 → 0.919 |
| (all others) | non-zero travel on every mapped target |

**Body Follow on real video** — centroid spans 0.418–0.667 horizontally and the
feedback centre follows at **r = 0.81** (the shortfall is the 0.25 smoothing,
which is the point of it).

**Static source** — centroid correctly reports INVALID (0/20 valid), holds 0.5,
and the resolved centre sits at exactly 0. A motion Look on a still image
settles rather than shimmering.

**Source switch, one Look unchanged** (`Movement Memory`, depth in seconds):

| source | travel |
|---|---|
| generator | 1.449 → 1.776 |
| video | 0.758 → 1.206 |
| camera | 0.847 → 1.170 |
| generator again | 1.300 → 1.487 |

The same Look is playable on all four, and the range recovers after coming back.

### Curation

Two Looks were tuned rather than shipped as first written:

- **Edge Grid** drove `spacing` NEGATIVE at high edge energy (measured −0.051 to
  −0.020), which overlaps tiles instead of tightening them. Window retuned to
  keep the whole travel positive.
- **Edge Grid**'s opacity mapping sat clamped at the ceiling for every sample,
  because the base value was already 1. A resting point has to leave room for
  the modulation it is paired with.

One convention bug fixed: **Directional Drag** inverted `motion.y`, so upward
movement smeared downward. `motion.y` keeps render orientation (1 = up) and the
feedback shader samples the past at `uv − drift`, so +driftY drags upward too.
Body Follow's `centroidY` inversion is the opposite case and IS correct:
`centroidY` reads 0 at the top of the image, deliberately, because that is how
a person describes a position.

Nothing was dropped.

### Known debt

- Body Follow cannot be validated on a uniform-motion generator: uniform motion
  has no centre, so the centroid correctly sits at 0.5 and the Look barely
  moves. Real content or a camera is required, which is a fixture limitation
  rather than a defect.
- Live camera QA with a person moving is a human test; §84 is satisfied by
  camera measurements, not by a person on video.

### Gate

Tests 1155 passing / 67 files · typecheck · lint · build · anti-dead on 16/16 ·
export anti-noop and determinism re-verified after the flow change.

**Safe to proceed to E.**

## E — curation, QA, release

### Final public signal inventory

Nine. Nothing was dropped in curation, because the duplication review found a
discriminating fixture for every pair that could have been redundant.

| pair reviewed | verdict | evidence |
|---|---|---|
| luminance vs contrast | both keep | contrast is 0 on a flat frame at ANY brightness; r = 0.57 on video |
| contrast vs edgeEnergy | both keep | 16 stripes and one split have identical contrast and edge **31×** apart; r = 0.70 |
| amount vs activity | both keep | 1/16 of the frame at 16× speed has identical amount, activity **16×** apart; r = 0.77 |
| x/y vs centroidX/Y | both keep | direction and location are near-independent on real video: **r = 0.12** |

Contrast and edge correlate most on real material, because a busy frame tends
to be both. They are kept apart on the strength of the fixture and of their
different dynamic ranges; if a future release finds no Look distinguishes them,
that is the one to revisit.

### Look portability, with clamp metrics

Five Looks × three sources, 30 samples each, measured against each parameter's
own bounds:

| metric | result |
|---|---|
| samples at a clamp rail | **0.0%** — every row, every source |
| range utilisation, video | 3.6% – 32.2% |
| range utilisation, camera | 0.6% – 29.0% |
| range utilisation, generator | 1.5% – 13.3% |

Nothing saturates. Low utilisation appears exactly where the source has nothing
to say about that quantity — Body Follow on a uniform-motion generator (uniform
motion has no centre) and Structure React on a static camera view (constant
edge energy). Those are honest readings, not dead knobs.

### Coexistence and cost

| configuration | fps | analysis | draws | readbacks | bytes | ladder | flow |
|---|---|---|---|---|---|---|---|
| nothing mapped | 120.0 | — | 0 | 0 | 0 | 0 | 0 |
| 1 image signal | 120.0 | 26 Hz | 4 | **1** | 192 | 0.60 MB | **asleep** |
| all 3 image signals | 119.7 | 25.7 Hz | 4 | **1** | 192 | 0.60 MB | **asleep** |
| 3 motion signals | 119.0 | 26.2 Hz | 5 | **1** | 720 | 2.81 MB | 2.20 MB |
| all 6 motion signals | 120.0 | 25.7 Hz | 5 | **1** | 720 | 2.81 MB | 2.20 MB |
| **all nine** | **120.0** | 26.2 Hz | 5 | **1** | 720 | 2.81 MB | 2.20 MB |

Analysis demand: nothing mapped and scope closed → no targets, no flow. Scope
alone → analysis wakes. Scope closed → released again. Image-only demand never
wakes optical flow.

### Determinism

| subject | repeat | full vs subrange | anti-noop |
|---|---|---|---|
| `image.luminance` | 12/12 | 12/12 | **12/12** |
| `motion.amount` | 12/12 | 12/12 | **12/12** |
| `motion.x` | 12/12 | 12/12 | **12/12** |
| Body Follow | 12/12 | 12/12 | 24/24 distinct |
| Movement Memory | 12/12 | 12/12 | 24/24 distinct |
| Structure React | 12/12 | 12/12 | 24/24 distinct |
| Activity Mosh | 12/12 | 12/12 | 24/24 distinct |
| Luma Pulse | 12/12 | 12/12 | 24/24 distinct |

### Runtime matrix

| surface | result |
|---|---|
| Camera | live, 9/9 signals, calibration settles in a still room |
| Screen | live, 9/9 signals (luminance 0.057–0.063, motion 0.000–0.208) |
| Window | live, 9/9 signals, chosen by ephemeral id |
| Video: play / pause | 9/9 published; paused holds the last analysis |
| Video: seek in range | motion recovers immediately and stays live |
| Video: seek past duration | clamps to 0 and stops — existing transport behaviour |
| Generator, no imports | 9/9 published; the whole instrument works with nothing loaded |
| Static source | centroid INVALID 0/20, held at 0.5, resolved centre exactly 0 |
| Freeze | params hold to 1e-9 while signals keep publishing underneath |
| Morph between signal Looks | overlay carries both Looks' signals; **2** published mid-morph |
| Looks save/reload | signal ids, modes and windows persist; no calibration serialised |
| Audio + visual, one target | sums, finite, no interference |
| Pattern + visual | independent, finite |
| Output | no evaluator, no calibration, no reducer, no mode strings |
| Context loss + restore | reductions resume (61 → 83), targets re-allocated, 0 GL errors |

### Soaks

Both 10 minutes, cycling sources, demand and morphs every 800 ms:

| metric | camera soak | generator soak |
|---|---|---|
| iterations | 744 | 745 |
| textures, 1st vs 2nd half mean | 19.52 / **19.52** | 19.04 / **19.00** |
| geometries | 10.28 / **10.28** | 11.00 / **11.00** |
| programs | 11.24 / 11.28 | 11.96 / 12.00 |
| ladder VRAM | 2.81 MB constant | 2.81 MB constant |
| flow VRAM | 2.20 MB constant | 2.20 MB constant |
| calibration entries | ≤ 23 | 23 constant |
| GL errors | **0** | **0** |
| fps | 111–122 | 101–115 |

Half-vs-half means are the assertion: a leak shows as a rising floor. JS heap
oscillates 23–53 MB with GC and its mean rose 13% over the camera run, which is
noise against flat GPU counters, recorded rather than explained away.

### Packaged

`release/mac-arm64/MATERIAL.app`, **0.4.0**, ad-hoc signed, not notarised.

- the shipping asar contains every v0.4 signal id, the Reactive Looks and the
  Set mapping mode;
- launches, stays alive past 27 s, quits cleanly, stderr empty;
- **zero** listening sockets owned by the process; no CDP endpoint on 9222 or
  9223.

Per CE1H §66, that also means CDP-driven QA cannot run against the shipping
artifact, so packaged verification of camera / screen / window remains limited
by TCC identity for an ad-hoc signed build. Dev-build verification of all three
is recorded above. Not faked, not claimed.

### Compatibility and security

Every committed project fixture opens as v3. A mapping serialised before v0.4C
parses with the new fields absent and resolves to the same number as an
explicit `add`. A source id from a future version degrades to neutral instead of
throwing. No preload API was added, no frame data crosses IPC, and the analysis
code loads nothing from disk or network.

### Defects fixed in E

- **Demand ignored morph overlays**, so a Look being morphed TO had its signals
  dark for the whole transition and snapped into life at commit. The runtime
  resolves the overlay, so it now owns effective demand; export unions every
  Look its morph events can reach. Measured: 1 → **2** signals published
  mid-morph, and a visibly wider interpolation.
- **Requiring two flow solves would have deleted motion from the first frame of
  every export.** Export constructs its pair deliberately with a two-tap prime,
  so it now says so and keeps frame one.

### Gate

Tests **1166** passing / 69 files · typecheck · lint · build · package.

**v0.4 COMPLETE.**

# Morph Transitions (CE1G)

Morph interpolates **creative state**. A transition composites **pixels**.
CE1G adds the second without disturbing the first: `smooth` reproduces v0.3
behaviour exactly, and every project written before CE1G replays unchanged.

## The problem CE1G actually solves

A morph between two looks of the *same* technique interpolates smoothly.
A morph across *different* techniques cannot: their parameters have no
common meaning, so identity **snaps** — a hard cut in the middle of an
otherwise smooth gesture. That cut is the only place a pixel transition
belongs, and using it there is what avoids the "double morph" trap: the two
images being blended are the pre-switch and post-switch renders, which state
interpolation does not bridge. Nothing is faded twice.

## The model: snapshot A + live B

```
        capture A ─┐                       ┌─ release
                   ▼                       ▼
  ├──── A ────┤────────  reveal  ─────────┤──── B ────┤
  0         0.25          0.5           0.75          1     (eased progress)
             ▲
             └─ identity switches HERE, not at 0.5
```

- **A** is a snapshot: one RGBA8 target, allocated when the reveal arms and
  disposed when it closes.
- **B** is the live, still-evolving render — feedback keeps feeding back,
  simulations keep stepping, live sources keep arriving.

A parallel *A universe* was rejected: it would need a second feedback
surface, a second simulation and a second flow field, all running a state
the user has already left. A snapshot costs one target and freezes A at
exactly the frame the user was looking at, which is what a transition means.

### Why the switch moved to 0.25

This is the load-bearing detail. Leaving the identity switch at 0.5 with a
reveal centred on 0.5 is *worse than no transition*: at the switch instant
the mask is already half open, so half the frame pops from A to B anyway.
Moving the switch to the reveal's opening puts the snapshot in front of it —
the frame that would have popped is the frame being held under the mask.

`switchPoint()` and `revealProgress()` live in
[`src/performance/transitionWindow.ts`](../src/performance/transitionWindow.ts)
and are imported by **both** the preview runtime and the export replay, so
an exported morph cannot reveal differently from the performed one. Mutating
that module breaks tests on both sides.

Same-technique morphs have no switch to cover, so a non-smooth style owns
the whole morph.

## The styles

| Style | Reveal | Notes |
|---|---|---|
| `smooth` | uniform crossfade | the v0.3 default; no snapshot is taken at all |
| `cut` | hard switch at 0.5 | honest hard cut, quantized to the morph |
| `directional` | linear sweep along `angle` | softness widens the band |
| `noise` | value-noise threshold | organic dissolve; `scale` sets the grain |
| `pixel` | per-cell hash | blocky; `scale` maps 80→6 cells across the frame |
| `radial` | iris from `center` | softness feathers the ring |
| `zoom` | crossfade + opposed push | A pushes out, B arrives; `amount` scales |
| `displace` | crossfade + noise warp | warp peaks mid-transition, zero at both ends |
| `glitch` | row shifts, hard reveal | `scale` sets block height |
| `luma` | bright regions of B first | luma is gamma-lifted (see below) |

**Endpoint law.** Progress ≤ 0 returns A pixel-identical, ≥ 1 returns B
pixel-identical, enforced by early return *before* any style math runs, so
no style can leave residue at the ends. Measured for all ten.

**Luma is gamma-lifted** (`pow(luma, 0.45)`). Raw luma on a dark scene
bunches near 0, which would push the entire reveal into the last ~10% of the
transition and degenerate the style into a late hard cut.

**Zoom's push is 0.6, not 0.35.** Zoom and Smooth share a mask by
construction, so their numeric goldens are identical — only the eye
separates them, and below roughly half a frame the push is invisible.

## Export

Preview uses snapshot A because it must run in real time. Export instead
**re-renders** the A side from the recorded look core each frame, because
export must be order-independent: a subrange starting mid-reveal has no
earlier frame to snapshot, and reconstructing one would make output depend
on where the export began.

To keep that reproducible, the exported A side is a pure function of the
recorded look:

- A's params get **macros only** — no modulation. Modulation carries
  per-frame smoothing state, so a subrange would enter the reveal with less
  history than a full export and produce a different A.
- Both sides composite through the **same GLSL** as the preview. The mask
  math is never reimplemented in TypeScript, where it could drift.

The transition is recorded on the **morph event** (`morphEvent.transition`),
not held as runtime state — export replays events, so an unrecorded style
would silently export as a hard switch. The field is fully defaulted:
pre-CE1G projects parse and replay as `smooth`.

Accepted divergence: during a reveal the outgoing image is *frozen* in
preview and *re-rendered* in export. A morph launched by a trigger during
export replay has no recorded style and replays as `smooth`.

Known debt: when either side of a cross-technique reveal is a **temporal**
technique, the extra renderer swap re-primes the atlas, so the reveal
inherits the CE1C `primeExact`-vs-`advanceExact` asymmetry already scheduled
for CE1H triage. The measured export gates below use generator sources,
which are decoder-free and non-temporal.

## Measured

GPU goldens (`window.__dev.transitionGoldens()`, clean process, A=red,
B=blue, 64×64 RGBA8). Mean blue at eased 0.25 / 0.5 / 0.75:

| Style | p=0 | p=1 | blue ramp | monotone | deterministic |
|---|---|---|---|---|---|
| smooth | `255,0,0` | `0,0,255` | 64.0 128.0 191.0 | ✓ | ✓ |
| cut | `255,0,0` | `0,0,255` | 0.0 255.0 255.0 | ✓ | ✓ |
| directional | `255,0,0` | `0,0,255` | 44.6 127.5 210.4 | ✓ | ✓ |
| noise | `255,0,0` | `0,0,255` | 56.1 177.6 246.5 | ✓ | ✓ |
| pixel | `255,0,0` | `0,0,255` | 61.9 123.7 188.8 | ✓ | ✓ |
| radial | `255,0,0` | `0,0,255` | 14.1 101.9 234.6 | ✓ | ✓ |
| zoom | `255,0,0` | `0,0,255` | 64.0 128.0 191.0 | ✓ | ✓ |
| displace | `255,0,0` | `0,0,255` | 64.0 128.0 191.0 | ✓ | ✓ |
| glitch | `255,0,0` | `0,0,255` | 0.0 128.0 255.0 | ✓ | ✓ |
| luma | `255,0,0` | `0,0,255` | 0.0 0.0 252.0 | ✓ | ✓ |

- **Smooth midpoint `[128,0,128]`** — an even blend, so the snapshot adds no
  colour-space shift (it is captured in the pipeline's own RGBA8 sRGB).
- **Luma order** with B's right half bright: reveal 1.0 on the bright half
  vs 0.0 on the dark half at p=0.4 — bright genuinely arrives first.
- **Resources** (live morph, radial, 4s): allocations 1, disposals 1,
  snapshot 12.8 MB at retina canvas size, returning to `{snapshots: 0,
  bytes: 0}` on completion *and* on cancel.

`window.__dev.transitionSheet()` renders a 10×3 contact sheet for curation
by eye. It assembles the grid in JS from per-cell readbacks on purpose:
tiling on the GPU would need `setViewport` after `setRenderTarget`, the
CE1D-2 trap that multiplies by pixelRatio.

## Rules this phase keeps

- Editor is the sole authority. `FrameState.transition` carries resolved
  values only (`generation`, `progress`, `style`, params); the Output
  composites locally and never evaluates a morph. No pixel transport.
- No `setViewport` after `setRenderTarget` in any transition pass.
- The snapshot is taken when the reveal **arms**, never when a morph is
  merely scheduled — a future morph must not resurrect the P9 zombie.

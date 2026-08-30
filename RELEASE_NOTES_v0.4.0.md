# MATERIAL v0.4.0 — Image / Motion Signals

**Internal release.** Ad-hoc signed, not notarised.

MATERIAL could already listen to music, to the clock and to a beat grid. It
could not listen to the picture it was making. Now it can.

## The image is a control source

Nine new signals join the same modulation vocabulary as audio and beat, so
everything you already know about mapping still applies.

**Image**

- **Luminance** — how bright the frame is
- **Contrast** — how far the tones spread. A flat frame reads zero at any
  brightness
- **Edge Energy** — how much structure there is. Graphic material reads high,
  soft material reads low, at the same contrast

**Motion**

- **Amount** — how fast things are moving
- **Activity** — how much of the frame is moving. A hand and a whole body are
  different things, and this is the signal that knows it
- **X / Y** — which way. Still is exactly neutral, so a mapping contributes
  nothing until something moves
- **Centre X / Y** — *where* the movement is

Motion Centre is the one that changes what MATERIAL can do. Point a camera at
yourself, map Centre to a feedback centre, and the effect follows you around
the frame. No tracking model, no machine learning — just where the movement is.

## Signals that stay playable when the material changes

A signal can be numerically correct and useless: a dark clip's luminance lives
in a narrow band, and a mapping straight through it barely moves.

Every range-based signal is calibrated **per source**, automatically. Measured
with one unchanged Look:

| source | raw luminance span | usable travel |
|---|---|---|
| bright generator | 0.045 | 0.54 |
| video file | 0.234 | 1.00 |
| camera, still room | **0.001** | **0.27** |

The camera row is the point: a source doing almost nothing still gives you a
quarter of the range, without amplifying noise to full scale.

Signals that already mean something — direction, the fraction of the frame
moving, and position — are **not** calibrated, because rescaling them would
throw away what they mean.

New **Lock** and **Reset** controls in the Signal Scope freeze the learned
ranges once a scene is lit, or forget them and start again.

## Mapping that can actually reach the parameter

Mappings have always nudged a parameter from wherever its slider sat. That
breaks in two places: a position is not a nudge, and a parameter parked near
its limit has nowhere left to go.

**Set** mode positions a parameter inside its own range instead. Measured on
feedback persistence resting at 0.98: the old behaviour moves it across 1.5% of
its range, Set across 24%.

Also new per mapping: an **input window** (react only to the part of the signal
you care about) and a live meter on every row, so you can see whether a signal
is moving before deciding the mapping is wrong.

Existing projects are untouched. Every mapping written before this release
behaves exactly as it did.

## Sixteen Looks that show what it is for

A new **Reactive** category in the preset library:

**Body Follow** · Movement Memory · Directional Drag · Structure React ·
Light Breath · Activity Mosh · Edge Memory · Motion Zoom · Luma Pulse ·
Vector Drift · Contrast Bloom · Follow Kaleido · Slit Follow · Chroma Motion ·
Edge Grid · Still Life

Each one is tuned by hand against real material, works on a generator, a video
file and a camera, and settles safely on a still image.

## Renders match what you see

Signal-driven work exports deterministically. The same range rendered twice is
byte-identical, and a section rendered on its own matches the same frames of a
full render. Verified for every signal and for five signal-driven Looks.

## Under the hood

The whole frame never leaves the GPU. Nine statistics are reduced on the GPU
down to a 720-byte read — the same cost whether you use one signal or all nine.
Preview holds 120 fps, and analysis sleeps entirely when nothing needs it.

## Known limitations

- Screen and window capture are verified in development; packaged verification
  of camera, screen and window remains limited by macOS permission identity for
  an ad-hoc signed build.
- Motion direction, motion spread and per-channel colour signals are not built.

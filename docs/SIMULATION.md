# Simulation (CE1E)

Persistent GPU state evolving by an explicit rule. Distinct from Feedback
(which reprocesses prior imagery) and from History (source frames).

## Systems

| System | State | Format | Filter | Grid | VRAM |
|---|---|---|---|---|---|
| Reaction Diffusion | R = chemical A, G = chemical B | RG half-float | Linear | 320×180 default (128–512) | ~0.9 MB |
| Cellular | R = cell 0/1 | RGBA8 | **Nearest** | 256×144 default (64–512) | ~0.3 MB |

Grids are aspect-corrected so cells stay square after the state is
stretched across the composition.

## The clock

One fixed rate, `SIM_STEP_RATE = 60 Hz`, two drivers:

- **PREVIEW** — wall-clock accumulator. A 120 Hz editor and a 60 Hz Output
  evolve at the same real rate; catch-up is capped at 8 steps so a stall
  cannot produce a burst. Simulation keeps evolving with the transport
  paused, on seek, across loops and with no source at all: it is a living
  process, not a playback artefact.
- **EXPORT** — canonical integer step index, `floor(t · 60)`. Frame 0 seeds
  and prerolls from the timeline origin; later frames advance the exact
  missing steps. Integer derivation keeps a 10-minute export drift-free.

Preview state and export state legitimately differ (preview is wall-clock,
export is canonical). Export is the deterministic truth.

## Determinism

Initial state is GPU-derived from the project seed (`deriveSeed`), never
`Math.random`. Same seed + params + step count ⇒ identical state
(measured); different seed ⇒ different state (measured). Runtime state is
never serialized: a project stores technique, params and seed, and reloads
into the canonical initial state.

## Reset matrix

Resets: technique activation, seed/grid/density/rule change (marked
non-modulatable so modulation can never restart the world every frame),
context restore, export begin, resolution change.
Does not reset: feed/kill/speed/contrast modulation, transport pause,
seek, loop, Pattern/audio/MIDI.

## Curated ranges

Gray-Scott is only interesting in a small window: MATERIAL exposes
feed 0.01–0.09 and kill 0.045–0.07, not the mathematical space. `Speed` is
an ITERATION COUNT (1–8), never a `dt` multiplier — the solver runs
dA=0.2, dB=0.1, dt=1, inside the explicit-scheme stability limit. State is
clamped to 0..1 every iteration, so divergence cannot produce NaN/Inf.

## Verification (see GPU_TESTING.md)

The cellular automaton is the truth machine — measured on a clean process,
16×16 wrapped Life grid, driven through the EXPORT step path:

```
block   gen0 [[4,4],[5,4],[4,5],[5,5]]  gen4 identical          → still life
blinker gen0 [[6,8],[7,8],[8,8]]        gen1 [[7,7],[7,8],[7,9]] → period 2
        gen2 back to gen0
glider  gen0 [[0,1],[1,1],[2,1],[2,2],[1,3]]
        gen4 = gen0 shifted exactly (+1,−1)                      → travels
        gen8 wraps through the boundary                          → wrap OK
```

Reaction Diffusion stability (128², seed 1, feed .055 / kill .062):

| steps | A range | mean A | B range | mean B | var B | NaN |
|---|---|---|---|---|---|---|
| 0 | 1.00–1.00 | 1.000 | 0.00–1.00 | 0.043 | .041 | 0 |
| 10 | 0.29–1.00 | 0.953 | 0.00–0.45 | 0.022 | .006 | 0 |
| 100 | 0.31–1.00 | 0.934 | 0.00–0.45 | 0.031 | .008 | 0 |
| 500 | 0.30–1.00 | 0.827 | 0.00–0.46 | 0.081 | .017 | 0 |

Bounded, growing, zero invalid pixels. The diagnostic encoder paints
NaN/Inf magenta, so an explosion cannot pass silently.

## Performance

All five reference presets: 120 fps editor @1080p, ~60 sim steps/s (RD at
4 iterations/step = 240 solver iterations/s). RD ~0.9 MB + CA ~0.3 MB per
renderer; the Output keeps its own local state (no simulation IPC), so a
worst case is roughly double.

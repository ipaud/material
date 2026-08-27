# Export Pipeline

## Principle

Export never screen-records the viewport. Every frame is rendered offscreen at
full project resolution from an exact composition time.

```
for frameIndex in 0..N:
    t      = startSec + frameIndex / fps      # exact, no accumulation
    params = evaluateModulation(t, dt = 1/fps) # fresh smoothing state
    seek video to exactly t                    # awaits 'seeked'
    rgba   = engine.renderStill(w, h, params)  # offscreen render target
    send rgba -> main -> ffmpeg stdin (rawvideo)
```

## Determinism guarantees

| Property | Guarantee |
|---|---|
| Frame time | `startSec + i/fps` — computed, never accumulated |
| Audio features | Precomputed analysis arrays, linearly interpolated at `t` |
| Beat sources | Pure function of `(t, bpm, beatOffset)` |
| Randomness | Seeded (mulberry32); the GPU hash is a pure function of instance id + seed |
| Smoothing | EMA stepped with fixed `dt = 1/fps`, from a **fresh** state per export |
| Re-runs | Same project + same range + same fps → identical parameter sequence |

Verified in `tests/export-determinism.test.ts` and live against
`SHAZUNO-material.mp3`: two export runs produced identical sequences, and the
export evaluator matched the live preview evaluator to **4.2e-13** (float noise).

### Why smoothing is history-dependent (and why that's still deterministic)

An EMA-smoothed mapping depends on the frames before it. Two exports starting
at *different* times therefore differ slightly during the settling window
(~1 time constant). This is intended: within a single export the state is
always initialized at the start frame and advanced by a fixed `dt`, so any
given export is exactly reproducible. Mappings with `smoothing = 0` are
purely time-addressable.

## Process architecture

- **Renderer** owns the frame loop, GL readback, and progress state.
- **Main** owns the FFmpeg child process; frames arrive over validated IPC
  (`export:frame`), and payload size is checked against `width*height*4` before
  a single byte is written to stdin.
- Cancel kills the child and removes partial H.264 output.

## Formats

| Format | Encoder | Notes |
|---|---|---|
| PNG still | Canvas encode in renderer → validated PNG write in main | Signature-checked before write |
| PNG sequence | `-c:v png` → `frame_%05d.png` | Directory chosen by the user |
| H.264 MP4 | `libx264 -crf 18 -preset medium -pix_fmt yuv420p +faststart` | Optional AAC audio muxed from the project's audio source, trimmed to the export range |

Encoders are detected at startup (`ffmpeg -encoders`). ProRes 422/4444 and
alpha/EXR are **not** exposed yet — the architecture supports them, but nothing
is offered that the machine cannot actually produce.

## Known limitation — temporal techniques (fixed in Phase 8)

The Phase 3.5 frame ring buffer captures on the **on-canvas** render path with
wall-clock throttling. Offscreen export renders do not feed it, so an export of
Video Tile + time offset uses whatever the ring held when playback stopped:
the spatial time-offset pattern is present, but the past frames do not advance
with export time.

Phase 8 re-times capture to composition time (`RingBufferMode: 'timeline'`,
already reserved in the API), which makes temporal techniques export-exact.
Until then, temporal exports are flagged as preview-fidelity, not final.

## Color

sRGB throughout: source textures are decoded as sRGB, the render target is
sRGB, readback bytes go straight to the encoder. No Rec.709/linear/HDR
handling yet — see `docs/DECISIONS.md`.

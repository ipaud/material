# Export Pipeline

## Principle

Export never screen-records the viewport. Every frame is rendered offscreen at
full project resolution from an exact composition time.

```
# the evaluator replays from the ORIGIN; only [startFrame, startFrame+N) is written
for globalFrame in startFrame..startFrame+N:
    t      = (round(startSec*fps) + i) / fps   # addressed by GLOBAL FRAME INDEX
    params = evaluateModulation(t, dt = 1/fps) # history replayed from frame 0
    seek video to exactly t                    # awaits 'seeked'
    rgba   = engine.renderStill(w, h, params)  # offscreen render target
    send rgba -> main -> ffmpeg stdin (rawvideo)
```

## Determinism guarantees

| Property | Guarantee |
|---|---|
| Frame time | `(round(startSec*fps) + i)/fps` — addressed by global frame index, so the same frame is the same float in every export containing it |
| Audio features | Precomputed analysis arrays, linearly interpolated at `t` |
| Beat sources | Pure function of `(t, bpm, beatOffset)` |
| Randomness | Seeded (mulberry32); the GPU hash is a pure function of instance id + seed |
| Smoothing | EMA stepped with fixed `dt = 1/fps`, replayed from the timeline **origin** |
| Re-runs | Same project + same range + same fps → identical parameter sequence |

Verified in `tests/export-determinism.test.ts` and live against
`SHAZUNO-material.mp3`: two export runs produced identical sequences, and the
export evaluator matched the live preview evaluator to **4.2e-13** (float noise).

### Why smoothing is history-dependent (and why that's still deterministic)

An EMA-smoothed mapping depends on the frames before it. Until CE1H each export
initialised that state at its own start frame, so a subrange and a full export
disagreed during the settling window — measured at **0/12** matching frames with
the reference track driving Motion Mosh at smoothing 0.2, and 12/12 with
smoothing 0, which is what isolated it.

The evaluator now replays from the timeline origin: skipped frames are walked
(one cheap CPU evaluation each, nothing rendered) so a subrange reaches its
first written frame carrying the history a full export has. Both are exactly
reproducible **and** they agree with each other. Mappings with `smoothing = 0`
remain purely time-addressable.

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

## Frame-accurate video sampling (v0.2)

Each exported frame waits for **two** signals before it is rendered:

1. `seeked` — the element reached the requested time.
2. `requestVideoFrameCallback` — a decoded frame has actually been presented.

Waiting only for `seeked` was silently wrong: it reports that the seek
finished, not that a new frame is available to the texture. Rendering there
uploaded whichever frame the texture still held, and roughly a fifth of the
frames in a non-temporal export differed between two runs of the same project
(measured 11–16 dB PSNR — a different image, not codec noise). The temporal
path was unaffected because it primes from exact timestamps rather than the
element's current frame.

The first frame of an export also forces a real seek, because a freshly
opened project has no decoded data at all.

## Isolation while exporting (v0.2)

Parameters are already snapshot-isolated: `createFrameEvaluator` captures the
project once, and trigger actions mutate a working copy. Two things cannot be
snapshotted, because they are shared hardware state that the store bridge
drives live:

- the `<video>` element's position, and
- the technique / material renderers.

So for the duration of an export MATERIAL blocks the handful of actions that
move them — applying a Look, starting a Morph, applying a Candidate, and
seeking — each with a toast explaining why. Preview rendering pauses, and all
incoming MIDI is dropped at the engine entrance.

Verified: an export run while macros were swept, Looks were clicked, seeks
were requested and candidates were generated throughout produced a
**byte-identical** file to the same export run in silence.

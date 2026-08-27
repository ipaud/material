# Temporal Engine

How MATERIAL addresses the past.

## The model: a time grid, not a capture log

The frame history is a **grid indexed by composition time**. Logical slot `k`
always holds the frame at

```
time(k) = anchorTime − k · spacingSec
```

Defaults: 56 slots at 1/24 s → **2.29 s of reachable history, 7.9 MB**.

Two consequences make everything else fall out:

1. **GPU lookup is arithmetic, not search.** A shader that wants the frame
   `offsetSeconds` ago computes `k = round(offsetSeconds / spacing)` and reads
   physical slot `(head − k + count) mod count`. No per-slot time table.
2. **Export can reconstruct the exact same addresses** without ever having
   played the timeline, because the schedule is a pure function of
   `(anchorTime, spacing, slotCount, sourceBounds)`.

`temporalSchedule()` is that pure function, and the determinism tests assert on
it directly — no rendering involved.

## Preview vs export

| | Preview | Export |
|---|---|---|
| Fill strategy | `advancePreview` — grid advances with playback, newest frame written to newly exposed slots | `primeExact` on frame 0, then `advanceExact` |
| Frame source | live `VideoTexture` | exact `seek → 'seeked' → upload` per slot |
| Cost | ~0 (one blit per grid step) | 56 seeks to prime, then ~1 per output frame |
| Authority | none | **source of truth** |

`exportMode` disables preview capture entirely while an export runs, and
`endExportMode()` discards the export-primed history afterwards. Preview
contents can therefore never reach a rendered frame — verified by exporting the
same range twice, once cold and once after heavy playback and scrubbing, and
comparing the MP4s byte-for-byte (identical MD5).

## Preview honesty

`advancePreview` refuses to fabricate history:

- **Grid unchanged** → cache hit, nothing written.
- **Advanced within one buffer span** → the skipped slots get the newest frame.
  A bounded, interactive-only approximation.
- **Backward seek, or a jump larger than the whole buffer** → the buffer is
  *invalidated and rebuilt*. Frames from before a seek are not history for what
  comes after it, and are never shown as if they were.

Playback seeks call `engine.resetTemporal()` for the same reason. Verified:
backward seek, large forward seek, and loop restart each drop `filled` to 1 and
re-anchor, then rebuild forward.

## Distributions (§5)

Per-cell weight in 0..1, shaped by `falloff` (`pow(w, falloff)`) and optionally
inverted by `direction`, then scaled by `maxOffsetSec`:

`uniform · radial · linearX · linearY · distanceCenter · random (seeded) ·
luminance · noise field (seeded)`

Random and noise derive from the project seed and the instance id, so they are
reproducible across runs and identical in preview and export.

## Techniques on the engine

Techniques never decode. They receive `ctx.temporal` (a `TemporalUniforms`
handle) and ask for a time offset:

- **Mosaic / Video Tile** — per-cell offset from any distribution.
  *Echo Chamber* = radial, outward, centre = now.
- **Echo** — copy `n` samples `n · delay` seconds back; linear/radial/random
  spread, decay, per-copy scale/rotation, normal/add/screen blend.
- **Step Print** — quantized (held) time: accumulate / replace / ping-pong /
  random.
- **Slit Scan** — image position maps to a moment in time; horizontal or
  vertical, strip count, span, direction, smooth/stepped.

## Memory

`cacheBytes = cols · slotWidth · rows · slotHeight · 4`, reported live in the
debug overlay (`⌘D`) alongside filled slots, span, anchor time, hit/miss and
seek counts. The default preview budget is 7.9 MB and is bounded by
construction: history length is a slot count, never "however much video fits".
4K history is impossible by design — slots are proxy-resolution (256×144);
final render decodes the source at full resolution per frame.

## Boundaries (§14)

`resolveBoundary` clamps to the first/last frame by default. `wrap` and
`mirror` are implemented and tested; `transparent` is reserved for the shader
side. A schedule near `t = 0` collapses deep history onto frame 0 rather than
requesting negative time.

## Known limitations

- **Seek-based decoding.** Priming costs 56 seeks (~1–2 s) at export start.
  Fine at current scale; if it becomes a bottleneck the replacement is
  WebCodecs `VideoDecoder` with a demuxed GOP feed, which would also remove the
  `seeked`-event round trip. Not needed yet — a 7 s, 175-frame 720p Echo
  Chamber export took **6.8 s wall clock**, roughly realtime.
- **Preview interpolation.** Slots skipped during fast playback hold the newest
  frame rather than a true decode. Export never does this.
- **Video shorter than audio.** Once composition time passes the video's end,
  the source clamps to the last frame and history becomes uniform. Intended.

# MATERIAL

A desktop instrument for experimental moving-image design.

MATERIAL is not a filter gallery. You build a **visual system** — a source, a
technique, a repeated material, and signals that drive them — and then play
with the rules until the image becomes something you would not have drawn by
hand.

```
SOURCE → TECHNIQUE → MATERIAL → MODULATION → OUTPUT
```

Everything runs locally. No accounts, no cloud, no telemetry, no media upload.

## Requirements

- macOS on Apple Silicon (built and tested on M-series)
- Node 22+
- FFmpeg and ffprobe on the system (Homebrew `ffmpeg` is fine). MATERIAL looks
  in `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`.

## Install and run

```bash
npm install
npm run dev        # development, with hot reload
```

```bash
npm run package    # unsigned .app in release/mac-arm64/
npm run dist       # distributable build
```

Other scripts: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format`.

## First five minutes

1. Drop an image or video on the window (audio too, if you have some).
2. **Mosaic** is applied automatically. Drag **Columns** and **Scale**.
3. Hold **`** or press **A/B** to compare against the untouched source.
4. Open **TECHNIQUES** and try Temporal Mosaic or Echo.
5. In the inspector, pick a preset — **Echo Chamber**, **Pump**, **Time
   Fracture**, **Slow Burn**.
6. Add a mapping: **+ ADD MAPPING**, choose `Bass → Depth`, press **Space**.
7. Open **EXPLORE**, generate variations, lock what you like, **Mutate** the
   rest.
8. **Export** — still, PNG sequence, H.264, or ProRes.

## What v0.1 does

| Area | Status |
|---|---|
| Sources | PNG/JPEG/WebP, MP4/MOV (H.264, HEVC), WAV/MP3/AAC/M4A, SVG |
| Techniques | Mosaic, Temporal Mosaic, Echo, Step Print, Slit Scan |
| Materials | Square, Circle, Line, Dot, Rectangle, Triangle, custom SVG, raster image |
| Audio | Offline analysis — master, RMS, bass, mids, highs, transients; manual BPM beat grid |
| Modulation | Any signal → any modulatable parameter, with amount, range, curve, smoothing, freeze |
| Explore | Seeded variations, parameter locks, MUTATE around a pick |
| Export | PNG still, PNG sequence (alpha), H.264 MP4, ProRes 422 HQ, ProRes 4444 (alpha) |
| Projects | `.material` JSON, autosave + crash recovery, relink for offline media |

## Keyboard

| | |
|---|---|
| `Space` | play / pause |
| `` ` `` (hold) | show the original |
| `⌘N` `⌘O` `⌘S` `⇧⌘S` | new / open / save / save as |
| `⌘I` | import media |
| `⌘E` | export |
| `⌘Z` `⇧⌘Z` | undo / redo |
| `⌘D` | debug overlay |
| double-click viewport | fit |
| `shift` + slider drag | fine control |
| double-click a slider | reset to default |

## Current limitations

- macOS only. Nothing is deliberately Windows-hostile, but nothing is tested there.
- Temporal history reaches **2.29 s** (56 slots at 1/24 s) at proxy resolution.
- Colour is sRGB throughout. No Rec.709/linear/HDR pipeline yet.
- Keyframes are modelled in the project format but have no UI.
- PERFORMANCE workspace is architecture only.
- ProRes availability depends on your FFmpeg build; the option is hidden if the
  encoder is not present.

## Documentation

[ARCHITECTURE](docs/ARCHITECTURE.md) ·
[TECHNIQUE_API](docs/TECHNIQUE_API.md) ·
[MATERIAL_API](docs/MATERIAL_API.md) ·
[MODULATION](docs/MODULATION.md) ·
[TEMPORAL_ENGINE](docs/TEMPORAL_ENGINE.md) ·
[EXPORT_PIPELINE](docs/EXPORT_PIPELINE.md) ·
[PROJECT_FORMAT](docs/PROJECT_FORMAT.md) ·
[TROUBLESHOOTING](docs/TROUBLESHOOTING.md) ·
[DECISIONS](docs/DECISIONS.md) ·
[ROADMAP](docs/ROADMAP.md)

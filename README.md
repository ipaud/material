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

## First five minutes — with nothing at all

Since Creative Expansion 01 you do not need to import anything to start.

1. Add a **Noise Field** or **Grid** source. The instrument is now running.
2. Put a technique on it — try **Time Field**, then **Feedback Zoom**.
3. Pin two Looks and morph between them with a transition style.

See [CREATIVE_GUIDE.md](docs/CREATIVE_GUIDE.md) for what the seven creative
areas do and which combinations are worth knowing.

## First five minutes — with footage

1. Drop a video on the window, and an audio file with it.
2. **Mosaic** is applied automatically. Drag **Columns** and **Scale**.
3. Hold **`** or press **A/B** to compare against the untouched source.
4. Add a mapping: **+ ADD MAPPING**, choose `Bass → Scale`, press **Space**.
5. Hit **DETECT** or **TAP** in the timeline to get on the beat grid.
6. Press **P** a few times to pin Looks, then **1**–**9** to play them.
7. Switch to the **PERFORM** workspace (⌘⌥3), set **SYNC** to `BAR`, and change Looks
   on the downbeat.
8. Press **G** to mutate what is playing, hold **B** to audition it.
9. **Export** — still, PNG sequence, H.264, or ProRes.

Longer walkthrough: [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md).

## What MATERIAL does

| Area       | Status                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| Sources    | PNG/JPEG/WebP, MP4/MOV (H.264, HEVC), WAV/MP3/AAC/M4A, SVG — plus LIVE: Camera, Screen, Window                |
| Techniques | Mosaic, Temporal Mosaic, Echo, Step Print, Slit Scan                                                          |
| Materials  | Square, Circle, Line, Dot, Rectangle, Triangle, custom SVG, raster image                                      |
| Audio      | Offline analysis — master, RMS, peak, bass, mids, highs, centroid, flux, onset; tempo detection and tap tempo |
| Beat grid  | Bars, beats, divisions and markers from BPM + offset + time signature                                         |
| Modulation | Any signal → any modulatable parameter, with amount, range, curve, smoothing, freeze                          |
| Triggers   | Beat / bar / division / onset / marker → pulses, freeze, Look and morph actions, all quantizable              |
| Looks      | Nine slots with thumbnails, keyboard recall, and morphs over seconds, beats or bars                           |
| MIDI       | Web MIDI, MIDI Learn for parameters, macros and actions, pickup / soft takeover                               |
| Perform    | Dedicated workspace: Look strip, macros, trigger pads, quantized actions, minimal HUD                         |
| Mutate     | CURRENT / CANDIDATE — generate, audition, apply or pin without disturbing the output                          |
| Explore    | Seeded variations, parameter locks, MUTATE around a pick                                                      |
| Export     | PNG still, PNG sequence (alpha), H.264 MP4, ProRes 422 HQ, ProRes 4444 (alpha)                                |
| Projects   | `.material` JSON, autosave + crash recovery, relink for offline media, v1 → v3 migration                      |
| Live       | Camera / Screen / Window sources, intent-gated permissions, realtime temporal history, no audio capture       |
| Output     | Display destination: fullscreen on a chosen monitor, passive replica, live fan-out                            |

## Keyboard

|                                |                                                |
| ------------------------------ | ---------------------------------------------- |
| `Space`                        | play / pause                                   |
| `` ` `` (hold)                 | show the original                              |
| `⌘N` `⌘O` `⌘S` `⇧⌘S`           | new / open / save / save as                    |
| `⌘I`                           | import media                                   |
| `⌘E`                           | export                                         |
| `⌘Z` `⇧⌘Z`                     | undo / redo                                    |
| `⌘D`                           | debug overlay                                  |
| double-click viewport          | fit                                            |
| `shift` + slider drag          | fine control                                   |
| double-click a slider          | reset to default                               |
| `1`–`9`, `⇧1`–`⇧9`             | apply / overwrite Look slots                   |
| `P`, `F`                       | pin Look, freeze all                           |
| `Q`, `M`, `Tab`, `Esc`         | quantization, morph, HUD, cancel (Performance) |
| `Z X C V`                      | trigger pads (Performance)                     |
| `G`, `⇧G`, `B` (hold), `Enter` | mutate, mutate again, audition, apply          |

Full reference: [docs/SHORTCUTS.md](docs/SHORTCUTS.md), or press **?** in the
title bar.

## Permissions (macOS)

- **Camera** is requested only when you press START on a camera source —
  never on launch or project open. Grant in System Settings → Privacy &
  Security → Camera.
- **Screen / Window capture** asks for Screen Recording the first time you
  start a capture or list windows: System Settings → Privacy & Security →
  Screen & System Audio Recording (macOS asks you to authenticate, and may
  ask to relaunch MATERIAL).
- MATERIAL never requests microphone or system audio.

## Current limitations

- macOS only. Nothing is deliberately Windows-hostile, but nothing is tested there.
- One Output display at a time; live sources cannot be exported to
  sequence/movie; window capture identity must be reselected per session.
- Temporal history reaches **2.29 s** (56 slots at 1/24 s) at proxy resolution.
- Colour is sRGB throughout. No Rec.709/linear/HDR pipeline yet.
- Keyframes are modelled in the project format but have no UI.
- One global BPM per project — no tempo map, so music that drifts will drift
  off the grid.
- Physical MIDI hardware is untested: all MIDI validation used a virtual
  CoreMIDI device.
- No performance recording. Live knob moves, pad hits and keystrokes are real
  in the room and absent from exports; recorded morphs are the exception.
- ProRes availability depends on your FFmpeg build; the option is hidden if the
  encoder is not present.

## Documentation

**Start here** — [GETTING_STARTED](docs/GETTING_STARTED.md) ·
[SHORTCUTS](docs/SHORTCUTS.md) ·
[RELEASE_NOTES](docs/RELEASE_NOTES.md)

**Systems** — [SIGNALS](docs/SIGNALS.md) ·
[MODULATION](docs/MODULATION.md) ·
[PARAMETER_EVALUATION](docs/PARAMETER_EVALUATION.md) ·
[PERFORMANCE](docs/PERFORMANCE.md) ·
[MIDI](docs/MIDI.md) ·
[TEMPORAL_ENGINE](docs/TEMPORAL_ENGINE.md)

**Internals** — [ARCHITECTURE](docs/ARCHITECTURE.md) ·
[TECHNIQUE_API](docs/TECHNIQUE_API.md) ·
[MATERIAL_API](docs/MATERIAL_API.md) ·
[EXPORT_PIPELINE](docs/EXPORT_PIPELINE.md) ·
[PROJECT_FORMAT](docs/PROJECT_FORMAT.md) ·
[BACKGROUND_RENDERING](docs/BACKGROUND_RENDERING.md)

**Reference** — [TROUBLESHOOTING](docs/TROUBLESHOOTING.md) ·
[DECISIONS](docs/DECISIONS.md) ·
[ROADMAP](docs/ROADMAP.md)

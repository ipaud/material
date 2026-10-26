# MATERIAL

A desktop instrument for experimental moving-image design.

MATERIAL is not a filter gallery. You build a **visual system** — a source, a
technique, a repeated material, and signals that drive them — and then play
with the rules until the image becomes something you would not have drawn by
hand.

Build a visual system. Explore what it can become. Play it.

```
SOURCE → TECHNIQUE → MATERIAL → MODULATION → OUTPUT
```

Everything runs locally. No accounts, no cloud, no telemetry, no media upload. The one thing it does
on its own over the network is ask GitHub, at most once a day, whether a newer MATERIAL exists
([how updates work](docs/UPDATES.md); one menu item turns it off).

## Requirements

- macOS on Apple Silicon (built and tested on M-series), or Windows 64-bit (see below)
- Node 22+
- FFmpeg and ffprobe on the system. On macOS Homebrew's `ffmpeg` is fine (MATERIAL looks on the PATH and in
  `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`). On Windows: `winget install Gyan.FFmpeg`,
  `choco install ffmpeg` or `scoop install ffmpeg`.

## Install and run

```bash
npm install
npm run dev        # development, with hot reload
```

```bash
npm run package    # unsigned .app in release/mac-arm64/
npm run dist       # distributable build
```

### Windows

Download `MATERIAL-<version>-win-x64-setup.exe` (installer) or `MATERIAL-<version>-win-x64.zip` (portable) from the
[latest release](https://github.com/ipaud/material/releases/latest). The app is not code-signed, so SmartScreen says
"Windows protected your PC": **More info → Run anyway**. Install FFmpeg (above), then start MATERIAL. To build it
yourself: `npm run dist:win` (on Windows).

Other scripts: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format`.

## First five minutes — with nothing at all

Since Creative Expansion 01 you do not need to import anything to start.

1. Add a **Noise Field** or **Grid** source. The instrument is now running.
2. Put a technique on it — try **Time Field**, then **Feedback Zoom**.
3. Pin two states, make them Looks, and morph between them.

See [CREATIVE_GUIDE.md](docs/CREATIVE_GUIDE.md) for what the seven creative
areas do and which combinations are worth knowing.

## First five minutes — with footage

1. Drop a video on the window, and an audio file with it.
2. **Mosaic** is applied automatically. Drag **Columns** and **Scale**.
3. Hold **`** or press **A/B** to compare against the untouched source.
4. Add a mapping: **+ ADD MAPPING**, choose `Bass → Scale`, press **Space**.
5. Hit **DETECT** or **TAP** in the timeline to get on the beat grid.
6. Press **P** to save Pins. In Library, **Make Look** assigns a Pin to a playback slot.
   Then use **1**–**9** to play Looks.
7. Switch to the **PLAY** workspace (⌘⌥3), set **SYNC** to `BAR`, and change Looks
   on the downbeat.
8. Press **G** to mutate what is playing, hold **B** to audition it.
9. **Export** — still, PNG sequence, H.264, or ProRes.

Longer walkthrough: [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md).

## What MATERIAL does

| Area       | Status                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| Sources    | PNG/JPEG/WebP, MP4/MOV (H.264, HEVC), WAV/MP3/AAC/M4A, SVG — plus LIVE: Camera, Screen, Window                |
| Techniques | Mosaic, Temporal Mosaic, Echo, Step Print, Slit Scan, Feedback, Motion, Simulation                            |
| Shaders    | Local shader packs — data + GLSL, no plugin code; parameters become real controls; ISF single-pass subset     |
| Materials  | Square, Circle, Line, Dot, Rectangle, Triangle, custom SVG, raster image                                      |
| Audio      | Offline analysis — master, RMS, peak, bass, mids, highs, centroid, flux, onset; tempo detection and tap tempo |
| Beat grid  | Bars, beats, divisions and markers from BPM + offset + time signature                                         |
| Image      | Luminance, contrast and edge energy of the frame itself, calibrated per source                                |
| Motion     | Amount, activity, direction X/Y and the CENTRE of movement — from optical flow, no tracking model             |
| Modulation | Any signal → any modulatable parameter: Add or Set, input/output range, curve, smoothing, freeze              |
| Triggers   | Beat / bar / division / onset / marker → pulses, freeze, Look and morph actions, all quantizable              |
| Pins       | Project-persisted snapshots; Make Look assigns one of nine performance slots                                  |
| Looks      | Nine slots with keyboard recall and morphs over seconds, beats or bars                                        |
| MIDI       | Web MIDI, MIDI Learn for parameters, macros and actions, pickup / soft takeover                               |
| Play       | Dedicated workspace: Look strip, macros, trigger pads, quantized actions, minimal HUD                         |
| Capture    | Record what you play as a Take — faders, macros, Looks, Morphs, Freeze — replay it, edit it, export it        |
| Mutate     | CURRENT / CANDIDATE — generate, audition, apply or pin without disturbing the output                          |
| Explore    | Seeded variations, parameter locks, MUTATE around a pick                                                      |
| Export     | PNG still, PNG sequence (alpha), H.264 MP4, ProRes 422 HQ, ProRes 4444 (alpha)                                |
| Projects   | `.material` JSON, autosave + crash recovery, relink for offline media, v1 → v7 migration                      |
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
| `P`, `F`                       | save Pin, freeze all                           |
| `R`, `T`                       | arm recording, play the selected Take          |
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

- macOS (Apple Silicon) and Windows (64-bit). The Windows build is new: the suite and a start of the app run on a real Windows machine in CI, but it has had little use by hand.
- Performance depends on GPU, resolution and active techniques; published measurements use a 1080p composition on Apple Silicon.
- `.material` projects reference media by absolute path; media is not embedded. Keep source files with the project or relink them after moving it. Unknown project-format versions are refused rather than guessed.
- One Output display at a time; live sources cannot be exported to
  sequence/movie; window capture identity must be reselected per session.
- Live capture depends on operating-system permissions. On macOS, camera access is requested at START; screen/window capture may require System Settings approval and an app relaunch.
- Temporal history reaches **2.29 s** (56 slots at 1/24 s) at proxy resolution.
- Colour is sRGB throughout. No Rec.709/linear/HDR pipeline yet.
- Keyframes are modelled in the project format but have no UI.
- One global BPM per project — no tempo map, so music that drifts will drift
  off the grid.
- Physical MIDI hardware is untested: all MIDI validation used a virtual
  CoreMIDI device.
- A shader pack is not sandboxed. MATERIAL refuses obvious accidents and bounds
  what a pack may declare, but well-formed GLSL can still overload the GPU —
  install packs from people you trust.
- Custom shaders are fragment-only and single-pass, with one source texture.
- Image and motion signals over LIVE sources are live-class: real in the room,
  absent from exports, like every other live signal.
- Motion is measured by optical flow over a 320×180 analysis grid, so it sees
  movement, not objects. There is no tracking, no depth and no recognition.
- Performance Capture records intent, not the picture: your gestures replay
  while Signals, Audio and Patterns re-evaluate. Live gestures you did **not**
  record are still absent from exports.
- A Take is one performance at a time. No punch-in, no overdub, no takes placed
  as clips on a timeline, no beat-snapping — see
  [BACKLOG](docs/BACKLOG.md#v07--performance-capture).
- ProRes availability depends on your FFmpeg build; the option is hidden if the
  encoder is not present.

## Documentation

**Start here** — [GETTING_STARTED](docs/GETTING_STARTED.md) ·
[PRODUCT_PRINCIPLES](docs/PRODUCT_PRINCIPLES.md) ·
[SHORTCUTS](docs/SHORTCUTS.md) ·
[RELEASE_NOTES](docs/RELEASE_NOTES.md)

**Systems** — [PERFORMANCE_CAPTURE](docs/PERFORMANCE_CAPTURE.md) ·
[AUTOMATION](docs/AUTOMATION.md) · [SHADERS](docs/SHADERS.md) · [SHADER PACKS](docs/SHADER_PACKS.md) · [ISF](docs/ISF.md) · [SIGNALS](docs/SIGNALS.md) ·
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

# Release Notes

## v0.1.0 — 2026-08-28

First complete functional foundation. MATERIAL v0.1 proves the core thesis:
import media, build a GPU visual system, drive it deterministically with
audio, explore variations, and render output that is usable in other tools.

### Capabilities

**Sources** — PNG/JPEG/WebP images; MP4/MOV/M4V video (H.264 and HEVC via
system decode, verified at 4K); WAV/MP3/AAC/M4A audio; SVG (sanitized, as
material). Media is referenced by path, never copied; missing files surface
as MEDIA OFFLINE with in-place relink.

**Techniques** — Mosaic (up to 65,536 instances in one draw call),
Temporal Mosaic / Video Tile, Echo, Step Print, Slit Scan. All plugins over
one registry; techniques never decode video themselves.

**Temporal engine** — composition-time addressed frame history (56 slots ×
1/24 s = 2.29 s, 7.9 MB fixed). Eight offset distributions (uniform, radial,
linear X/Y, distance-from-centre, seeded random, luminance, noise field) with
falloff, direction and centre. Preview capture is honest (seeks invalidate;
history is never faked); export rebuilds history from exact timestamps and is
byte-identical regardless of prior preview state (verified by MD5).

**Materials** — six SDF shapes, custom SVG (two-layer sanitization) and
raster images with alpha; four colour modes.

**Audio** — offline deterministic analysis (2048 FFT / 512 hop): master, RMS,
bass 20–250 Hz, mids 250 Hz–4 kHz, highs 4–16 kHz, spectral-flux transients;
waveform; manual BPM + beat grid with bar/½/¼/⅛/1/16 phase signals; audio is
the master clock, video slaved (measured 0.0 ms drift).

**Modulation** — any signal → any modulatable parameter; signed amount scaled
to the parameter's range, min/max window, linear/exp/log curves, EMA
smoothing, per-mapping FREEZE. Preview and export evaluate identically
(measured agreement 4.2 × 10⁻¹³).

**Explore** — seeded, reproducible populations (4/8/12/20); parameter and
per-mapping locks; MUTATE around a selected parent at 25 % sigma with
lineage; progressive offscreen thumbnails; apply / pin / regenerate.

**Presets** — system presets Echo Chamber, Pump, Time Fracture, Slow Burn
(requirements surfaced when the project lacks video/audio/BPM) plus user
presets persisted app-wide. Pinned Looks capture full visual state per
project.

**Export** — deterministic frame loop (`t = start + i/fps`, fresh smoothing
state, frame-exact seeks): PNG still, PNG sequence (RGBA), H.264 MP4 (+AAC
audio trimmed to range), ProRes 422 HQ, ProRes 4444 with real alpha —
ProRes offered only when the local FFmpeg has `prores_ks`. Progress, cancel
(partial movies deleted), size-validated IPC frames.

**App** — dark, dense instrument UI; resizable panels; A/B compare;
undo/redo with one-entry slider gestures; autosave every 15 s to a recovery
store that never touches the user's `.material` file, with crash-only
recovery prompt (verified by SIGKILL); techniques browser with previews
generated from owned procedural footage; debug overlay (⌘D) with temporal
cache stats; structured errors — nothing fails silently. Fully offline: no
accounts, no telemetry, no uploads.

### Verified baseline numbers (M5 Pro, macOS 26.5)

| Measurement | Result |
|---|---|
| Preview, 1080p mosaic 48×27 during playback | 120–140 fps |
| Preview, 4K H.264 source, 80×45 mosaic | 120 fps, 0.3 ms/frame |
| Preview, 4K + temporal (Video Tile radial) | 365–578 fps engine loop |
| Preview, 4K HEVC source | 261 fps |
| Temporal cache | 56 slots, 7.9 MB, constant w.r.t. source resolution |
| Export, 720p 7 s / 175 frames with temporal | 6.8 s wall (≈ realtime) |
| Export, 4K 3 s / 90 frames with temporal | 46.9 s (≈ 0.52 s/frame) |
| A/V drift during playback | 0.0 ms |
| Preview↔export modulation agreement | ≤ 4.2 × 10⁻¹³ |
| Export independence from preview state | byte-identical MD5 |
| Test suite | 95 tests, all green |

### Known limitations

- macOS / Apple Silicon only; app is unsigned and not notarized.
- Temporal history spans 2.29 s at proxy resolution (256×144 slots).
- Colour is sRGB end-to-end; no Rec.709/linear/HDR management.
- Keyframes exist in the data model, no UI.
- PERFORMANCE workspace is a placeholder.
- Technique chains are modelled; only the first enabled technique renders.
- BPM is manual; beat sources are silent without it.
- Codecs Chromium cannot decode (ProRes, DNxHD sources…) need transcoding
  before import — see docs/TROUBLESHOOTING.md.

### Project format

`.material` v1 (JSON, zod-validated, atomic writes). v0.2 will introduce
format v2 with an automatic 1→2 migration; every v0.1 project will open
unchanged in v0.2.

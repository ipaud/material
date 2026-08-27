# Troubleshooting

## Media

**"Unsupported file type"** — MATERIAL accepts PNG/JPEG/WebP, MP4/MOV/M4V,
WAV/MP3/AAC/M4A and SVG. The check is by extension; rename-only files will
still fail at decode.

**"Could not decode … (unsupported codec?)"** — the container is readable but
Chromium cannot decode the video stream. ProRes, DNxHD, HAP and 10-bit HEVC
are common cases. Transcode first:

```bash
ffmpeg -i input.mov -c:v libx264 -crf 18 -pix_fmt yuv420p output.mp4
```

**Video will not scrub, or temporal techniques show a frozen past** — the
source must be seekable. MATERIAL serves media with HTTP range support, so
this normally works; a file still being written, or on a disconnected network
volume, will not seek. Copy it locally and re-import.

**MEDIA OFFLINE** — the file moved. Click the item in the Library to relink it.
The project is not modified until you save.

**FFmpeg not found** — install it (`brew install ffmpeg`). MATERIAL searches
`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`. Without it,
media probing and all animation export are unavailable; still export still
works.

## Audio

**Waveform never appears** — analysis runs in a worker over the whole file;
a 3-minute track takes a few seconds. The timeline shows "analyzing audio…"
while it runs. If it never finishes, the file probably failed to decode — check
the toast.

**Beat sources do nothing** — they need a BPM. Enter one in the timeline;
detection is manual by design in v0.1. `Beat · 1/4` at 120 BPM is a 0→1 ramp
every 0.5 s.

**Audio and video drift apart** — they should not; audio is the master clock
and video is corrected toward it. Open the debug overlay (`⌘D`) and check
`a/v drift`. If the video is shorter than the audio it freezes on its last
frame past its end, which is intended.

## Rendering

**Black viewport** — usually no source is selected. Check the Library, then
that a technique is active in the inspector.

**Everything vanished after changing a parameter** — likely `Threshold`
(cells below it are dropped) or `Max Offset` with an empty temporal buffer.
Double-click a slider to reset it to its default.

**Preview stutters on a huge grid** — the mosaic caps at 65,536 instances.
Above roughly 250×250 the cap silently clamps; reduce Columns/Rows.

## Temporal

**Temporal effects look "stuck" while scrubbing** — expected. Frames before a
seek are not history for after it, so the buffer invalidates and rebuilds as
playback moves forward. Play forward for a second and it fills.

**Only ~2.3 s of history is reachable** — that is the buffer span (56 slots at
1/24 s). `Max Offset` is capped to it.

**Exported temporal result differs from what I saw** — it should not. Export
rebuilds history from exact timestamps rather than reusing preview contents, so
the export is the correct one; a preview mid-rebuild can be the misleading one.

## Export

**Export fails immediately** — no FFmpeg, or an unwritable destination.

**ProRes options are missing** — your FFmpeg lacks `prores_ks`. MATERIAL only
offers codecs it can actually produce.

**Alpha export looks opaque** — alpha needs PNG Sequence or ProRes 4444, plus
the **Alpha** toggle. H.264 has no alpha channel.

**4K export is slow** — roughly 0.5 s/frame at 3840×2160 with temporal
techniques, dominated by full-resolution readback and frame-exact seeking.
This is final-render cost; preview stays interactive.

**Cancelled export left files behind** — partial movies are deleted, but PNG
sequences keep the frames already written, on purpose.

## Projects

<a id="recovery"></a>
**"MATERIAL closed unexpectedly"** — an autosave from a session that did not
shut down cleanly. Autosaves live in `userData/recovery/` and are written every
15 s while a project has unsaved changes.

Recovering loads the project **into the editor only**. Your `.material` file on
disk is never written by recovery — it stays exactly as you last saved it until
you press Save yourself. Choose:

- **Recover** — load it, then decide whether to save over the original.
- **Discard** — delete the autosave.
- **Ignore for now** — keep it on disk for the next launch.

**Project will not open** — `.material` files are validated on read. A version
mismatch or corrupted JSON is refused rather than partially loaded. The
recovery folder may hold a recent autosave.

## Diagnostics

`⌘D` toggles the debug overlay: fps, frame time, instance count, zoom, clock
and its source, A/V drift, and — when temporal is active — filled slots, cache
MB, span, anchor time, cache hits/misses and seek count.

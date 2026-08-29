# Release Notes

## v0.3.0 — LIVE / OUTPUT

### Live Sources

MATERIAL can now play three live inputs alongside files:

- **Camera** — any connected camera as a live visual source.
- **Screen** — capture a physical display.
- **Window** — capture one application window.

Live sources are *live*: pixels are always "now". They cannot seek, they
keep running while the transport is paused, and sequence/movie export is
unavailable for them (a PNG still of the current frame remains available).
Selecting a live source in a project never touches the camera or the
screen — capture starts only from the explicit START action.

### Output

- **Display destination** — present the composition fullscreen on a chosen
  monitor (or in a movable window). One output display at a time.
- The output window is a passive replica driven by the editor: opening,
  closing, or crashing it never interrupts the editor or a live capture,
  and reopening rejoins the same live source with no extra prompt.

### Live Temporal

Temporal techniques (Echo, Step Print, Slit Scan, Mosaic video tile) now
work on Camera / Screen / Window in realtime. History accumulates from the
moment the source starts — it warms up over a couple of seconds, keeps
accumulating while the transport is paused, never rewinds on seek, and
resets when the source stops or changes. The Output display keeps its own
local history, so it may look slightly different for the first moments
after opening. File-video temporal rendering (and its deterministic
export) is unchanged.

### Pattern Engine v1 + v1.5

First numbered release carrying the Pattern Engine: deterministic step
sequences, euclidean rhythms, probability (degrade), mini-notation, the
BUILD pattern editor, and the v1.5 combinators (smooth, alternate, rest,
iter, maybe, shuffle). Patterns are seek-safe, export-deterministic and
identical on the Output display.

### Permissions

- Camera permission is requested only when you press START on a camera
  source — never on launch or when opening a project.
- Screen recording permission is requested only when you start a Screen or
  Window capture (or list windows). macOS grants it in
  **System Settings → Privacy & Security → Screen & System Audio
  Recording**; the OS asks for authentication and may require relaunching
  MATERIAL.
- MATERIAL never captures microphone or system audio.

### Known limitations

- One Output display at a time; no multi-output, no Syphon/NDI.
- No audio capture of any kind.
- No sequence/movie export from live sources.
- Window capture identity does not persist across sessions — reselect the
  window after reopening a project.
- The Output warms its temporal history independently for a moment.
- Internal build: ad-hoc signature, not notarized. Because ad-hoc
  signatures change with every rebuild, macOS ties the Screen Recording
  grant to one specific binary — after replacing MATERIAL.app you must
  re-toggle it (off→on) under System Settings → Privacy & Security →
  Screen & System Audio Recording. Camera permission is not affected.
  A Developer ID signature would make the grant stable.

---

## Unreleased

### Pattern Engine v1.5 — combinators

Six new pattern tools, all deterministic and seek-safe. Semantics inspired
by pattern live-coding systems; the implementation is entirely MATERIAL's.

- **Smooth** — steps become waves: values glide to the next step by phase,
  with none of the lag of mapping smoothing.
- **Alternate** — `<0 0.5 1>`: one value per cycle, rotating.
- **Rest** — `~` in a sequence: a step that deliberately plays nothing.
- **Iter** — the pattern starts one step later every cycle.
- **Maybe** — apply a transform (reverse, rotate, iter, fast, slow) on a
  cycle with deterministic probability — independent from PROBABILITY
  (degrade) by construction.
- **Shuffle** — every cycle deals the same steps in a new deterministic
  order.

All persist inside the existing v2 project format. Projects using the new
pieces need a v1.5-aware build to open cleanly.

### Pattern Engine v1

Native deterministic temporal patterns, authored in **BUILD → SIGNALS**. A
pattern is a signal source like Bass or Beat: you map it onto a parameter
through the existing modulation system, and the project's tempo gives it a
grid. Inspired by pattern-based live-coding systems; it is not TidalCycles
and has no dependency on it.

- **Types**: Sequence (`0 0.25 1 0.25` in a text field), Euclidean
  (pulses/steps/rotation with a live step readout), Constant.
- **Transforms**, applied as an explicit ORDERED list: Fast, Slow, Reverse,
  Rotate, Every, Probability. Order is creative meaning —
  `Fast → Reverse` and `Reverse → Fast` are different patterns, and the
  editor shows and preserves that order.
- **Probability is deterministic**: the same project seed, pattern and step
  always make the same decision. Exports, reloads and restarts reproduce it
  exactly.
- **Cycle length** is set per pattern in beats, independent of the bar.
- **No BPM → patterns are neutral.** They contribute nothing until the
  project has a tempo; there is no invented fallback and no pattern-local
  clock.
- Preview, the Output window and offline export resolve identical
  parameters; repeated exports of a pattern composition are byte-identical.
- Patterns persist inside the existing v2 project format (no version bump);
  older projects keep opening unchanged.

- **Fixed**: a Morph armed ahead of the playhead no longer pins the
  composition to its source snapshot when you seek or loop backwards past
  it (the "zombie morph"). A morph now simply waits for its start time,
  matching what offline export already did.
- **Changed**: local packaged builds are ad-hoc signed. Leaving them
  unsigned kept Electron's own linker signature on the renamed bundle
  (`Identifier=Electron`, no sealed resources), which failed
  `codesign --verify --strict`. Hardened runtime stays off for these builds:
  ad-hoc plus hardened runtime trips macOS library validation, and hardened
  runtime is only needed for notarized distribution.
- **Added**: the main process now reports a renderer that fails to load and
  shows the window anyway. Previously the window waited for `ready-to-show`
  forever, so a load failure would have left a running app with no visible
  window and no diagnostic.

### Compatibility

Projects containing Pattern sources should be edited with a Pattern-aware
build. `patternSources` is an additive v2 field, so an older v0.2 build will
open such a project — but it strips the field on save, silently discarding
every pattern.

### Not in Pattern v1

Pattern triggers, Choice, Alternate, Mask, Stack, the full Tidal grammar,
OSC, MIDI clock, a live-coding editor, and Tidal/Strudel integration are all
deliberately out of scope.

### Distribution status

Local checkpoint builds are ad-hoc signed and **not** notarized: Gatekeeper
will refuse them on another machine. Developer ID signing and notarization
are prerequisites for public distribution and are not set up yet.

## v0.2.0 — MUSIC / PERFORMANCE

v0.1 proved MATERIAL could construct visual systems. v0.2 makes those systems
**playable**: a musical clock, signals that fire on the beat, Looks you can
switch and morph between, a physical controller, and a workspace built for
performing rather than editing.

### Highlights

**Audio Engine 2.** Peak, spectral centroid, flux and a proper onset track
join the v0.1 features. Bands share one normalization reference so their
balance is real; the centroid is absolute (100 Hz – 8 kHz log scale) so
"bright" means the same thing across songs. All offline, all deterministic.

**Tempo and beat grid.** Offline tempo detection (autocorrelation over the
onset envelope, 60–200 BPM, log-normal prior at 120) with confidence and a
half/double-time alternative, plus tap tempo. Detection is _advisory_ — your
manual BPM always wins, and silence returns nothing rather than a
confident-looking number. The grid drives bar/beat readouts, divisions and
every quantized action.

**Trigger engine.** Beat, bar, divisions, onsets and markers fire actions
through one scheduler that processes half-open time intervals, so an event on
a boundary fires exactly once no matter how frames are cut, where you seek, or
how a loop wraps.

**Pulses.** An AHD envelope per trigger, evaluated as a pure function of time.
Overlapping pulses sum then clamp, so a drum roll builds energy. Because there
is no state machine, seeking is free and export needs no replay.

**Freeze 2.0.** Freeze all modulated values, or one at a time, with a live
BASE / MOD / PULSE / FINAL breakdown per mapping. Frozen state survives Look
switches, morphs and a live controller.

**Looks 2.0.** Nine slots with thumbnails, keyboard recall, rename, duplicate,
update and a "modified" indicator. A Look captures technique, parameters,
material, modulations, triggers and seed — applied atomically as one undo
entry.

**Morph.** Interpolate between Looks over seconds, beats or bars. Numbers
glide; techniques, materials and enums switch cleanly at the midpoint;
unmatched modulations cross-fade; triggers hand over without double-firing.
An armed morph is a pure function of time, so seeking and looping reconstruct
it exactly, and completed morphs are recorded so they export.

**MIDI with MIDI Learn.** Web MIDI in Electron, no native dependency.
Right-click any parameter to learn a knob; pick an action and hit a pad to
learn a note. Devices reconnect by name when the platform id changes, and
mappings persist offline rather than vanishing.

**Pickup.** A knob whose position disagrees with the software value waits
until you sweep across it. After a Look change the affected knobs return to
waiting — which is what makes Look switching safe with fixed controllers.

**Performance workspace.** Output dominates; below it sit nine Look slots,
macros, the actions and a musical readout with a beat pulse. Tab strips it to
a minimal HUD.

**Macros.** One 0–1 control fanned out to several parameters with per-target
amount, range, curve and invert. This is where MATERIAL's depth folds into
something playable: five relationships in CREATE become `MEMORY 0.73` in
PERFORMANCE. MIDI-learnable, and never written into stored Looks.

**Quantized performance.** A global Off / Beat / Bar / 2 / 4 Bars setting
governs Look changes, morph starts and candidate applies. Queued actions are
visible and cancellable; measured boundary error at 78.03 BPM was 0 ms.

**Candidate / Mutate.** Press `G` and MATERIAL mutates what is playing into a
CANDIDATE held entirely outside the project. Hold `B` to audition it live,
`⇧G` to mutate again along a lineage, Enter to apply it musically, PIN to save
it without touching the output. Generating or previewing can never alter what
the audience sees.

### Measured performance

|                                              |                            |
| -------------------------------------------- | -------------------------- |
| Mosaic, 1080p                                | 120 fps                    |
| Temporal (Echo Chamber), 1080p               | 119 fps                    |
| Mosaic / Echo / Fracture, **4K** (3840×2160) | 117–120 fps                |
| Performance workspace, active macros         | 120 fps                    |
| Macro input → store                          | 0.013 ms                   |
| Macro input → pixels                         | 16.4 ms (one frame)        |
| MIDI event → parameter                       | 0.17 ms mean, 0.5 ms worst |
| Look apply                                   | 0.1–0.3 ms                 |
| Trigger pad fire                             | < 0.1 ms                   |
| Candidate generate (incl. thumbnail)         | 14.7 ms                    |
| Candidate preview → pixels                   | 5.8 ms                     |
| Morph overlay evaluation                     | 4.8 µs                     |
| Export, 960×540 @ 24 fps, 4 s                | 4.8–6.9 s per format       |
| Renderer heap, heavy session                 | ~85 MB, flat               |
| Project with 20 Looks                        | 331 KB                     |

4K needs no proxy media — measured, not assumed.

### Compatibility

Project format stays at **v2**. v0.1 (v1) projects open and migrate: existing
visual state is preserved exactly, musical fields keep any BPM you had set,
and every v0.2 system starts empty rather than invented. Migration is
idempotent and never mutates the file on disk without an explicit Save.

### Long-session stability

A 30-minute scripted performance session — 228 cycles of Look changes,
quantized switches, macro sweeps, trigger pads, freeze/unfreeze, morphs,
mutations, candidate previews and applies, pins, undo/redo, workspace and HUD
toggling, seeks and transport stops:

|                                   |                                                     |
| --------------------------------- | --------------------------------------------------- |
| Errors                            | 0                                                   |
| Frame rate                        | 119–120 fps sustained (avg 116.9 across 40 samples) |
| Renderer heap                     | 87.8 MB → 21.6 MB (peak 90 MB) — no growth          |
| Queued actions left pending       | 0                                                   |
| Stale candidate / preview / morph | none                                                |
| Morph events recorded             | 20                                                  |

### Tested

- 307 automated tests; typecheck and lint clean.
- Export determinism across five representative projects (modulation, temporal,
  triggers, morph, applied candidate): byte-identical on re-export.
- Export isolation: byte-identical output while macros, Look switches, seeks
  and candidate generation were fired at it throughout.
- v1 → v2 migration and v2 round-trip, including a 20-Look project.
- Crash recovery, including v1 autosaves and malformed files.
- Timing edge cases at 60–200 BPM, 3/4, 4/4 and 6/8, positive and negative beat
  offsets, boundary-adjacent events, seeks and loops.
- Audio edge cases: silence, DC, near-silence, clipping, single impulses.
- MIDI input abuse: 5000-message CC storms, eight simultaneous controls,
  repeated notes, thirty rapid device reconnects.
- 60 candidate mutations across the six demonstration Looks.

### Experimental

- Tempo **detection** — advisory by design; confirm with TAP when it matters.
- ProRes 4444 with alpha — verified with ffprobe, less exercised in NLEs than
  H.264.

### Not implemented

- Performance recording. Live knob moves, pad hits and keystrokes are real in
  the room and absent from exports. Recorded morphs are the exception: they
  become timeline state and do export.
- MIDI clock, MIDI output, sysex, relative encoders.
- Tempo maps — one global BPM per project.
- Camera input, screen capture, Syphon, OSC, node graph, Shader Lab.

### Known limitations

- **Physical MIDI hardware is untested.** All MIDI validation used a virtual
  CoreMIDI device. The architecture, latency and pickup behaviour are verified;
  the _feel_ under a real controller (smoothing defaults, pickup epsilon) has
  not been tuned. See the checklist in MIDI.md.
- One global BPM. Music that drifts or slows will drift off the grid.
- One Candidate at a time; full populations stay in the Explore workspace.
- Candidate mutation does not touch materials, because material state reaches
  the renderer from the document rather than the per-frame transform — a
  mutated material would be invisible in preview.
- Look and Candidate thumbnails capture the frame under the playhead, so
  pinning during a dark passage yields a dark tile. MATERIAL warns and offers
  a re-thumbnail rather than moving the playhead behind your back.
- A hidden, paused editor may be throttled by macOS App Nap. Playback holds a
  suspension inhibitor, so a running transport is never affected. See
  BACKGROUND_RENDERING.md.
- Live MIDI is ignored during export, and Look/morph/candidate applies and
  seeks are blocked while exporting, because they move shared render state.

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

| Measurement                                 | Result                                              |
| ------------------------------------------- | --------------------------------------------------- |
| Preview, 1080p mosaic 48×27 during playback | 120–140 fps                                         |
| Preview, 4K H.264 source, 80×45 mosaic      | 120 fps, 0.3 ms/frame                               |
| Preview, 4K + temporal (Video Tile radial)  | 365–578 fps engine loop                             |
| Preview, 4K HEVC source                     | 261 fps                                             |
| Temporal cache                              | 56 slots, 7.9 MB, constant w.r.t. source resolution |
| Export, 720p 7 s / 175 frames with temporal | 6.8 s wall (≈ realtime)                             |
| Export, 4K 3 s / 90 frames with temporal    | 46.9 s (≈ 0.52 s/frame)                             |
| A/V drift during playback                   | 0.0 ms                                              |
| Preview↔export modulation agreement         | ≤ 4.2 × 10⁻¹³                                       |
| Export independence from preview state      | byte-identical MD5                                  |
| Test suite                                  | 95 tests, all green                                 |

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

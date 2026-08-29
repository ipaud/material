# Sources

MATERIAL's source taxonomy after Phase 18E:

| Kind     | Class | Seekable | Deterministic | Exportable | Audio | Persists |
|----------|-------|----------|---------------|------------|-------|----------|
| `image`  | file  | —        | yes           | yes        | no    | absolute path + metadata |
| `video`  | file  | yes      | yes           | yes        | opt.  | absolute path + metadata |
| `audio`  | file  | yes      | yes           | (timeline) | yes   | absolute path + metadata |
| `svg`    | file  | —        | yes           | (material) | no    | absolute path + metadata |
| `camera` | LIVE  | no       | no            | no         | never | `deviceId` (best-effort) |
| `screen` | LIVE  | no       | no            | no         | never | `displayId` (best-effort) |
| `window` | LIVE  | no       | no            | no         | never | `titleHint` (label only) |

## Live source contract (18D/18E)

- **Selection never captures.** Adding or selecting a live source only points
  the composition at it. Acquisition starts exclusively from the explicit
  user action (START / START SCREEN / START WINDOW), which arms the
  main-process permission gate with the exact target. Saved projects reopen
  IDLE — no permission prompt, no OS indicator.
- **Pixels are always "now".** The transport never pauses, seeks or
  rate-controls a sensor. Pause the transport: capture continues (liveness
  reason `live-source` keeps the app awake). Composition-time modulation
  (patterns, LFOs) keeps following the transport clock over live pixels.
- **The render loop goes continuous** while a live source is LIVE
  (`RenderEngine.setLiveSourceActive`) and returns to invalidation-driven
  rendering when it stops — file projects keep the lazy model.
- **Sequence/movie export is disabled** for a live source (not seekable, not
  deterministic). A PNG still of "now" stays available. Capturing an
  external screen into MATERIAL is NOT "record MATERIAL to a file" — the
  export pipeline and live sources never mix.
- **Temporal techniques are current-frame only** on live sources until 18F
  (realtime history accumulation). The Inspector shows an honest note.
- **The Output replica mirrors ACQUISITION, not selection**: the RenderInputs
  descriptor carries a live kind only while the editor capture is LIVE.
  Editor STOP releases the replica's stream too. The replica can never
  initiate or choose a capture (no picker, no enumeration — structurally
  test-locked); for screen/window it silently rejoins exactly the source
  main recorded as granted.

## Identity & persistence

- `camera.deviceId` — browser media device id; best-effort (can change across
  OS profiles). Missing device at START falls back to the default camera.
- `screen.displayId` — Electron display id (= macOS CGDirectDisplayID);
  best-effort. Missing display at START falls back to the primary. Never
  coupled to the OUTPUT target display.
- `window.titleHint` — human-readable label ONLY. OS window-capture ids are
  ephemeral (die with the window, never survive restart) and are never
  persisted; reopening always requires an explicit CHOOSE WINDOW.

## Permissions (macOS)

- Camera: `NSCameraUsageDescription`; TCC prompt on first START.
- Screen/Window: Screen Recording TCC. The prompt fires on the first capture
  attempt (START) or window enumeration (CHOOSE WINDOW). macOS offers no
  in-dialog Allow — the user grants in System Settings → Privacy & Security
  → Screen & System Audio Recording (authentication required by the OS).
- Audio/microphone/system audio: never requested, denied unconditionally by
  the main-process gate; the packaged Info.plist carries no microphone
  usage description.

Full ADRs: [DECISIONS.md](DECISIONS.md). Fan-out mechanics:
[LIVE_OUTPUT_ARCHITECTURE.md](LIVE_OUTPUT_ARCHITECTURE.md).

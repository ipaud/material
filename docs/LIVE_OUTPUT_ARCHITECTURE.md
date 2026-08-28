# LIVE / OUTPUT — v0.3 Architecture Audit

Status: **audit complete, implementation not started.** This document answers
"who owns time, state, media and pixels?" before any v0.3 code exists.
Audited at `feat/ui-v2` @ `7435bb8` (v0.2.0 + UI v2), Electron 44,
Three 0.185.1, macOS 15.

---

## 1. Current architecture (as audited, not as documented)

```
Electron MAIN (sandboxed children, contextIsolation, nodeIntegration off)
│  ipc/handlers.ts     typed invoke-only IPC (validated), no generic channel
│  main/protocol.ts    material:// media protocol (approval-gated paths)
│  main/menu.ts        native menu → menu:event push
│  powerSaveBlocker    'prevent-app-suspension', refcount 0/1, driven by
│                      IPC power:live-engine ← PlaybackController.play/pause
│  export/encoder.ts   ffmpeg mux/encode (frames arrive via export:frame)
│
└── ONE BrowserWindow (backgroundThrottling: false)
    └── Renderer process — every runtime singleton lives HERE, outside React:
        engine            RenderEngine: one WebGLRenderer + canvas, dirty-flag
                          rAF loop, renderStill() offscreen path (export,
                          thumbnails), beginExportMode() freezes preview
        playback          PlaybackController: THE composition clock.
                          Master priority: AudioContext.currentTime → video
                          element → none. Ticks triggers + morph each rAF.
        audioEngine       decode + offline analysis (worker) + playback
        midiEngine        single Web MIDI owner (learn, pickup, statuses)
        liveScheduler     single TriggerScheduler (quantized actions)
        modulationRuntime evaluates signals→params per frame via
                          engine.setParamTransform (pure w.r.t. (state, t))
        morphRuntime /    performance overlays, resolved through ONE pure
        candidateRuntime  resolveOverlay() path consumed by modulationRuntime
        engineBridge      store subscriptions → engine setters; OWNS the
                          HTMLVideoElement + VideoTexture for the file source
        Zustand stores    project / ui / playback / audio / export /
                          explore / candidate / midi
        React             presentation only; Viewport mounts the canvas and
                          calls engine.init/dispose per workspace switch
```

Ownership table:

| Concern                      | Owner today                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project state                | `projectStore` (renderer)                                                                                                                                     |
| RenderEngine + WebGL canvas  | `engine` singleton; canvas recreated per Viewport mount                                                                                                       |
| Media elements (video/audio) | `engineBridge` creates video; `audioEngine` owns audio                                                                                                        |
| Temporal cache               | `TemporalFrameProvider` inside engine — a 2D **atlas render target** (56 slots × 256×144, spacing 1/24s ≈ 8.1 MB), GPU-blit capture, _not_ texImage3D uploads |
| Transport clock              | `playback` (audio-master, video slaved with drift correction)                                                                                                 |
| App Nap blocker              | main process, toggled by transport play/pause only                                                                                                            |
| Export isolation             | `createFrameEvaluator` working copy + `engine.beginExportMode()`; preview renders suspended; temporal primed by exact seeks                                   |

### The export contract that must survive v0.3

Export never renders "what the preview shows". It replays deterministic
sources against a working copy at exact frame times, with live-class input
(manual/keyboard/MIDI) absent by design. Nothing in v0.3 may reintroduce a
preview-state leak into this path.

---

## 2. The core problem

A second BrowserWindow is a second renderer **process**. In Electron there is
no cross-process WebGL texture sharing and no zero-copy pixel transport
between windows (MessagePorts structured-clone across processes; ImageBitmap
does not transfer). Naively duplicating today's renderer stack in the output
window would duplicate: the clock, the scheduler, MIDI, candidate/morph
authority, media decode and temporal capture — with every double-fire and
drift bug that implies. Naively transporting pixels instead costs either a
GPU→CPU readback stream (1080p60 ≈ 500 MB/s) or a WebRTC encode hop
(latency + quality loss). Both are unacceptable for an instrument.

Two Chromium facts shape the answer:

1. **Pixels cannot be shared cheaply across windows** → each window must
   render its own frame with its own GL context.
2. **Capture devices ARE shared cheaply across windows** — Chromium runs one
   video-capture service per app: two `getUserMedia` calls for the same
   camera (or the same `getDisplayMedia` source) fan out one physical
   capture to both renderers. Live sources do not duplicate capture cost.

File video is the only true duplication: a second `<video>` element in the
output window is a second hardware decode session. Measured baseline decode
cost on Apple Silicon (1080p H.264 preview "effortless", per
docs/DECISIONS.md) makes one extra session acceptable; 4K×2 stays within
hardware decoder capacity.

---

## 3. Render-ownership options

### Option A — two fully independent renderers

Each window reconstructs everything from project state, including its own
clock, scheduler, modulation evaluation, MIDI.
**Rejected**: double authority. Quantized triggers, morph commits, candidate
apply and MIDI pickup would need to be made idempotent across processes —
an entire class of double-fire/divergence bugs bought for no benefit.

### Option B — one renderer, transported frames

Editor renders; output displays received frames.
**Rejected**: no viable transport. Readback+IPC saturates memory bandwidth;
`canvas.captureStream` → WebRTC adds encode latency, compression artifacts
and CPU; `webContents.capturePage` is a screenshot API. Also couples output
cadence to the editor's display and makes future per-display resolution
impossible. (A _native_ GPU path is exactly what Syphon would be — out of
scope, see §12.)

### Option C — one authority, replicated render surfaces ← **CHOSEN**

The existing editor renderer remains the **only runtime authority**: project
state, composition clock, audio, MIDI, trigger scheduler, modulation
evaluation, macro/freeze state, candidate/morph overlays. The Output Window
runs a **replica renderer**: its own `RenderEngine` instance and GL context,
its own media elements, **zero evaluation logic**. It renders exactly the
compact, already-evaluated frame state it receives.

Why this fits MATERIAL: modulation evaluation is already pure and already
produces a small final-params record per frame (the export evaluator proves
the same contract). The engine is already a class behind a singleton export,
so instantiating a second one is a seam, not a rewrite. Triggers/MIDI stay
structurally single-fire because the replica never evaluates anything.

---

## 4. Authoritative state (v0.3)

| Category | Contents                                                                               | Owner                                                         | Output window sees                                        |
| -------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| PROJECT  | sources, technique, material, base params, mappings, looks                             | editor `projectStore`                                         | `RenderSnapshot` on change (low rate)                     |
| RUNTIME  | time, playing, morph, scheduler, freeze, macros, candidate overlay, live-source status | editor singletons                                             | `FrameState` (high rate) + `ClockSync` + transport events |
| UI       | workspace, panels, dialogs                                                             | editor `uiStore`                                              | never                                                     |
| OUTPUT   | selected display, fullscreen, enabled, window status                                   | main process (window mgmt) + editor `outputStore` (UI mirror) | is the subject                                            |

No Zustand store is replicated across processes. The output renderer keeps
plain module state fed by its MessagePort.

## 5. Clock

`PlaybackController` (editor) stays the one clock — it must, because audio
is the master and `AudioContext` lives there. The output window slaves to it
exactly the way video already slaves to audio today:

- **ClockSync beacon** (~4 Hz + on transport events): `{compTime,
sentAtHighRes, playing, rate}` over MessagePort; the replica maintains a
  local mapping `performance.now() → compTime` and drift-corrects its media
  elements with the existing `DRIFT_CORRECT_SEC = 0.06` discipline.
- **Transport events** (play/pause/seek/loop) reset the mapping and the
  replica's temporal history — mirroring `seek()`'s existing
  `resetTemporal + resetTriggers` semantics (triggers only exist on the
  authority side).
- Different refresh rates are a non-issue by construction: each window draws
  at its own display cadence, sampling the latest FrameState; composition
  time is common. Quantized actions land identically because they are only
  ever _resolved_ on the authority and arrive pre-applied in FrameState.

## 6. High-frequency sync — FrameState

Chosen model: **evaluated frame state** (option "B/40" of the brief), not an
event stream. Event replay (Look/macro/trigger events + local recompute) was
rejected: it reintroduces evaluation in the replica and thus drift/ordering
risk — the exact thing Option C exists to avoid.

Per editor tick (throttled to ≤120 Hz, effectively the editor rAF):

```
FrameState {
  compTime: number
  finalParams: ParamRecord        // post modulation+macros+overlay (~30 numbers)
  materialState: MaterialState    // small, usually unchanged (send on change)
  overlayActive: boolean          // candidate/morph already baked into params
  signalLevels?: Float32Array(8)  // only if output-side meters ever wanted
}
```

≈1–2 KB → ≈120–240 KB/s over `MessageChannelMain`. Trivial. Project edits
ship as a separate `RenderSnapshot` (technique id, composition, source
descriptors, material asset ref) only when they change. Nothing ships giant
project JSON at frame rate.

Latency target (§43): editor action → output pixels ≤ 1 output display
frame + IPC (~sub-ms). Benchmark: timestamped FrameState vs
`requestAnimationFrame` timestamp in the replica, logged both sides against
the shared beacon mapping; measured for MIDI CC, look apply, pad, morph
tick, camera frame.

## 7. Media in the replica

| Source kind              | Replica strategy                                                                                         | Cost                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------- |
| Image                    | load its own texture via `material://`                                                                   | negligible            |
| File video               | own `<video>` slaved to ClockSync (same drift logic)                                                     | +1 hw decode session  |
| Camera / Screen / Window | own `getUserMedia`/`getDisplayMedia` with same device/source id — Chromium fans out ONE physical capture | ~0 extra capture cost |

## 8. Live source architecture

The seam already exists: `TemporalSource { currentTexture, acquireAt }` and
the engineBridge's source-loading block. v0.3 formalizes it:

```ts
type SourceKind = 'file-image' | 'file-video' | 'live-camera' | 'live-screen' | 'live-window';

interface SourceCapabilities {
  seekable: boolean;
  duration: number | null;
  deterministic: boolean; // exact frame for exact time on demand
  exportable: boolean; // offline sequence/movie export possible
  temporalHistory: 'exact' | 'realtime' | 'static';
  audio: boolean;
}

interface SourceRuntime {
  readonly id: string;
  readonly kind: SourceKind;
  readonly caps: SourceCapabilities;
  readonly status:
    | 'offline'
    | 'connecting'
    | 'live'
    | 'permission-required'
    | 'permission-denied'
    | 'device-lost'
    | 'error';
  readonly width: number | null;
  readonly height: number | null;
  texture(): THREE.Texture | null; // for engine.setSource
  temporalSource(): TemporalSource | null;
  dispose(): void;
}

interface LiveSourceRuntime extends SourceRuntime {
  connect(): Promise<void>; // permission flow lives here
  onStatus(cb: (s: SourceRuntime['status']) => void): () => void;
}
```

Existing file loading becomes `FileImageSource` / `FileVideoSource`
implementations of the same contract (mechanical extraction from
engineBridge — the behavior does not change). Capability flags replace
scattered `if (kind === ...)`: export gating, temporal mode and UI status
all read `caps`.

### Frame flow (live)

`getUserMedia`/`getDisplayMedia` → `MediaStream` → `<video autoplay muted>`
→ `THREE.VideoTexture` → engine — the identical path file video uses today,
so techniques need zero changes. `requestVideoFrameCallback` used only to
invalidate the engine on new frames (avoids re-upload when camera fps <
display fps); resolution changes rebuild the texture; `ended`/`mute` track
events map to `device-lost`.

### Temporal × live

`TemporalFrameProvider.advancePreview` already captures "whatever the source
shows now" onto the time grid — that IS live temporal. So:

- `LiveTemporalSource` implements `TemporalSource` with
  `currentTexture() = stream texture` and `acquireAt()` **throwing** — it can
  never be called, because export is disabled for live compositions (§10).
- No second provider needed. The atlas is the bounded ring the brief asks
  for: current default 56 × 256×144 RGBA = **8.1 MB**, span 2.29 s @ 1/24 s
  spacing. Full-resolution rings were computed and rejected: 1080p RGBA is
  8.3 MB/frame (1 s @ 30 fps = 249 MB, 4 s @ 60 = 2 GB; 4K ×4 that). The
  reduced-res atlas stays the design; a "live quality" config bump (e.g.
  112 slots @ 384×216 ≈ 36 MB) is the sanctioned headroom knob.

### Export semantics (live)

If the active composition source is non-deterministic (`caps.exportable ===
false`): **sequence/movie export disabled**, reason `LIVE SOURCE CANNOT BE
OFFLINE-EXPORTED`. **Still export stays allowed** — `renderStill()` honestly
captures "now". No auto-frozen frames, no fake determinism.

## 9. Output Window

```
main: outputWindow.ts
  new BrowserWindow({
    frameless, backgroundColor: '#000000', show: false,
    fullscreen on target display bounds (fullscreen, not kiosk),
    backgroundThrottling: false,
    webPreferences: { sandbox, contextIsolation, preload: output-preload }
  })
```

- Loads a minimal `output.html` entry (same Vite build, second input): no
  React, no stores — one module that instantiates `new RenderEngine()`,
  builds replica sources from `RenderSnapshot`, applies `FrameState`.
- **Preload**: MessagePort hookup + `output:status` push only. No fs, no
  dialogs, no export IPC. (§36 satisfied.)
- Cursor hidden while fullscreen; close → status `CLOSED` in editor; editor
  quit closes output; output crash (`render-process-gone`) → editor shows
  `OUTPUT ERROR`, main offers reopen. Never takes the editor down.
- **Resolution**: the composition is a live GPU scene, not a raster — the
  replica renders directly at destination pixels (device-pixel-ratio aware),
  aspect-fitting the project aspect with background letterboxing. Crisp on
  any display; project resolution remains the layout/aspect authority and
  the export raster size.
- **Display routing**: `screen.getAllDisplays()` (id, bounds, scaleFactor);
  on `display-removed` of the target: **close output, editor shows
  `DISPLAY LOST`** — never auto-migrate a fullscreen surface to the primary
  display mid-show (chosen for projector safety).
- **Persistence**: display preference + fullscreen preference persist;
  _active output state does not_ — opening a project never seizes a
  projector. Preferences live in the project only if genuinely useful,
  otherwise app-local; decided at 18C (leaning app-local, keeping schema
  pressure zero).

## 10. Liveness (App Nap) rule change

Today: blocker held iff transport playing. v0.3 case that breaks it: camera
live + transport paused (+ output fullscreen) — rAF must not die.

New rule, implemented as a **refcounted reason set** in main
(`power:liveness {reason, active}`):

```
runtimeIsLive = transportPlaying ∨ liveSourceActive ∨ outputWindowOpen
```

Idle project with no live source and no output window releases the blocker
exactly as today. docs/BACKGROUND_RENDERING.md gains the new matrix
(editor hidden × output fullscreen × camera active…) at 18G, re-measured.

## 11. Permissions (macOS)

Current handler denies everything except MIDI — **must change** for v0.3,
gated, not opened:

- Main keeps deny-by-default; renderer arms a capture intent first
  (`capture:arm {kind}`), then the permission handler allows exactly one
  matching `media`/display request; disarm after resolution.
- **Camera**: request on first CAMERA selection, never at launch. States:
  granted → `LIVE`; denied → `PERMISSION DENIED` with "open System
  Settings" hint; device unplugged → `DEVICE LOST`. Packaged app needs
  `NSCameraUsageDescription` + hardened-runtime entitlement
  `com.apple.security.device.camera` (electron-builder config) — dev
  behavior is NOT representative, packaged QA mandatory (18G).
- **Screen/Window**: Electron 44 path is
  `session.setDisplayMediaRequestHandler` + `desktopCapturer.getSources`
  (main-side, validated thumbnails/names to the picker) feeding renderer
  `getDisplayMedia`. macOS Screen Recording TCC prompt appears on first
  real capture; denial → `PERMISSION DENIED` + Settings hint; grant
  requires app restart on macOS — the status copy must say so honestly.
- Serialization: never the stream. Camera persists `{kind, preferredDeviceId?,
label?, constraints, mirror}`; screen/window persist `{kind, displayHint /
windowTitleHint}`. On reopen every live source is `OFFLINE` until the user
  reconnects — ambiguous device identity never auto-picks.

## 12. Future Syphon (secondary factor only)

Syphon needs native GPU surface publishing; no Electron/WebGL path exists.
Chosen architecture helps indirectly: a dedicated output window is a single
clean surface a future native layer (or window-server capture) can target.
Nothing else is done for it in v0.3.

## 13. The `texImage3D FLIP_Y` warning — root cause

Audited. It originates in **Three.js internals** (`three.module.js`
WebGLState default-texture creation): Three allocates 1×1 placeholder
textures for `TEXTURE_3D`/`TEXTURE_2D_ARRAY` via `texImage3D` while the
`UNPACK_FLIP_Y_WEBGL` pixel-store flag is still set from a preceding flipped
2D upload (image/video textures default `flipY: true`). WebGL2 forbids
FLIP_Y on 3D uploads → Chromium logs `INVALID_OPERATION` per occurrence.

- MATERIAL's own temporal path is **not involved** — the provider is a 2D
  atlas render target with GPU blits; no `texImage3D` of frame data ever.
- **Verdict: harmless to correctness** (only placeholder defaults are
  affected), but it is per-frame console spam with a small validation cost.
- **Not a v0.3 blocker**: a second RenderEngine has its own context/state;
  live temporal continues on the 2D atlas.
- Recommendation: track upstream Three fix; re-check on the next Three
  upgrade; do not patch around it in MATERIAL code.

## 14. IPC additions (all validated, no generic channels)

| Channel                              | Direction | Payload                                                   |
| ------------------------------------ | --------- | --------------------------------------------------------- |
| `output:open`                        | R→M       | `{displayId?, fullscreen}`                                |
| `output:close`                       | R→M       | —                                                         |
| `output:set-display`                 | R→M       | `{displayId}`                                             |
| `output:status`                      | M→R       | `{state: closed/open/live/fullscreen/display-lost/error}` |
| `displays:list` / `displays:changed` | R→M / M→R | display descriptors                                       |
| `capture:arm`                        | R→M       | `{kind: camera/display}`                                  |
| `capture:sources`                    | R→M       | screen/window list via desktopCapturer                    |
| `power:liveness`                     | R→M       | `{reason, active}` (supersedes power:live-engine)         |
| MessageChannelMain                   | M brokers | editor⇄output port pair for Snapshot/FrameState/ClockSync |

## 15. Project schema

**v3 required** (live sources + their config are project state). Additive:
`sourceRefSchema` grows a discriminated live variant; optional
`outputPrefs` only if 18C decides project-level persistence. Migration
v2→v3 = defaults only; v1/v2 open unchanged; tests extend the existing
migration suite. No bump lands before 18D (first phase that serializes
anything new).

## 16. File map

```
NEW      src/sources/SourceRuntime.ts        contract + capability model
NEW      src/sources/FileImageSource.ts      extracted from engineBridge
NEW      src/sources/FileVideoSource.ts      extracted from engineBridge
NEW      src/sources/CameraSource.ts
NEW      src/sources/ScreenSource.ts
NEW      src/rendering/temporal/LiveTemporalSource.ts
NEW      src/runtime/RuntimeBus.ts           FrameState/Snapshot/ClockSync emitter
NEW      src/output-window/main.ts           replica entry (no React)
NEW      src/output-window/ReplicaRenderer.ts
NEW      electron/main/outputWindow.ts
NEW      electron/main/capture.ts
NEW      electron/preload/output.ts
MODIFY   src/rendering/engineBridge.ts       consume SourceRuntime (extraction)
MODIFY   src/state/ + src/output/            output status store + UI wiring
MODIFY   electron/ipc/handlers.ts            new channels, liveness refcount
MODIFY   shared/ipc.ts, shared/schemas/project.ts (v3, 18D)
PROTECTED src/export/**, src/modulation/**, src/signals/**, src/midi/**,
          src/performance/*Runtime*, TemporalFrameProvider capture logic,
          PlaybackController clock semantics
```

## 17. Risk map

| Change                                           | Risk        | Why                                                           |
| ------------------------------------------------ | ----------- | ------------------------------------------------------------- |
| Cross-window clock + FrameState sync             | HIGH        | the product IS sync; drift or stalls are show-breaking        |
| RenderEngine second instance + replica lifecycle | HIGH        | GL context loss, resize, media rebuild paths all double       |
| Liveness rule rework                             | MEDIUM-HIGH | regressions here are invisible until a show (App Nap history) |
| engineBridge → SourceRuntime extraction          | MEDIUM      | touches the load path of every existing project               |
| Camera source                                    | MEDIUM      | permissions + device churn, but isolated behind contract      |
| Screen/Window source                             | MEDIUM      | TCC restart quirk, ephemeral ids                              |
| Schema v3 migration                              | MEDIUM      | mechanical but sacred                                         |
| Export gating by capability                      | LOW         | additive UI + one guard                                       |
| Output workspace wiring, status UI               | LOW         | UI v2 seams already exist                                     |

## 18. Implementation phases (each with a STOP gate)

- **18A — Seams, no features.** ✅ DONE. SourceRuntime extracted for file
  sources (behavior-identical); RuntimeBus emits FrameState locally with
  `techniqueId` as EXPLICIT render state and `temporalActive` riding every
  frame (the export-hotfix invariant, now a runtime contract: active renderer
  technique === frame state technique — a replica synchronizes renderer +
  temporal capability from FrameState, never from previously mounted state);
  liveness is a refcounted reason set (`transport | live-source |
output-window`) behind validated IPC; engine gained context-loss handlers
  and a multi-instance audit with A→B→A renderer lifecycle tests. Export
  isolation preserved by construction: renderStill/export never reach the
  bus. 410 tests green, zero visible change, FrameState observable via
  `__dev.runtimeBus`.
- **18B — Output Window spike.** Second window renders the same _static
  Mosaic file composition_ from Snapshot+FrameState (no playback, no MIDI,
  no temporal). Then add playback + ClockSync. Accept: param edit visible in
  output ≤1 output frame + IPC; A/B screenshot of both windows byte-similar
  (tolerance: decode nondeterminism only); kill output → editor unaffected.
- **18C — Display routing + fullscreen.** Display picker, fullscreen,
  disconnect → DISPLAY LOST close, status states, persistence decision.
  Accept: disconnect/reconnect matrix clean, no auto-fullscreen on open.
- **18D — Camera.** SourceRuntime, permission flow, status vocabulary,
  schema v3 + migration + tests, mirror, BUILD source UI row, export
  gating live. Accept: connect/disconnect/deny/revoke matrix, still export
  works, sequence export blocked with reason.
- **18E — Screen/Window.** setDisplayMediaRequestHandler picker, TCC copy,
  ephemeral-id honesty on reopen. Accept: same matrix as camera + window
  close mid-capture.
- **18F — Live temporal.** LiveTemporalSource, ring/atlas config knob,
  guard acquireAt, Video-Tile-on-camera QA. Accept: temporal techniques run
  on live input at 60fps+, memory within budget, export still gated.
- **18G — Integration/QA/v0.3.** Packaged permissions (Info.plist,
  entitlements, signed build), App Nap matrix re-measured, benchmark table
  (editor±output±camera±screen±temporal: fps/frame time/CPU/heap/decode
  count/latency), soak, docs (LIVE_SOURCES, OUTPUT_WINDOW, PERMISSIONS,
  BACKGROUND_RENDERING, PROJECT_FORMAT, ROADMAP), release.

Rule kept from the brief: no phase combines a new window, a new source kind
and a temporal change. 18B proves the architecture with the smallest
possible surface before any live source exists.

## 19. Sync test plan (18B onward)

Editor vs Output, at 60 Hz and 120/60 mixed, across seek/pause/play and
quantized boundaries: same look, params (exact — FrameState is the single
evaluation), frame time (≤1 output frame skew), morph progress, beat index,
macro values, freeze state, trigger results (structural: authority-only).
Tolerances: params exact; compTime skew ≤ 16.7 ms at 60 Hz output; pixel
diff bounded by decode nondeterminism on video sources, exact on static.

## 20. Open questions (carried into phases, not blockers)

1. Output prefs in project vs app-local (18C decision, leaning app-local).
2. Whether signalLevels belong in FrameState at all (only if output-side
   meters ever exist — default no).
3. Camera audio (mic) — explicitly out of v0.3; revisit with recording.
4. Three upgrade cadence for the FLIP_Y warning.

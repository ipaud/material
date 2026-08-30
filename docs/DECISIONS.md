# Decisions

Meaningful deviations and choices not obvious from the spec.

## Tooling

- **TypeScript 5.9, not 7.x**: TS 7 (native compiler preview) is too new for the
  toolchain (typescript-eslint peer range caps below 6.1). Revisit later.
- **Vite 7, not 8**: electron-vite 5 supports vite ^5–^7. plugin-react pinned to
  5.x accordingly.
- **Preload built as CJS** (`index.cjs`): sandboxed preload scripts cannot be ESM.

## Media pipeline

- **material:// protocol** with `corsEnabled + supportFetchAPI + stream`
  privileges and `Access-Control-Allow-Origin` on responses: WebGL textures need
  CORS-clean media, and the renderer origin (dev server / file) is cross-origin
  to the custom scheme. Serving is gated by an approval registry — only paths
  imported through dialogs/probe or referenced by an opened project are served.
- **SVG safety is two layers**: allowlist-style strip pass in the main process
  (scripts, event handlers, foreignObject, external/javascript refs) plus
  rasterization through SVG-as-`<img>`, where Chromium already disables
  scripting and external loads.
- **Custom material textures** are contain-fit rasterized into a 512² square
  atlas; texture materials use a square element footprint in the grid (SDF
  shapes fill the cell rect instead).
- **Proxy system deferred** (Phase 3 spec item): Apple Silicon decodes 1080p
  H.264 preview effortlessly; proxies become worthwhile with 4K+ sources.
  Architecture keeps preview and final-render sampling separate, so proxies
  slot into the bridge later without renderer changes. The temporal cache is
  already proxy-resolution (256x144 slots), so frame history never scales with
  source resolution.
- **material:// serves byte ranges itself** (Phase 8): wrapping the file
  response to add CORS headers silently stripped range support, so `<video>`
  reported `seekable = [0, 0]` and refused to seek at all. The handler now
  answers `Range` requests with 206 + `Content-Range` and advertises
  `Accept-Ranges`. Frame-exact temporal decoding depends on this.
- **backgroundThrottling: false** (Phase 8): Chromium throttles rAF to a near
  halt when the window is occluded, which stalls preview rendering. A visual
  instrument must keep running on a second display, behind another window, or
  while exporting.

## Rendering

- **Perspective camera always** (fov derived from a 0–1 "Perspective" param,
  distance always frames the composition at z=0). Depth params get true
  parallax without a separate ortho/perspective mode switch.
- **One InstancedBufferGeometry + gl_InstanceID**: grid layout, sampling, and
  luminance mapping all computed in the vertex shader from uniforms; zero
  per-instance attribute uploads. Three's viewport APIs take CSS units
  (pixelRatio applied internally) — offscreen renders temporarily force
  pixelRatio 1.
- **Video clock**: the `<video>` element is the authoritative clock while video
  is the only timed medium. Phase 4 will hand mastership to the audio clock and
  slave video to it (per spec §63).

## Product

- Dev-only `window.__dev` handle + CDP remote-debugging port 9223 power the
  scripted QA harness (drive.mjs); disabled in packaged builds.

## MIDI (Phase 14)

- **Web MIDI over a native module**: works in this Electron/Chromium, no
  node-gyp dependency, hot-plug via `statechange`. A `MidiTransport` seam
  keeps the engine testable (FakeMidiTransport) and leaves room for a native
  backend if Web MIDI ever falls short.
- **Chromium ≥ M119 gates ALL Web MIDI behind the `midiSysex` permission**,
  even `sysex: false` requests. The main process grants `midi`+`midiSysex`
  at the permission-handler level; the renderer only ever requests
  `sysex: false`, so `access.sysexEnabled` stays false (QA-verified). No
  sysex data flows; every other permission stays denied.
- **ABSOLUTE + PICKUP first**: a knob IS its parameter (with soft takeover),
  because direct manual control is what makes the instrument feel like
  hardware. `mode: 'modulate'` is reserved in the schema for a future
  Signal-system contribution mode.
- **Frozen targets block MIDI**: freeze holds the modulation contribution,
  and the base is locked against the controller too — a frozen look must
  survive a live performer's hands. Unfreeze is explicit.
- **Export ignores live MIDI at the engine entrance** (not merely at the
  evaluator): mid-export document writes rebuild instanced geometry from
  live params, which no per-frame uniform override can mask. Verified
  byte-identical exports under a continuous CC/note stream.
- **Device rebinding**: exact platform id, else UNIQUE manufacturer·name
  match; ambiguity never auto-binds. Mappings persist offline.

## Release polish (Phase 17)

- **Liveness follows the transport, not the window.** macOS App Nap throttles
  a hidden, idle app's `requestAnimationFrame` to ~1 Hz — below Chromium, so
  `backgroundThrottling: false` does not reach it, and once engaged, starting
  playback does not recover. MATERIAL holds a `prevent-app-suspension` blocker
  for exactly as long as the transport runs. A paused editor still naps, which
  is correct: nothing is playing. See BACKGROUND_RENDERING.md.
- **Two waits per exported video frame.** `seeked` says the seek finished, not
  that a decoded frame has been presented. Rendering on `seeked` alone made
  ~20% of frames in a non-temporal export differ between two runs of the same
  project — whole different images, not codec noise. Export now also awaits
  `requestVideoFrameCallback`. This is why the temporal path was already
  stable: it primes from exact timestamps instead.
- **Export blocks shared-state mutations rather than duplicating the
  renderer.** Parameters are already snapshot-isolated, but the video position
  and the technique/material renderers are shared hardware state that a live
  Look switch or seek moves mid-render. Blocking those few actions during an
  export is smaller and more honest than maintaining a second render path.
- **Corrupt autosaves are moved aside, never deleted.** A truncated recovery
  file is exactly what a kill mid-write produces, which is precisely when the
  user's work is at stake. Unparseable files are renamed `.corrupt` so they
  leave the scan path without leaving the disk.
- **Recovery ids are validated for path safety, not as UUIDs.** A strict
  `uuid()` check on discard meant any entry the listing produced with a
  different id shape could be shown but never dismissed — an undismissable
  prompt. The real requirement is no separators and no traversal.
- **MIDI gestures ask the store, not a local flag.** The engine used to track
  "a transient is open" itself, which went stale the moment a project loaded
  mid-gesture: the store cleared its transient, the flag did not, and every
  later CC message became its own undo entry. `beginTransient()` is idempotent,
  so asking every message keeps the two in step.
- **Mutation sparsity over magnitude.** Moving every eligible parameter is not
  a variation, it is a new random state, and small changes compound into
  near-black frames. A per-intensity mutation rate plus a declarative
  `explore.coverage` correlation constraint took broken candidates from
  frequent to none across 60 samples on the six official Looks.
- **Thumbnails tell the truth.** They capture the frame under the playhead. If
  that frame is nearly black, MATERIAL says so and offers a re-thumbnail — it
  does not move the playhead or alter visual state to get a prettier picture.
- **4K needs no proxies.** Measured 117–120 fps at 3840×2160 across Mosaic,
  Echo Chamber and Time Fracture, with one-frame macro response. Proxy media
  would be complexity bought with no evidence.

## v0.3 LIVE / OUTPUT (architecture audit — decided before implementation)

Full audit and rationale: [LIVE_OUTPUT_ARCHITECTURE.md](LIVE_OUTPUT_ARCHITECTURE.md).

- **ADR — Output renderer ownership**: one authority, replicated surfaces.
  The editor renderer keeps every runtime singleton (clock, scheduler, MIDI,
  modulation, overlays); the Output Window runs a second `RenderEngine`
  instance that renders received, already-evaluated frame state and performs
  no evaluation. Two independent runtimes (double-fire risk) and frame
  transport (no viable cross-process pixel path in Electron) were rejected.
- **ADR — Authoritative clock**: `PlaybackController` stays the only clock
  (audio-master). Output slaves via ClockSync beacons + transport events,
  reusing the existing 0.06 s drift-correction discipline.
- **ADR — High-frequency sync**: compact evaluated FrameState over
  `MessageChannelMain` (~1–2 KB ≤120 Hz), not an event-replay stream —
  replays would reintroduce evaluation (and drift) in the replica.
- **ADR — Live source abstraction**: `SourceRuntime` + `SourceCapabilities`
  (seekable/deterministic/exportable/temporalHistory) behind the existing
  `TemporalSource` seam; file loading extracted from engineBridge into the
  same contract, behavior-identical.
- **ADR — Live export semantics**: compositions on a non-exportable source
  disable sequence/movie export with an explicit reason; still export stays
  allowed as an honest capture of "now". No frozen-frame fakery.
- **ADR — Output persistence**: display/fullscreen _preferences_ may
  persist; _active output state never does_ — opening a project must not
  seize a projector.
- **ADR — macOS liveness**: `prevent-app-suspension` becomes a refcounted
  reason set — `transportPlaying ∨ liveSourceActive ∨ outputWindowOpen` —
  replacing the transport-only boolean.
- **ADR — texImage3D FLIP_Y warning**: root-caused to Three.js placeholder
  textures (`TEXTURE_3D/2D_ARRAY` defaults created while `UNPACK_FLIP_Y`
  persists from flipped 2D uploads). Harmless to output; not a v0.3
  blocker; track upstream, no local workaround.
- **ADR — Pattern sources are project-global**: `patternSources[]` lives on
  the project; `LookCore` captures MAPPINGS only, never pattern definitions.
  A look can reference `pattern:<id>` with its own target/amount/curve, but
  applying or morphing a look never clones, edits or interpolates the
  pattern itself. Rationale: a pattern is a signal resource (like the audio
  analyser), not look state; interpolating `E(5,16) → E(7,12)` has no
  defined meaning in `interpolateLookCore`; and keeping the definition
  global keeps `patternId` — and therefore the deterministic probability
  lane — stable across look applies. Consequences: one `E(5,16)` can drive
  Scale in look A and Feedback in look B while both see the same signal;
  editing the pattern changes every mapping that references it (shared
  resource semantics, no silent per-look fork); pattern morph semantics stay
  undefined until there is a reason to define them.
- **ADR — Pattern persistence without a schema bump**: patterns ship as an
  additive defaulted v2 field, following the `macros` / `performancePads`
  precedent, so v1 and pre-pattern v2 projects keep opening unchanged and
  the next real format break (Live Sources) can own v3 alone. Pattern ids
  and the deterministic hash are treated as project-compatibility
  semantics: duplicates are refused rather than renamed, and the persisted
  golden fixture (`tests/fixtures/project-v2-pattern.json`) locks the
  evaluated result so a future PRNG/clock/transform change cannot silently
  alter saved compositions.
- **ADR — Display fullscreen strategy (18C)**: presentation fullscreen is a
  BORDERLESS window driven by `setSimpleFullScreen(true)` plus
  `setAlwaysOnTop(true, 'screen-saver')`, never macOS native
  `setFullScreen(true)`. Native fullscreen puts the output in its own Space:
  it animates on entry, animates again when the target display changes, and
  drags the performer's Space around mid-set. The borderless path appears
  immediately and moves between monitors without a Space transition.
  Measured on macOS 15 (1512×982 @2× panel): `setSimpleFullScreen` alone
  stops at the work area (1512×949, menu bar still visible); adding the
  screen-saver window level is what actually fills the panel — 1512×982 at
  y=0, canvas backing 3024×1964. Consequence: a fullscreen output covers
  everything, so it needs a guaranteed way out — Escape on the output
  window, ⌘⇧F in the editor (which keeps keyboard focus), or the DISPLAY
  panel. simpleFullScreen only takes effect on a VISIBLE window, so it is
  applied in `ready-to-show`, after the window has been positioned on the
  target display (which is what prevents a flash on the primary monitor).
- **ADR — Display disconnect policy (18C)**: if the display an output is
  presenting on disappears, MATERIAL CLOSES the output and reports
  `DISPLAY DISCONNECTED`. The alternative — moving it to the primary
  display — would slam a fullscreen composition over the performer's editor
  at the worst possible moment. Reopening is one click and the choice of
  where stays with the performer. A display whose geometry merely changes
  (resolution, scaling, rotation, rearrangement) is re-applied in place
  instead.
- **ADR — Display selection is machine state**: the chosen display and mode
  persist in `userData/settings.json`, never in the project. Monitor
  topology belongs to a setup, not to a composition, and a project moved
  between machines must not carry a display id. Deliberately absent from
  that file: whether the output was open — restoring that would make
  MATERIAL seize a projector on launch.

## Camera source (Phase 18D)

- **ADR — Output camera fan-out = same-device dual acquisition**: the Output
  replica opens its OWN `getUserMedia` on the SAME deviceId instead of
  receiving the editor's stream. Measured on hardware before deciding
  (spike, 18D §50): transferring a `MediaStream`/`MediaStreamTrack` over the
  MessagePort broker throws `DataCloneError` (not transferable across
  renderers — impossible, not just undesirable); a second same-device
  acquisition joins Chromium's shared capture service in ~21 ms (editor cold
  start was ~844 ms) with both sides at 30 fps and one physical capture —
  the OS indicator does not double. Rejected: stream transfer (measured
  impossible), pixel transport over IPC (prohibited by the replica
  architecture), editor-canvas `captureStream` (prohibited — the Output
  must render, not replay compressed pixels).
- **ADR — Intent-gated camera permission**: the main process answers
  Chromium `media` permission checks with a deny-by-default gate that is
  armed only between an explicit START CAMERA action and the matching
  stop/teardown (`camera:intent` IPC). Requests that include audio are
  always denied — MATERIAL never captures microphone. Consequences: a saved
  project with a camera source can be opened, browsed and edited forever
  without a permission prompt; the macOS TCC dialog appears the first time
  the user presses START and never at launch. The replica's join inherits
  the same gate: with intent disarmed its `getUserMedia` fails, so the
  Output can never initiate acquisition on its own (verified by test and by
  the packaged-app QA pass).
- **ADR — Replica mirrors acquisition, not selection**: the RuntimeInputs
  source descriptor says `live-camera` only while the editor capture is
  actually LIVE. STOP on the editor therefore releases the replica's join
  too (its tracks stop, the OS indicator goes off), even though the project
  still selects the camera source. The alternative — deriving the
  descriptor from the project — left the Output holding the sensor after
  the editor stopped, which contradicts "the editor is the sole realtime
  authority".
- **Live sources render continuously**: `RenderEngine` is
  invalidation-driven, which starves a sensor that produces new pixels
  outside the app's own state changes. While a camera is live the loop
  bypasses the dirty check (`setLiveSourceActive`), and stops doing so the
  moment the capture ends — file projects keep the lazy render model
  untouched.
- **Camera capabilities are honest**: `seekable:false, deterministic:false,
  exportable:false, temporalHistory:'realtime'`. Sequence/movie export is
  disabled for a live source (a still capture of "now" stays available);
  temporal techniques show a plain limitation note (realtime history
  accumulation is 18F). The transport never pauses, seeks or rate-controls
  the sensor.
- **Packaged manifest is honest**: `NSCameraUsageDescription` is declared;
  the default `NSMicrophoneUsageDescription` electron-builder injects is
  stripped in `scripts/after-pack.mjs` because MATERIAL never requests
  audio capture and the gate denies it unconditionally.

## Screen / Window capture (Phase 18E)

- **ADR — Display capture API**: `session.setDisplayMediaRequestHandler` +
  `desktopCapturer` in the MAIN process, no picker UI anywhere. Options
  measured on Electron 44 / macOS Tahoe: (A) bare `getDisplayMedia` — dead
  end, Electron denies without a handler; (B) exposing
  `desktopCapturer.getSources` to the renderer — rejected, generic desktop
  capture IPC violates the narrow-surface rule; (C) the chosen handler —
  the editor pre-arms an exact target (START), main resolves it via
  `getSources` and grants programmatically: no picker, 230 ms acquisition,
  and crucially the OUTPUT replica can be granted the same source with zero
  user interaction, which the mandatory no-second-picker rule (§37)
  requires; (D) `useSystemPicker` — rejected: experimental, and the system
  picker would demand a user choice per request, making silent Output
  rejoin impossible. Measured behavior: getDisplayMedia consults the
  generic `media` permission (empty mediaTypes) plus the handler — both are
  gated on armed intent; no transient-activation requirement when a handler
  grants; a video+audio request is granted VIDEO ONLY (0 audio tracks).
- **ADR — Window identity is ephemeral**: OS window capture ids
  (`window:NNN:0`) die with the window and do not survive restarts. The
  project persists only a human `titleHint`; the ephemeral id lives in the
  capture manager for the current selection round. Reopening a project
  always requires an explicit CHOOSE WINDOW + START — a reused id silently
  capturing a *different* window would be a privacy failure, so best-effort
  reconnection by fuzzy title match is deliberately NOT implemented.
- **ADR — Output rejoin authorization**: when the editor's capture request
  is granted, main records `grantedCapture` (kind + source id). An Output
  getDisplayMedia (recognized by frame identity, `isOutputFrame`) is granted
  exactly that source — never a choice. STOP, source switch, project switch
  and failed starts all clear both the intent and the grant, so a stale
  handle cannot reacquire later (measured: raw Output getDisplayMedia with
  no live editor capture → NotAllowedError).
- **Screen capture is Retina-physical**: the built-in 1512×982@2× display
  captures as 3024×1964@30fps — capture pixels are physical, not DIPs.
  Cursor is captured (platform default, `cursor: always`); no cursor toggle
  in 18E. Window capture dimensions are the window's physical pixels and
  follow resizes live (the runtime reads the video element per frame).
- **macOS TCC (measured in the packaged app)**: the Screen Recording prompt
  fires on the FIRST capture attempt (START) — never on launch, project
  open, or source selection. macOS Tahoe shows no direct "Allow": the
  dialog offers only "Open System Settings" / "Deny", the app then appears
  under Privacy & Security → Screen & System Audio Recording, and flipping
  the toggle requires the user's Touch ID/password (not automatable — by
  OS design). The OS dialog's fixed wording mentions "screen and audio"
  even though MATERIAL requests video only and the gate strips audio
  unconditionally. A TCC-denied capture surfaces as
  OverconstrainedError/"Invalid capture constraints" (not
  NotAllowedError) — mapped to SCREEN RECORDING ACCESS REQUIRED in the UI.
- **Recursive capture is allowed**: capturing the display or window where
  MATERIAL itself renders produces a feedback tunnel — creatively valid,
  not blocked (measured stable at 120 fps render / 30 fps capture).
- **Capture display ≠ Output display**: the screen source's `displayId`
  (Electron display id — equals the macOS CGDirectDisplayID that
  desktopCapturer reports) is project config for the INPUT; the Output
  target display stays machine state in settings.json. Capturing the
  built-in display while outputting to a projector is a first-class setup.

## Live temporal history (Phase 18F)

- **ADR — one atlas, two clocks**: live sources reuse the EXISTING temporal
  atlas (56 slots × 256×144, ~7.9 MB RGBA8 per renderer) — no second history
  subsystem. The only structural change: while a live source is active the
  grid advances on a MONOTONIC WALL CLOCK instead of composition time. The
  shared sampling shader already addresses "offsetSeconds behind the newest
  frame", which is exactly realtime semantics — so every temporal technique
  worked unchanged. Measured: transport paused → history keeps filling;
  advance rate 24.0/s (grid rate) at 120 fps render with a 30 fps camera —
  source-paced, never render-paced, no 4× duplication.
- **Seek/loop never rewind reality**: `resetTemporal()` is now a
  COMPOSITION-semantics reset and no-ops in live mode (a timeline seek
  measured 56/56 slots surviving). Live-history boundaries reset through
  the `setLiveSourceActive` flip instead — START, STOP, device switch,
  target switch and project switch all funnel through manager teardown, so
  one line covers the whole reset matrix (measured: stop → 0, restart →
  fresh warmup, no stale frames).
- **Technique switch resets history** (existing lifecycle, kept): entering
  a temporal technique allocates the provider and warms from now; leaving
  disposes it (VRAM released); temporal→temporal re-primes. Consistent
  with file sources; no cross-technique persistence invented.
- **Freeze freezes output, not observation**: measured 24 slots/s still
  advancing behind FREEZE ALL; release sees current live history.
- **VRAM is bounded by design**: slots are fixed 256×144 — a Retina
  3024×1964 screen (or theoretical 4K) is downsampled at blit time, so the
  atlas stays ~7.9 MB per renderer regardless of source resolution;
  editor+Output ≈ 16 MB total. Live window resize (measured 2116×1328 →
  1400×1000 mid-capture) needs no reallocation. Current frame renders at
  full resolution; only history layers are low-res — deliberate
  quality/stability tradeoff.
- **Output keeps its own history**: the replica acquires its own live
  surface (18D/18E), so it builds its own wall-clock atlas locally. No
  history pixels cross processes; param parity stays exact; opening the
  Output mid-session warms up locally (measured full in ≈2.3 s — the atlas
  span). Brief visual divergence during warmup is correct behavior, not a
  parity bug.
- **rVFC is diagnostics only**: requestVideoFrameCallback counts source
  frames (measured 30/s camera) for QA/devtools; it never gates history
  advancement — a static captured window legitimately repeats its frame in
  history, because real time passed.

## Release 0.3.0 (Phase 18G)

- **Ad-hoc signing breaks TCC continuity (measured)**: macOS binds the
  Screen Recording grant to the app's code-signing identity; an ad-hoc
  signature is a per-build hash, so every rebuild invalidates the user's
  toggle (verified in the packaged 18G QA — grant on the previous build,
  relaunch of the new build still denied). Accepted for INTERNAL releases
  and documented in the release notes; a Developer ID certificate is the
  fix when distribution matters. Camera TCC survived the same rebuild —
  camera grants key differently in practice.
- **Packaged 18F/18G validation**: Camera + Slit Scan + fullscreen Display
  verified end-to-end in the packaged 0.3.0 app (104 fps replica, 16 ms
  FrameState latency, temporal bands visible, clean teardown, camera
  indicator off). Screen/Window packaged paths verified up to the honest
  SCREEN RECORDING ACCESS REQUIRED state with System Settings guidance;
  going live is OS-blocked by the ad-hoc/TCC identity issue above (owner
  decision: documented, not worked around). Their full live flows are
  validated in dev builds, which share the same code paths.

## Feedback primitive (CE1B)

- **ADR — GPU ping-pong, not the temporal atlas**: feedback is previous
  RENDERED state re-entering the pipeline; the atlas stores SOURCE history.
  One `FeedbackSurface` (two RGBA8 SRGB targets at composition resolution,
  ~16.6MB/pair @1080p; same color space as the whole pipeline so a neutral
  loop cannot wash out) + one shared step shader; all seven techniques are
  uniforms/defines over it. Read and write are structurally distinct.
- **ADR — the feedback clock (the CE1B decision)**: state advances at a
  fixed 60 steps/s. PREVIEW accumulates against WALL time — a 120Hz editor
  and a 60Hz Output evolve at the same rate (measured: 60±2 steps/s at
  both simulated rates); paused transport, static images and live sources
  all keep evolving (feedback is a visual process, §20/24); interactive
  catch-up capped at 4 steps/frame. EXPORT steps purely on COMPOSITION
  time from the timeline origin: frame 0 prerolls 0→start, then exact
  whole steps per frame. Measured: two identical exports hash identically,
  and a full-range export matches a subrange export frame-for-frame
  (12/12 byte-identical) — arbitrary-range determinism proven, not
  claimed. Preview and export are therefore different clocks by design;
  preview never pretends to be the export.
- **Reset matrix**: source identity change (engine.setSource), project
  switch (source null), technique switch (renderer dispose), context
  restore, incompatible resize, export begin. NOT reset: parameter
  changes, Pattern/MIDI/macros, seeks and loops in preview (wall clock
  makes them meaningless to state).
- **Candidate isolation**: one shared surface (only one branch renders —
  no double cost); ending an audition re-primes so CURRENT keeps no
  candidate residue; APPLY keeps the auditioned state (seamless).
- **Freeze**: consistent with 18F — output freezes, the process keeps
  stepping behind it.
- **Measured trap**: `renderer.setPixelRatio()` before offscreen passes
  forces an internal canvas resize; five calls/frame produced 77ms frames.
  Render-target viewports in Three take raw pixels — no ratio needed.
  Bloom went 13fps → 120fps on removing it.

## Field primitive (CE1C)

- **ADR — FIELD is a contract, not a texture**: `field(uv) → 0..1`
  implemented as one inline GLSL function (`evaluateField`) plus a
  TS mirror locked by sample-point tests. Mathematical fields (horizontal,
  vertical, radial, spiral, noise) cost nothing; image-derived fields
  (luminance, edges) sample the already-bound source in the same pass.
  Zero extra passes, zero persistent VRAM, no FieldTextureManager. A
  future motion field (CE1D) enters as one more kind whose value reads a
  flow texture — the contract is unchanged.
- **Time Field**: `offsetSeconds = field(uv) * depth + offset` into the
  EXISTING temporal atlas — the generalized slit scan, one pass, all 7
  modes measured at 120fps. Depth/Offset are bounded to the real atlas
  span (2.29s, §29); history is present→past only — no future sampling,
  so file and live sources share semantics (§21-22). `Direction` was
  rejected as a parameter: it duplicates Invert.
- **Determinism**: noise phase = composition time × speed (never wall
  clock); paused transport freezes the noise field (parameters remain
  authority-driven even over live pixels, §13). Vertical is defined in
  USER space (top→0) over Three's v-up UVs; radial/spiral are
  aspect-correct (equal pixel distance → equal value, test-locked).
- **Export honesty**: repeat exports hash identically. Full-vs-subrange
  BYTE equality does not hold for file-video temporal techniques — H.264
  decode after different seek paths is not bit-stable. Measured on both
  Time Field AND Slit Scan (0/12 each): pre-existing pipeline behavior,
  not a CE1C regression; the temporal sampling SCHEDULE is exact in both
  paths. Feedback (CE1B) keeps its byte-exact guarantee because its state
  never decodes video.
- Param-group fix (§45): centerX/Y now STRUCTURE; feedback vocabulary
  (persistence/injection/mix/drift/segments) mapped by meaning. Known
  cosmetic leftover: `depth` shares the legacy STRUCTURE mapping with
  mosaic's pixel-depth.

## Optical flow (CE1D — forensic note, phase NOT accepted)

**Status: primitive proven on GPU consumers; Motion Pack gated
experimental (unregistered); acceptance gates NOT closed. CE1D-2 required.**

What is proven and shipped (compiled, unit-covered, not user-visible):
- `OpticalFlowField`: dense single-scale Lucas–Kanade over blurred packed
  luminance (R=current, G=previous in ONE texture), 3 small passes at
  ≤320-long-side, RGBA32F flow targets, shared-service architecture (one
  instance per renderer, demand-driven, frame-identity cache).
- rVFC source-frame gating in the engine: a 30fps source produced ~27
  flow updates/s under the 120Hz loop (measured) — the §83 hard gate.
- LIVE PROOF: camera + hue debug view showed 49k coherent moving pixels
  at source cadence — the algorithm, service, cache and consumer binding
  all work end-to-end on a real live source.
- Real bug found and fixed on the way: Tikhonov regularization must be
  applied to the NORMAL-EQUATION DIAGONAL; regularizing the determinant
  collapses pure-aperture edges (a vertical edge has a22=0 → Cramer gives
  vx = −a22·b1/det = 0 exactly). A flat moving square is ALL aperture
  cases — the canonical fixture is adversarial for single-scale LK.

Why the phase is not accepted (honest gates, §92-93 unmet):
- The synthetic-fixture goldens could not be closed. Two full evenings of
  measurement produced systematically contradictory CPU readbacks of
  class-owned render targets (values impossible given the GPU state that
  the working hue view displayed). Confirmed traps along the way: two
  successive fixtures encoded with `-qp 0` decoded to pure black in this
  Chromium (silently — metadata fine); QA scripts edited mid-session
  poisoned the runtime via HMR twice; `readRenderTargetPixels` returns
  silent zeros on any buffer/type mismatch.
- Direction sanity (right⇒+X), noise floor and deterministic export for
  motion techniques therefore remain UNVERIFIED numerically.

Decision: the Motion Pack (Flow Displace/Feedback, Motion Mosh/Trails/
RGB, Directional Smear) and Time Field's motion mode stay unregistered
until CE1D-2 lands a GPU-verified golden harness (render the flow into an
RGBA8 visualization target INSIDE the product renderer and assert on
that — never raw CPU float readbacks of live class targets).

## CE1D-2 — Optical flow ACCEPTED; the harness that made it possible

- **Root cause of the entire CE1D measurement saga (measured, canaried)**:
  `renderer.setViewport` multiplies by pixelRatio unconditionally; calling
  it after `setRenderTarget` on a ratio-2 canvas confined every offscreen
  pass to the lower-left quadrant. Constant-color probes passed (any
  quadrant looks the same); anything consuming `vUv` read zeros at the
  sampled points. Fixed by REMOVING manual setViewport after
  setRenderTarget (the RT's own full viewport applies, ratio-free) in
  flow, diagnostics AND the CE1B feedback/bloom paths (tunnel regression
  verified visually). Full trap list + methodology: docs/GPU_TESTING.md.
- **Primitive accepted on numbers**: self-tested GPU harness; cardinal
  signs exact; velocity ±3% of ground truth at 2 grid-px; background at
  encoder half-LSB; useful range 1–4 grid-px (mono-scale LK aperture and
  range limits documented, not hacked); 320 confirmed optimal by sweep;
  ~27 updates/s from a 30fps source under the 120Hz loop.
- **Motion Pack registered** (6): Flow Displace, Motion RGB, Directional
  Smear, Flow Feedback, Motion Mosh, Motion Trails — all consuming the
  ONE shared flow service; stateful ones reuse the CE1B feedback
  primitive. Motion Bloom was never built (bloom-tail overlap); Vector
  Field View stays a dev uniform. Time Field gains the Motion field:
  moving regions tear into the past (verified live on camera). All six at
  118–121fps @1080p editor.
- 11 Motion presets (Flow Pull, Undertow, Vector Smear, Channel Drag,
  Body Ghost, Current, Mosh Drift, Block Storm, Clean Wake, Motion
  Memory + Activity Map under Studies).

## Simulation primitive (CE1E)

- **ADR — sibling of Feedback, not a refactor of it**: both ping-pong, but
  simulation adds seeded canonical initial state, an integer step index and
  per-system formats/filters (half-float+Linear for RD, RGBA8+Nearest for
  cellular). `SimulationSurface` + `SimulationRunner` own the lifecycle;
  each system supplies only a seed shader, a step shader, a format and a
  grid — no DSL, no graph. FeedbackSurface was left untouched (stable code
  wins).
- **ADR — one fixed 60 Hz clock, two drivers**: preview accumulates wall
  time (capped catch-up, evolves while paused/seeking/looping and with no
  source); export derives the canonical INTEGER step index from
  composition time and prerolls from the origin. Integer derivation is
  what makes subrange exports reconstructible and long exports
  drift-free. Preview ≠ export state, by design and documented.
- **ADR — no persisted runtime state**: projects store technique, params
  and seed only. Reload starts from the canonical seeded state; the
  Output builds its own local state (no simulation IPC) and therefore
  visibly warms up when opened mid-session.
- **Curation over mathematics (§41)**: Gray-Scott ships its useful window
  (feed .01–.09, kill .045–.07), not 0..1 of dead space; reset-only params
  (grid/density/seed/rule) are explicitly non-modulatable so modulation
  cannot restart the world every frame.
- **Bug found by the numbers**: the first solver used dA=1.0/dB=0.5 with a
  unit-weight Laplacian at dt=1 — outside the explicit-scheme stability
  limit; it rendered a high-frequency checkerboard that *looked* like a
  texture. The GPU stats (B collapsing, variance saturated) exposed it;
  dA=0.2/dB=0.1 restored real Turing patterns. This is exactly why CE1E
  built the harness before the visuals.
- **CE1F debt carried forward**: the Motion Pack's deterministic export
  goldens still need a decoder-free timeline source; CE1F's Generators are
  the intended fixture (see CE1D-2 note).

## Generators as sources (CE1F)

- **ADR — a generator is a Source, not a technique**: `GeneratorSource`
  implements the existing `SourceRuntime` contract; the engine owns it,
  renders it each frame with resolved params and hands the texture to
  whatever technique is active. No separate render universe, no special
  case inside techniques. Stateless kinds also implement `TemporalSource`
  (`acquireAt` re-renders the exact frame for any composition time) —
  MATERIAL's first decoder-free deterministic temporal source.
- **ADR — source-parameter modulation with editor authority**: generator
  params reuse the technique `ParamDef` vocabulary and the same modulation
  math (`applySourceModulations`), namespaced `source.<id>` to prevent
  collisions. The editor resolves them per frame; `FrameState.sourceParams`
  carries the RESOLVED values (present only when a generator is active, so
  the hot path does not grow otherwise). The Output applies them and never
  evaluates a mapping — the authority rule is unchanged.
- **Schema stays v3** (additive union variant, no field reshaped).
- **Simulation generators reuse the CE1E solver verbatim** — same kernels,
  same runner, no duplicated Gray-Scott or life implementation
  (structurally test-locked).
- **Hidden assumption surfaced (§50)**: the transport refused to play
  without media. Generators are unbounded (`duration: null`), so the
  controller now runs an internal composition clock when no audio/video
  master exists — procedural animation, Patterns and beat modulation all
  work in a media-free project. This is also what makes MATERIAL usable
  with zero imports and zero permissions on first run.
- **Debt closure measured**: repeat export byte-identical; full-vs-subrange
  12/12 for a stateless generator AND 12/12 for Motion Mosh (CE1D debt
  CLOSED, stateful preroll proven); Time Field repeat determinism proven
  decoder-free, its subrange gap now isolated to the atlas
  prime-vs-advance asymmetry rather than the decoder (CE1C debt partially
  closed, cause identified). Export order was fixed so the generator
  renders BEFORE the temporal atlas and the flow pair — both read source
  pixels and must see the export-resolution source; flow additionally
  prerolls one previous frame at a subrange boundary.

## CE1G — Morph transition styles

- **ADR — snapshot A + live B, not a parallel render**: the transition
  composites a one-shot RGBA8 snapshot of the outgoing frame against the
  live, still-evolving render. A parallel "A universe" would need a second
  feedback surface, a second simulation and a second flow field to keep a
  state the user has already left. The snapshot costs one target for the
  duration of the reveal and freezes A at the frame the user was looking at.
- **ADR — the identity switch moves to the reveal's OPENING (0.25), not
  0.5**: this is what makes the model work at all. With the switch at 0.5
  and the reveal centred there, the mask is already half open when identity
  flips, so half the frame pops — worse than shipping no transition. Moving
  the switch under the snapshot converts the pop into the reveal.
  `interpolateLookCore` takes the switch point as a parameter, defaulting to
  0.5 so `smooth` and every pre-CE1G project are bit-unchanged.
- **ADR — one window implementation** (`transitionWindow.ts`), imported by
  both the preview runtime and the export replay. Mutating it fails tests on
  both sides, so an exported morph cannot reveal differently from the
  performed one.
- **ADR — export re-renders A instead of snapshotting it**: preview must be
  real-time (snapshot), export must be order-independent (pure function). A
  subrange starting mid-reveal has no earlier frame to snapshot. Exported A
  takes macros but NOT modulation, whose per-frame smoothing state would
  make a subrange's A differ from a full export's. Both paths composite
  through the same GLSL — the mask math is never reimplemented in TS.
- **ADR — the transition is recorded on the morph EVENT**: export replays
  events, so a style held only as runtime state would export as a hard
  switch. `morphEvent.transition` is fully defaulted, so pre-CE1G projects
  parse and replay as `smooth`. **Schema stays v3** (additive, defaulted).
- **Curation**: all 10 styles kept. Two tuned rather than dropped — `luma`
  gamma-lifts its order (raw luma on a dark scene compresses the whole
  reveal into the last 10%), `zoom` pushes 0.6 instead of 0.35 (it shares a
  mask with `smooth` by construction, so only the eye separates them).
- **Debt found and paid in passing**: `main` was RED at CE1F — 34 lint
  errors and one `tsc` error (`electron/filesystem/projects.ts` read `.path`
  on a source union whose camera/screen/window/generator variants have no
  path). Both fixed here; all four gates are green again.
- **Debt carried**: a cross-technique reveal whose sides are TEMPORAL
  techniques inherits the CE1C `primeExact`/`advanceExact` asymmetry via the
  extra renderer swap. CE1H triage.

## CE1H — Curation / QA / Release closure

- **ADR — the CE1C temporal debt was a SAMPLING bug, not a scheduling one.**
  Three phases assumed the prime/advance schedules disagreed. Measured, they
  are identical by logical slot, with the same anchor, spacing and filled
  count; the only difference is `head`. History slots are tiles in one atlas
  texture, so a bilinear tap at a tile edge blended in the neighbouring tile —
  a different moment in time — and rotating the physical placement changes
  which frame is adjacent. `sampleTemporal` now clamps every tap half a texel
  inside its own tile. Time Field and Slit Scan went 0/12 → 12/12,
  byte-identical. It also fixes a latent preview bug: history frames were
  leaking into each other at the frame border.
- **ADR — composition time is addressed by GLOBAL FRAME INDEX.**
  `startSec + i / fps` is not stable across exports: a full export reaches
  global frame 25 as 1 + 13/12 and a subrange as 2 + 1/12, one ULP apart, and
  `floor(t * 60)` then picks a different simulation step. Reaction Diffusion
  and Cellular diverged on exactly every third frame because of it. Time is
  now derived from the frame index, so a frame is the same float in every
  export containing it.
- **ADR — a subrange export REPLAYS skipped frames for stateful feedback.**
  `exportBegin` ran the right step count but every step saw one frozen source
  frame. Proof: Feedback Zoom over an animated generator matched 0/12, and
  over a time-invariant one 12/12 — the count was never the problem. The
  preroll now walks the real frames with an evaluator started at the origin,
  so modulation smoothing and triggers replay identically. Cost is linear in
  the skipped range and nothing is rendered or written.
- **Bug found by curation, not by tests — optical flow never ran during
  export.** `renderFrame` skips flow in export mode and the export-path
  function was never called. Every Motion technique exported against a stale
  field or none. A constant field is perfectly deterministic, so every
  determinism gate passed; the preset contact sheet caught it by rendering
  four different Flow Displace presets to byte-identical tiles. **When a gate
  can be satisfied by a system doing nothing, it needs a companion that fails
  when nothing happens.**
- **ADR — the catalog has a drift gate.** `docs/inventory.json` is generated
  from the live registry and a test fails if the committed file disagrees.
  Ids, names, parameter ranges, in-range defaults, preset targets, modulation
  targets and preset categories are all mechanically checked, so a silent
  catalog change is a build failure rather than a discovery.
- **ADR — presets are curated by looking, against four sources.** A preset
  judged on one clip is judged on that clip. Contact sheets are rendered
  through the export preparation path (a bare `renderStill` primes no
  history/feedback/flow and reported 292 false duplicates) and duplicate
  comparisons use full-resolution tiles (downscaling made Coral and Worm
  Field look identical when they differ by 204).
- **ADR — context restore REALLOCATES.** Marking state stale left dead GL
  handles from the lost context. Feedback and simulation surfaces recreate,
  the temporal provider is rebuilt with its config, flow is dropped for lazy
  rebuild, the transition snapshot is released. Measured: fps returns to
  119–121, one transient INVALID_OPERATION during the rebuild itself, zero
  errors in steady state over 120 frames.
- **ADR — generator source presets DEFERRED, option B chosen for later.**
  A named parameter-set list in the Source inspector is the right shape and
  needs no change to the `Preset` schema. It is deferred because the cost is
  the CONTENT, not the plumbing: a new preset surface deserves the same
  four-source curation the 107 technique presets just received, and adding an
  uncurated content surface during release closure is the scope creep CE1H
  §83 exists to prevent. See BACKLOG.md.
- **ADR — release is v0.3.5, not v0.4.** ROADMAP reserved v0.4 for Image /
  Motion Signals before this work existed; taking the number would break a
  promise already written down. Creative Expansion 01 ships as v0.3.5.
- **Schema stays v3.** Every CE1x addition was additive and defaulted.
- **Packaged QA method (§66), and what it can and cannot prove.** The
  packaged build exposes NO remote debugging port — the switch is dev-only and
  Electron's fuses reject it as a CLI argument in a packaged app. That is the
  correct security posture, and it means CDP-driven QA cannot run against the
  shipping artifact. Interactive packaged QA was therefore done as: build a
  temporary variant, verify, then rebuild the shipping artifact from clean
  source. Blind UI automation was NOT used — the desktop-safety rule from 18G
  stands. What the shipping artifact was verified to do: launch, stay alive,
  quit cleanly with an empty error log, report version 0.3.5, expose no
  debugging port, and contain every creative system plus exactly 107 built-in
  preset ids with the curated-away preset absent.

## v0.4A — Image / Motion Signals

- **ADR — the editor measures, the Output never does.** Visual signals are
  computed once, in the editor's engine, and only resolved parameter values
  cross the Output channel. No pixels, no signals, no second analyser. This is
  the same authority rule the replica has had since 18D, applied to a subsystem
  that would have been technically easy to duplicate.
- **ADR — signals sample frame N−1, in both paths.** Preview evaluates sources
  *after* the source renders; export evaluates them *before*. A signal derived
  from the current frame would therefore read different things in the two
  paths. Sampling the previous frame in both is what makes them agree, and it
  is also what makes a visual signal driving a source parameter safe rather
  than a cycle.
- **ADR — RAW and CALIBRATED are both first-class.** A measurement in real
  units is what a diagnostic needs; usable travel on this particular source is
  what a mapping needs. Collapsing them would repeat CE1H's dead-knob failure
  in a new place. RAW is what the scope displays, CALIBRATED is what mappings
  consume, and the scope shows both so the difference is never a mystery.
- **ADR — calibration is runtime-only, keyed by pixel origin.** Persisting a
  moving statistic would make an export irreproducible from a fresh open and
  would need a schema migration to carry. The key tracks where pixels come
  from (`gen:noise:5`, `cam:default`, `file:video:/path`), not the project's
  source id, which survives a camera device swap, nor the engine's source key,
  which has no id for files. Generator params are excluded deliberately: the
  same material with a different look should keep its range.
- **ADR — absence, not zero, for an unavailable signal.** The evaluator already
  treats a missing key as neutral. Publishing 0 would let `invert`, a curve or
  a non-zero `min` manufacture a contribution out of a signal that does not
  exist, and would drive every motion mapping to its `min` whenever there was
  no flow field.
- **ADR — `motion.x` is unipolar with a bipolar default mapping.** `applyCurve`
  clamps every signal to 0..1 unconditionally, and that evaluator is shared by
  audio, beat and pattern sources and has been stable since v0.2. Publishing
  `0.5 + 0.5·direction` and shipping `{min: -1, max: 1}` as the signal's
  default mapping gets bipolar behaviour with no change to shared code.
- **ADR — motion saturation is reported, not suppressed.** Lucas–Kanade cannot
  resolve beyond its aperture, and the shader clamps each component at 8
  texels. The first design treated a saturated frame as unmeasurable and
  withheld it; that deleted motion from 59 of 61 frames of a 12 fps export,
  where 5–8 texels/frame is simply what fast motion looks like. The value is
  now capped at the field's own ceiling (8·√2) and published. Transient
  saturation is handled by the envelope's time constant instead: at 30 Hz a
  single outlier moves the range by 2.2% of the gap.
- **ADR — one shared reduction chain, not one per signal.** Luminance and
  motion share a gate, a cadence and a readback stall. Splitting them would
  double the synchronisation points to save one channel of a 16-byte read.
- **Schema stays v3.** Visual signals are new `MOD_SOURCES` ids inside the
  existing modulation registry; nothing about the project format changed.

## v0.4B — signal vocabulary

- **ADR — MRT rather than a second ladder.** Six new sums did not fit in four
  channels. Three RGBA32F attachments carried through one ladder cost extra
  fill rate, which is cheap; a second ladder would have cost a second readback,
  which is not. A tiny pack pass stacks the final tiles so there is still
  exactly one GPU sync per analysis.
- **ADR — calibration is per-signal, not a pipeline stage.** Five of nine
  signals opt out, for three different reasons: intrinsic bounds (`motion.x/y`),
  an already-physical fraction (`motion.activity`), and coordinates that must
  not be moved (`motion.centroidX/Y`). Running everything through the same
  envelope would have been simpler and would have made two of those signals
  lie.
- **ADR — positional signals hold, they do not snap.** Below
  `CENTROID_MIN_TEXELS` a centroid is noise divided by noise, which produces a
  position that wanders the frame and looks exactly like tracking. The reducer
  holds the last valid position and the scope reports `HELD`, so a motion-driven
  effect stays where the gesture ended without the UI presenting a memory as a
  measurement.
- **ADR — contrast is a standard deviation.** `sqrt(E[L²] − E[L]²)`, which the
  ladder yields for one extra accumulator. Naming an ad-hoc spread "contrast"
  would have been cheaper and would have made the number unexplainable.
- **ADR — edge energy is total variation per texel.** Its consequence is stated
  in the fixtures: a ramp and a hard edge read alike. That is a property, not a
  bug, and contrast is what distinguishes them.
- **Deferred deliberately:** `motion.direction` (circular data has no sensible
  linear mapping yet), `motion.spread`, RGB and colour energy. Easy to add is
  not a reason to add.

## v0.4C — mapping model

- **ADR — two modes: Add and Set.** Add is unchanged and remains the default.
  Set positions a parameter inside its own range. Multiply was spiked and
  dropped — nothing in the Look vocabulary needed it, and every mode multiplies
  the composition rules.
- **ADR — `mode`/`inMin`/`inMax` are optional, not defaulted.** Absent and
  `'add'` mean the same thing in every project ever written. Defaulting would
  have rewritten every stored project on first save to say what it already
  meant, and forced 52 construction sites to spell out three fields.
  Schema stays **v3**.
- **ADR — at most one Set per parameter, first enabled in document order.** Two
  mappings each claiming to *be* a parameter have no meaningful sum, and
  choosing by evaluation order would make the result depend on row order. The
  losers are marked `INERT` in the UI rather than silently doing nothing.
- **ADR — `amount` blends in Set mode.** The slider keeps one meaning across
  both modes: how much this mapping matters.
- **ADR — invert stays `1 − v`.** For centred signals that IS the bipolar
  inversion, because they publish `0.5 + 0.5·direction`. A separate bipolar path
  would have computed the same number while risking the unipolar sources that
  share the evaluator.
- **ADR — the input window is not calibration.** Calibration adapts a signal to
  its source automatically; the window is a per-mapping choice about what to
  react to. Conflating them is what makes a Look source-specific.
- **ADR — calibration Lock/Reset are runtime-only.** Persisting a moving
  statistic would make an export irreproducible from a fresh open.

## v0.4D — signal-driven content

- **ADR — signal Looks are ordinary presets.** A preset already carries a
  technique, params, a material and its modulations. Inventing a parallel
  content type would have doubled the save/load, curation and morph surfaces to
  express the same thing.
- **ADR — a new `Reactive` category.** Motion describes what a technique does;
  Reactive describes where the control comes from. Filing them under Motion
  would have hidden the distinction the release exists to make.
- **ADR — ranges are hand-curated per Look.** A test rejects any Look whose
  every window is the default 0..1, because that is the signature of nobody
  having looked at the result.

## v0.4E — release

- **ADR — the runtime owns effective demand.** A morph resolves an overlay whose
  modulations replace the project's while it runs, so demand computed from the
  project alone left a Look being morphed TO with its signals dark for the whole
  transition. The runtime resolves the overlay, so the runtime pushes demand;
  the bridge adds scope demand and forwards it to the engine, which owns the
  GPU. Export reasons about the whole timeline instead, unioning every Look its
  morph events can reach.
- **ADR — flow readiness distinguishes a constructed pair from a
  discontinuity.** Preview discards its first solve after a reset because that
  solve straddles the discontinuity. Export builds its pair deliberately with a
  two-tap prime, says so, and keeps motion on frame one.
- **ADR — smoothing refuses to store a non-finite value.** One NaN `dt` used to
  poison a mapping permanently. Treating an unusable dt as no time passing keeps
  the mapping alive and recoverable.
- **Schema stays v3** for the whole of v0.4. Nine new source ids live in the
  existing modulation registry, and three optional mapping fields are additive.

## v0.5 — shader extensibility

### The host

- **ADR — a pack is data + GLSL + metadata, never JavaScript.** Executable
  plugins would hand a pack the application: the filesystem, IPC, app state and
  the DOM are all one `require` away from any code that runs in the renderer.
  Declarative packs keep the extension surface to what MATERIAL chooses to
  render, and a test asserts the manifest schema has nowhere to put code.
- **ADR — MATERIAL owns the vertex shader; packs are fragment-only.** It keeps
  the surface small enough to keep compatible across versions, and it means a
  pack cannot change where the quad is or what `vUv` means.
- **ADR — MATERIAL owns a prelude too.** The host declares the uniforms, `vUv`
  and `fragColor` rather than asking each pack to repeat them. A pack cannot get
  them subtly wrong, and because the host controls the composition it can end it
  with `#line 1` and report every compiler error at the line the author wrote.
- **ADR — one source texture.** A texture graph is a product decision about what
  MATERIAL is, not a compatibility requirement. One input covers image filters,
  which is the whole v0.5 target.
- **ADR — composition time and a project seed, never a wall clock or
  `Math.random`.** Same time, same params, same source, same pixels. Without
  that, none of the export determinism the rest of the app guarantees would
  survive contact with a hosted shader.
- **ADR — custom shaders are ordinary `TechniqueDefinition`s.** No second
  rendering universe. The inspector, modulation, signals, Explore, Looks, Morph
  and the Output accepted them with no shader-specific code, which is the only
  evidence that the abstraction was the right one.
- **ADR — last-known-good over correctness theatre.** A revision that does not
  compile leaves the previous one rendering and reports the error. Blacking out
  a live performance to signal a missing semicolon is the wrong trade.
- **ADR — a missing pack passes the frame through and says so.** Substituting a
  different shader would look like it worked while quietly reinterpreting the
  project's stored parameter values against a contract that is not theirs.
- **ADR — no sandbox is claimed.** GLSL that compiles can still be expensive and
  no host-side text check changes that. MATERIAL refuses the obvious accidents
  and documents the limit plainly instead of implying a guarantee it cannot
  keep.

### Packs

- **ADR — managed storage, and install copies only declared files.** Running
  from the folder the user picked would make behaviour depend on a directory the
  app does not control. Copying an allow-list rather than mirroring means
  nothing incidental travels, and reinstalling replaces wholesale so a deleted
  shader cannot linger.
- **ADR — all filesystem work in the main process.** The renderer receives
  validated data and has no path API. The only paths ever opened are ones a
  manifest declared, resolved and re-checked.
- **ADR — two independent path checks.** Lexical for `..` and absolute paths;
  `realpath` for symlinks that point outside, which pass every lexical check.
- **ADR — parameter definitions are validated as a whole.** `min > max` was
  accepted while every field was individually valid. Found by an adversarial
  fixture in B, fixed in A's contract rather than in the loader that noticed.
- **ADR — pack presets are params only.** A preset carrying modulation mappings
  would name signals and targets belonging to the host, break whenever either
  changed, and let a pack write into parts of a document it has no business
  touching.

### ISF

- **ADR — a documented subset, not "ISF support".** MATERIAL hosts single-pass
  image filters with one image input. The phrase used in the docs is exactly
  that, because claiming compatibility one cannot keep is worse than claiming
  less.
- **ADR — no multipass and no persistent buffers.** They are not missing
  features; they are a second copy of a system MATERIAL already has (FEEDBACK,
  HISTORY, SIMULATION), each with its own export preroll, VRAM accounting and
  determinism story. Two systems disagreeing about persistent state is how
  export determinism dies.
- **ADR — convert at import, not at render.** An accepted ISF file becomes an
  ordinary pack, so it inherits the entire lifecycle rather than needing a
  parallel one. The renderer contains no ISF code path, asserted structurally.
- **ADR — a compatibility prelude, not a transpiler.** ISF's automatic
  variables and `IMG_*` helpers become `#define`s and small functions over the
  host contract, and the ISF source is passed through untouched. Writing a GLSL
  compiler to host a file format is the wrong amount of machinery.
- **ADR — every refusal names its feature.** MULTIPASS, PERSISTENT_BUFFER,
  MULTIPLE_IMAGE_INPUTS, GENERATOR, and each unsupported input type. "It did not
  load" is not actionable.

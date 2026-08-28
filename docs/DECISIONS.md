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

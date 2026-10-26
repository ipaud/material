# Technique Chains

## Status

Phase G implementation is complete; release validation remains open. Project v7 stores ordered chains; editor preview renders
compatible stateless/flow stages. BUILD supports adding compatible stages,
reordering, removing, and editing each stage's saved parameters. Output replica
and video/PNG export traverse chains with saved additional-stage parameters.
Stage-aware modulation and Morph use stable stage IDs in preview, Output and
export. The browser harness sends production `OutputReplica` RenderInputs and
FrameState messages, then compares replica branch pixels with the export
runtime.
The packaged arm64 app starts on Apple M5 Pro, renders a two-stage chain and
exports it through the app UI. Non-controlled editor UI readings ranged
31–45 FPS at 1080p; these are separate from native Output-window readings and
are not a GPU benchmark.

## Current architecture

- A layer stores one nullable primary technique plus up to two ordered stages.
- `LayerRuntimeImpl` renders supported stages in sequence. Later stages sample
  prior-stage pixels; flow vectors stay in original layer-input domain.
- `LayerHost` owns two scratch targets shared by all layers; final stage writes
  into normal layer target. Existing one-stage path remains unchanged.
- Editor preview, Output replica and video/still export traverse compatible
  chains using saved additional-stage parameters.

## Compatibility constraints

| Technique family                                | Current dependency                                         | Chain constraint                                                              |
| ----------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Mosaic                                          | Source texture; optional temporal atlas in Video Tile mode | Stateless only when Video Tile is off                                         |
| Echo, Step Print, Slit Scan, Time Field         | Composition-time history                                   | Needs history of that stage's input, not implicitly the original layer source |
| Flow Displace, Motion RGB, Directional Smear    | Shared optical-flow field                                  | Samples prior-stage pixels; vectors remain in original layer-source domain   |
| Feedback techniques, Motion Mosh, Motion Trails | Persistent feedback surface and prepass                    | Needs per-stage reset, context-restore and deterministic export preroll       |
| Reaction Diffusion, Cellular                    | Persistent simulation surface                              | Needs explicit stage input and per-stage export stepping                      |
| Custom shader packs                             | Single-pass fragment shader and source texture             | Candidate for stateless chaining; missing packs must remain safe              |

The requested Dither technique is not registered in this repository yet.

Technique definitions now declare chain behavior. Multi-stage assessment
allows only explicitly classified `stateless` and `flow` stages. Flow stages
consume previous-stage pixels while their motion vectors remain measured from
the original layer source. Temporal, feedback, simulation, missing-pack and
unclassified stages are rejected with a reason. A one-stage project keeps its
existing behavior regardless of class.

Project parameters also need stage identity. Takes, MIDI, modulation and Morph
now use stable stage IDs for extra-stage numeric parameters. Explore still
resolves one technique's parameter namespace per layer.
Look snapshots, Output messages, project migrations and export preserve the
same ordered chain.

Project v7 stores up to two extra ordered stages and preserves them in Look
snapshots. Editor preview and export render compatible stateless/flow stages
through two shared ping-pong targets. Incompatible chains are rejected with a
reason. Additional-stage parameters use saved base values in preview, Output
and export. Take lanes override extra-stage numeric params by stable ID in
preview, Output and video export; stopping Take commits values to matching
stages. MIDI Learn stores layer and stage IDs, and CC pickup follows the saved
stage after reorder. Modulation mappings also store stage ID; primary mappings
keep their legacy semantics. Morph matches stages by stable ID, interpolates
matching stage parameters, and switches added/removed stages at identity
boundary.
Preview shows an info toast when chain runs.

## Browser GPU harness

`scripts/technique-chain-poc/index.html` and `main.js` run three stateless
Mosaic renderers at 1920×1080. Two scratch render targets alternate between
stages; the one-stage path writes to the first target. The result uses a
generated test texture and does not change project or application state.

Run with `npx vite --config scripts/technique-chain-poc/vite.config.ts`, then
open `http://localhost:5173/` in a WebGL-capable browser.

Observed in the local WebKit WebGL runner:

- One, two and three stages produced non-empty output.
- Repeated output was byte-identical for each stage count (`maxDiff = 0`).
- One-stage prototype baseline repeated exactly (`maxDiff = 0`).
- Two 1920×1080 RGBA8 scratch targets consume about 15.82 MiB per render host,
  shared across chained layers, before other render resources.
- Chrome exposed `EXT_disjoint_timer_query_webgl2`. Across three 120-frame
  runs, queries ranged 0.042–0.090 / 0.063–0.073 / 0.080–0.088 ms per frame
  for 1 / 2 / 3 stages in this local runner. Renderer string remains the generic
  `WebKit WebGL`, so these numbers validate the measurement path, not target
  GPU execution time. Profile packaged target GPUs before setting performance
  budgets for enabled chain depth.

The harness sends production `OutputReplica` RenderInputs and FrameState
messages; the replica installs each chain through `OutputLayer.applyInputs`.
It renders one, two and three Mosaic stages with stable IDs and synthetic
resolved overrides (not app-evaluated Take, MIDI, modulation or Morph values).
The deterministic test texture is injected with `branch.setSource()` after
RenderInputs, so this does not exercise source transport or acquisition through
`OutputLayer`. Composed replica frames were deterministic and non-empty. Direct
replica-branch pixels matched a separate export-mode `LayerRuntimeImpl` for all
three chain lengths (`maxDiff = 0`); the export runtime restored the scissor-test flag.
The harness does not compare the scissor rectangle. It validates replica
message/layer/render paths, but not native Output-window IPC/display composition
or encoded FFmpeg frames. Renderer string was generic `WebKit WebGL`.

Latest local rerun (2026-10-26, Chrome): GPU timer queries were available and
reported 0.057 / 0.064 / 0.080 ms per frame for 1 / 2 / 3 stages. Repeated
frames remained deterministic (`maxDiff = 0`), replica/export branch diff
remained 0, and scissor-test state was restored. The reported renderer still
identifies only as generic `WebKit WebGL`; these results validate the harness
and measurement path, not a named physical GPU.

Browser timer queries and fluctuating editor UI readings are not GPU execution
budgets. Packaged native Output cadence is measured separately below.

## Packaged M5 Pro Output-window profile

On 2026-10-26, ran the packaged macOS arm64 app against the same animated Noise
Grid recipe with a 1920×1080 composition in a window on the built-in Retina
display (1512×982 @2×). For each chain depth, captured Output's cumulative
frame/time counters before and after
a sustained run. The native Output overlay reported 120 FPS and 0–1 ms latency
at sample end:

| Mosaic stages | Start (time / frames) | End (time / frames) | Elapsed | Frames | Average |
| ------------- | -------------------: | -----------------: | ------: | -----: | ------: |
| 1             | 225.97 s / 27,088     | 307.22 s / 36,839   | 81.25 s | 9,751  | 120.0 FPS |
| 2             | 561.47 s / 67,345     | 629.47 s / 75,510   | 68.00 s | 8,165  | 120.1 FPS |
| 3             | 436.22 s / 52,314     | 502.72 s / 60,296   | 66.50 s | 7,982  | 120.0 FPS |

These counters prove sustained native Output delivery at the display's observed
120 FPS cadence for this recipe and machine. They do not isolate GPU execution
time, prove other GPU/driver behavior, or cover larger projects. Treat them as
a packaged-device liveness/capacity check, not a performance budget. The two
1080p RGBA8 ping-pong targets use about 15.82 MiB per render host when chaining.

## Release validation ledger

1. **Open — additional GPUs:** Capture uncapped GPU execution timings, render-target memory, and one-stage
   identity on additional target GPUs. Current M5 Pro Output runs reached the
   built-in display's 120 FPS cadence; they do not isolate GPU cost.
2. **Measured — Output / H.264:** Comparison exercised using the packaged
   arm64 app and static 1920×1080 Noise Grid chain (30 fps, 30 frames). It found
   and fixed two Output replica omissions: chain stages now install through
   `RenderEngine` / `LayerHost` (which allocates ping-pong targets), and resolved
   primary params now reach the Output branch. A fullscreen capture on the
   built-in Retina display measured a 3024×1964 drawing buffer at 2× scale.
   Applying renderer's 0.94 fit margin, cropping composition rect
   (2843×1599 at x=91,y=183) and nearest-neighbor scaling to 1920×1080, decoded
   H.264 frame 0 measured mean absolute RGB-channel difference 2.694, RMSE
   15.018, 84.593% exact channels and 94.430% within 2 codes. Remaining
   differences reflect lossy H.264 encoding and resize/capture path. This closes
   local fullscreen Output/export comparison on one display/GPU; cross-display
   and cross-GPU parity remain open.
3. **Measured — export determinism:** Repeated encoded export is verified for one two-stage Noise Grid
   project: two 1920×1080 H.264 files (30 fps, 30 frames) matched byte-for-byte
   (SHA-256 `527a94899d9c6439fc127ab6a56d4e6e5133ff9faf73d5ffd18fbe6654819206`)
   and their decoded frame-md5 streams matched. Representative stateless/flow
   and legacy single-technique coverage now includes these fixtures:
   A moving-source flow chain is now covered by
   `tests/fixtures/motion-rgb-flow-chain.material`: two 1920×1080 H.264 exports
   (30 fps, 30 frames) matched byte-for-byte (SHA-256
   `54a2f79eb0407c1c8b54887842399ed8002c1fe1648a09a5025d780617b79eae`), with
   identical decoded frame-md5 streams and 30 unique frames. The fixture also
   has a compatibility/schema regression test. Cross-platform and GPU-driver
   parity remain open.
   The legacy v3 single-technique fixture also rendered twice through the
   production CLI at its native 640×360 size (H.264, 30 fps, 30 frames); files
   matched byte-for-byte (SHA-256
   `68443f3dd7abfcdd8796d38cf868c98926a7cdd35904b0f94837c9cc31897de0`),
   decoded frame-md5 streams matched, and all 30 frames were unique. Its
   regression test confirms migration retains Mosaic and an empty chain.
   Reproduce on macOS after `npm run build`:

   ```sh
   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/Electron.app/Contents/MacOS/Electron out/main/index.js render tests/fixtures/noise-grid-chain.material --out /tmp/chain-a.mp4 --codec h264 --fps 30 --range 0:1
   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/Electron.app/Contents/MacOS/Electron out/main/index.js render tests/fixtures/noise-grid-chain.material --out /tmp/chain-b.mp4 --codec h264 --fps 30 --range 0:1
   shasum -a 256 /tmp/chain-a.mp4 /tmp/chain-b.mp4
   cmp /tmp/chain-a.mp4 /tmp/chain-b.mp4
   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/Electron.app/Contents/MacOS/Electron out/main/index.js render tests/fixtures/motion-rgb-flow-chain.material --out /tmp/flow-a.mp4 --codec h264 --fps 30 --range 0:1
   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/Electron.app/Contents/MacOS/Electron out/main/index.js render tests/fixtures/motion-rgb-flow-chain.material --out /tmp/flow-b.mp4 --codec h264 --fps 30 --range 0:1
   shasum -a 256 /tmp/flow-a.mp4 /tmp/flow-b.mp4
   cmp /tmp/flow-a.mp4 /tmp/flow-b.mp4
   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/Electron.app/Contents/MacOS/Electron out/main/index.js render tests/fixtures/v3-single-layer.material --out /tmp/legacy-a.mp4 --codec h264 --fps 30 --range 0:1
   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/Electron.app/Contents/MacOS/Electron out/main/index.js render tests/fixtures/v3-single-layer.material --out /tmp/legacy-b.mp4 --codec h264 --fps 30 --range 0:1
   shasum -a 256 /tmp/legacy-a.mp4 /tmp/legacy-b.mp4
   cmp /tmp/legacy-a.mp4 /tmp/legacy-b.mp4
   ```
4. **Covered — incompatible chains:** Rejection is covered at assessor, Output and BUILD UI
   levels: `Mosaic → Echo`, `Mosaic → Flow Feedback`, and a saved
   `Generator → Mosaic → Flow Feedback` display a reason and stay paused.
5. **Partial — Windows:** CI runtime smoke passed on repository HEAD `58d2724` on
   2026-10-24, including packaged app launch and audio analysis. Current
   uncommitted Phase H–K changes have not run in Windows CI; current host is
   macOS arm64.

Mosaic → Dither waits until Dither exists. Physical MIDI and second-display
validation remain Phase K gates.

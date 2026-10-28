# MATERIAL 1.0 — Implementation Plan

Plan follows `docs/V1_AUDIT.md`. It keeps current render, project and capture contracts intact and sequences state foundations before dependent UX. This is a plan, not authorization to bundle all phases into one release or change package version.

## Decisions to settle first

1. **Pins vs Looks — resolved:** reuse `pinnedLooks`; `slot: null` is a Pin, assigning a slot makes it performance-ready as a Look. No parallel persisted store.
2. **Layer limit — resolved:** cap new layer creation at four; keep schema/format compatibility at eight so existing projects still open and render. Existing projects above four cannot add or duplicate layers.
3. **PLAY naming — resolved:** show PLAY in navigation and docs; preserve internal workspace id `perform` and all shortcut bindings.
4. **Snapshot scope — resolved:** Pins capture composition and layer settings; `LookCore` stays selected-layer state for Morph. Held Compare uses renderer-only Pin snapshots and never changes the saved document. Compare/export Pin currently accept generator-only stacks because file/live source acquisition is asynchronous.

## Recommended sequence

### Phase A — Audit (complete)

- Repository, architecture, UX, state, rendering, registries, migration and export reviewed.
- Existing tests, typecheck, lint and production build run. Results recorded in `V1_AUDIT.md`.
- No feature implementation began during the audit itself.

### Phase B — Product foundation (complete)

- Add concise principles to existing canonical product docs or create `PRODUCT_PRINCIPLES.md` if no existing location fits.
- Reconcile README, ARCHITECTURE, ROADMAP, UI_V2 and LAYERS against version 0.8.6 implementation.
- Align navigation and labels toward BUILD / EXPLORE / PLAY while preserving current routes and shortcuts.
- Expose Behavior language progressively inside current modulation/trigger model; no new signal engine.

### Phase C — Preservation and state boundaries (complete)

- Compare current Look capture and recall with proposed universal Pin use cases.
- Define snapshot fields, stable IDs, thumbnails, project ownership, undo/delete behavior and legacy compatibility.
- Delivered: reuse `pinnedLooks` as project-owned Pins; P creates unslotted `PIN NNN`; current, Candidate and Explore variation paths capture full layer snapshots; Library promotes a Pin into the next free Look slot.
- Reused: apply, Morph To, rename, delete and project serialization. Added optional layer `input` / `activity` snapshot fields; v5→v6 stamp prevents older builds from stripping them. Legacy snapshots that omit these fields keep their old recall behavior.
- Delivered: Explore Around on compatible Pins, using existing seeded mutation population and honoring Explore locks. It leaves Current unchanged and opens EXPLORE with the Pin as generation-zero anchor.
- Delivered: Pin still export for generator-only stacks. It renders through the normal live bridge with a silent temporary snapshot, restores Current synchronously before save dialog, and rejects file/live sources because their bridge acquisition is asynchronous.
- Delivered: held Compare from Pin/Look menu. Renderer-only preview state remains separate from document state; pointer/key release cancels it, and any document edit cancels preview before applying against Current. Generator-only guard avoids stale asynchronous file/live sources.
- Phase C complete. Focused tests cover no-output-change capture, full layer snapshots, variation thumbnails, Pin-to-Look promotion, Explore Around, held Compare cancellation and edit safety.

### Phase D — Explore 2.0 (complete)

- Reused seeded mutation, the existing candidate lock groups, renderer preview bridge and sequential thumbnail pipeline.
- Explore Around from Phase C now uses selected Pin as generation-zero center. Generate starts from Current; seeded children stay deterministic.
- Added SUBTLE, VARIATION, WILD and STRUCTURE modes. Modes scale mutation rate/range through Candidate's shared profile; STRUCTURE filters to layout/geometry params. All values stay inside existing Explore ranges.
- Timing, color, technique and signal locks constrain variation mutation. Material, technique identity and modulation topology stay fixed because current Variation/render contract cannot safely preview those changes; WILD mutates parameters and modulation shaping only.
- Added transient BACK history, capped at eight populations. It restores population, thumbnails and selection; it never serializes or dirties project. Apply remains one undoable project edit; compare remains renderer-only.
- Thumbnails render sequentially through existing engine, yield between frames, cancel on superseding generation or document edits, and never save preview state. Exact GPU timing/platform profiling remains part of release validation.
- Tests cover same-seed replay, mode strength, structural filtering, lock honoring, Apply/undo, Compare isolation and history boundaries.

### Phase E — Materials and typography (complete)

- First move material metadata toward existing registry conventions without duplicating render paths.
- Resolve font portability and fallback policy before serializing typography state.
- Implement one glyph/word/repeated-phrase material path through current material/render interfaces; then connect modulation, Looks, Morph, Explore and export.
- Added categorized material registry metadata and a Typography material using bundled Noto Sans Mono (SIL OFL 1.1); serialized state uses a stable font id and validated bounded settings.
- Added character, word and multiline phrase atlas rendering through existing material texture path, with source-luminance selection and modulatable / Explore-randomizable `glyphIndex`.
- Inspector and Library now edit the selected layer material while mirroring legacy top-level state. Existing Look/Morph snapshots preserve typography params; preview and output replica share the raster loader; still export consumes the same live render engine.
- Tests cover token normalization/caps, registry indices, schema validation and project/Morph compatibility. Pixel identity across operating systems and GPU drivers remains unverified.

### Phase F — Macros 2.0 (complete)

- Reused existing deterministic multi-destination evaluator and project schema. BUILD now exposes each mapping's signed amount, output min/max, inversion and curve.
- Fixed MIDI mapping labels and relearn routing for macro targets; MIDI Learn remains on existing MIDI engine. PLAY faders, Take record/replay, Morph overlay and export already consume the same macro values/evaluator.
- Explore leaves macro definitions and values untouched, preserving them as performer controls; no parallel mutation path added.
- Focused tests cover editable mapping shape and MIDI relink target. Existing tests cover mapping math, serialization, missing targets, MIDI pickup, Take capture/replay and export parity. Physical MIDI controller remains untested.

### Phase G — Technique chains (implementation complete; release validation open, high risk)

- Added a 1–3 pass Mosaic browser harness. Across three live 1080p WebGL runs, GPU timer queries ranged 0.042–0.090 / 0.063–0.073 / 0.080–0.088 ms per frame for 1 / 2 / 3 stages; repeated outputs had max pixel diff 0 and all stages produced non-empty pixels. The harness drives production `OutputReplica` RenderInputs/FrameState messages (which install `OutputLayer` chains) and synthetic stable-ID stage overrides; a generated test texture is injected at branch level. Its composed frames were deterministic; branch pixels matched a separate export-mode `LayerRuntimeImpl` exactly for all three chain lengths, and the export scissor-test flag was restored. It does not exercise source acquisition, Take, MIDI, modulation or Morph evaluators. This covers replica-layer/render paths, not native Output-window IPC/display composition or encoded frames. The packaged native Output window later sustained the built-in display's 120 FPS cadence for 1–3 Mosaic passes on Apple M5 Pro; this does not isolate GPU execution time. Two 1080p scratch targets cost about 15.82 MiB per render host and are shared across layers.
- Added explicit per-technique chain behavior and a compatibility assessor: only stateless and flow stages pass; temporal, feedback, simulation and missing/unclassified stages return clear rejection reasons. Tests now cover Mosaic → Echo and Mosaic → Flow Feedback rejection with reasons. Packaged BUILD's Add stage menu offered only compatible stages under Mosaic and omitted Echo/Feedback. Flow vectors stay in original-layer-source domain.
- Bumped project format to v7. Layers persist at most two extra ordered stages; v6 migration preserves the original single technique, and layer Look snapshots round-trip chains.
- Editor preview and Output replica now render compatible stateless/flow chains through two LayerHost-shared scratch targets. Browser harness drives production `OutputReplica` messages and exercises `OutputLayer.applyInputs`; 1–3 stage replica frames were deterministic, and branch/output-runtime pixel diff was 0. A Chrome local rerun on 2026-10-26 measured 0.057 / 0.064 / 0.080 ms per frame for 1 / 2 / 3 Mosaic stages, with deterministic maxDiff 0 and replica/export diff 0; renderer remains generic WebKit WebGL, so this validates the harness, not named target-GPU cost. Packaged Output cadence is profiled; uncapped physical-GPU timing and other target GPUs remain unverified.
- BUILD now adds compatible stages, reorders/removes them, and edits saved stage parameters. Take lanes, MIDI Learn/CC, modulation and Morph target extra-stage numeric params by stable IDs across preview, Output and export. Integration tests cover compatible bridge installation, changed stage IDs/params, incompatible-chain clearing, LayerRuntimeImpl render-state restoration after a thrown pass, and VideoIngest resize/copy/renderer-state recovery. Output camera tests cover exact-device fallback after overconstraint, permission-denial behavior and late-stream cleanup. Output rebuilds custom chain renderers when a shader pack revision changes. Production-build CLI exports of stateless Mosaic→Mosaic, moving-source Motion RGB→Flow Displace and legacy v3 single-technique Mosaic each repeated byte-identically; decoded frame streams also matched. Packaged arm64 app starts on Apple M5 Pro, rendered a two-stage chain and exported it through app UI at 1080p H.264, 30 fps, 1 second; ffprobe found 30 frames and framemd5 found all 30 distinct. Sustained native Output counters show 120 FPS cadence at 1080p for 1 / 2 / 3 Mosaic stages on built-in display. A packaged native Output / decoded H.264 comparison then found and fixed chain scratch-target and primary-parameter replication omissions. Fullscreen Output/H.264 comparison is recorded in `docs/TECHNIQUE_CHAINS.md`: after composition crop and resize, mean RGB difference 2.694 and 94.430% of channels fall within 2 codes; other displays/GPUs remain unverified. See `docs/TECHNIQUE_CHAINS.md`.
- Cap remains three techniques per layer; one-technique output and v6 migrations are covered by tests.

### Phase H — Recipes (implementation and local packaged export matrix complete)

- Curate 12–20 tested recipes from existing generators, techniques, materials and behavior systems.
- Reuse preset/project application paths; avoid new execution or plugin mechanisms.
- Each recipe must open, render, mutate, preserve and export correctly.
- Added 13 project starters with a procedural source, technique, material, image/motion Behavior mapping, Macro and trigger Pad. Starting a Recipe fills a blank layer or adds one under the four-layer creation cap, preserving occupied layers; one undo reverses the setup. Saved projects still accept eight layers for compatibility.
- Build's first-run screen now exposes VIDEO / IMAGE, CAMERA, SCREEN, NOTHING → Noise/Grid/Cells/Waves, and Recipe picker. Focus moves into the new source control after selection; live capture asks for permission only on Library START.
- Automated checks cover schema parse, catalog references/ranges, Behavior/Macro/Pad wiring, undo, preservation, UI start path and generator creation. A Noise Grid project also passes the production filesystem write/read path. All 13 recipes were applied and exported in the packaged macOS app at 1080p H.264, 30 fps, 1 second; ffprobe confirmed 30 frames per file and framemd5 found 29–30 unique frames per recipe. This validates local recipe setup and non-static encoded output; long-form exports and other platforms remain outside this matrix.

### Phase I — PLAY experience (implementation complete; hardware validation open)

- Simplify current PERFORM workspace around Looks, Macros, Pads, Morph, Freeze, Mutate, Take and Quantization.
- Reuse current HUD and semantic action/capture seams.
- Validate keyboard and MIDI behavior; maintain accessible non-keyboard controls.
- Existing implementation provides Looks, Macros, Pads, Morph, Freeze, Mutate, Take, quantization and Tab HUD. `tests/keyboard-shortcuts.test.tsx` now exercises performance and workspace key routing, candidate hold/release, modifier guards, text-input safety, and PLAY-only actions. MIDI offline/connected status is covered separately; physical MIDI remains release validation.

### Phase J — Onboarding and polish (implementation complete; accessibility sign-off open)

- Build on existing zero-import generators and empty states.
- Make first-run choices lead directly to a working BUILD system.
- Add only short inline guidance; improve recovery, empty states, hierarchy and focus/accessibility.
- Empty state now offers direct media/capture/generator choices and Recipes. New source selection returns keyboard focus to Library control; CAMERA/SCREEN disclose that START is the permission boundary.
- Empty state itself wraps and scrolls. BUILD side panels collapse on viewports ≤760px and expose 44px Library/Inspector drawer controls; Explore and Output stack their rails below 760px. Explore actions wrap at narrow widths to keep DISCARD and RE-THUMBNAIL reachable. Background viewport becomes inert while a BUILD drawer is open. UI tests cover drawer toggling, inert state, source focus after Recipe start, text-token contrast, defined onboarding hint text token, narrow header reflow, stacked Explore/Output rails and Explore action wrapping. Native View menu exposes Electron Zoom In, Actual Size and Zoom Out roles, covered by a regression test. Live Electron zoom reached 392.5% and 430%: BUILD workspace scrolls while preserving a gap between empty-state card and status rail; Explore/PLAY copy wraps; Output status bar wraps and workspace gains vertical scroll. At 430%, CDP measured a 351px document width with no horizontal overflow; reviewer confirmed Export remains reachable by scrolling. A follow-up fix removes nested Output scroll regions at ≤480px: workspace owns scrolling while Output main and rails expand in flow. The final packaged macOS app was launched with an isolated temporary profile at a 351×220 CSS viewport and visually reviewed from a CDP screenshot. Computed layout showed a 666px Output main followed by an 82px export bar with no overlap; document width stayed 351px and only workspace scrolled. Tab reached focused EXPORT in eight steps and brought it fully into view; both rails stayed at scrollTop 0. Viewport was emulated, not native macOS zoom. Semantic text and action colors now pass WCAG AA contrast against all four base surfaces. Native macOS accessibility tree exposes workspace navigation, Save, Export, Pin, GO TO BUILD and onboarding copy as buttons/text on BUILD empty state; focus/reading order, other workspaces and component-specific contrast backgrounds remain unchecked.

### Phase K — 1.0 freeze

- No major features. Validate export correctness, migrations, crash recovery, color, performance, Windows, physical MIDI, packaging and accessibility.
- Close documented release risks; update user docs and release process.
- Recovery coverage now verifies atomic snapshot replacement, current-session exclusion, v6 project migration without rewriting the stored snapshot, named/unsaved restore semantics, corrupt/future snapshot preservation, and filename/session-ID validation. Audio transport tests now cover file-load failure, downmixed analysis, position clamping, pause/restart and unload cleanup.
- Final local macOS arm64 package rebuilt after keyboard-input, OutputReplica observer, accessibility responsive/focus fixes, undefined onboarding text-token correction, Explore action wrapping, Output chain/primary-param fixes, native View zoom controls and single-scroll narrow Output layout; packaged app's ASAR contains corrected code and passes ad-hoc codesign verification. Electron Builder skipped notarization because notarization options were unavailable, so this artifact is not release-notarized. Windows x64 unpacked app, ZIP and NSIS installer cross-built on macOS arm64 after final responsive changes (`release/win-unpacked/MATERIAL.exe`, PE32+); ZIP integrity passed and executable formats verified. No Wine or Windows runtime is available here. GitHub Actions Windows matrix and packaged runtime smoke passed for repository HEAD `58d2724` (run: https://github.com/ipaud/material/actions/runs/40137956425); current phase delta also passed Windows/macOS CI and Windows packaged runtime smoke (run: https://github.com/ipaud/material/actions/runs/40365448327). All 13 first-run Recipes exported 1-second 1080p H.264 files; ffprobe confirmed 30 fps/30 frames, and framemd5 found 29–30 unique frames per file. Production-build CLI chain exports now cover stateless Mosaic→Mosaic and moving-source Motion RGB→Flow Displace; both repeated exports matched byte-for-byte with identical decoded frames, with fixture hashes and reproduction commands in `TECHNIQUE_CHAINS.md`. A packaged-app UI two-stage export also decoded to 30 distinct frames. Packaged native Output vs decoded H.264 frame comparison found missing chain scratch allocation and primary param application; both are fixed. Fullscreen capture matched decoded H.264 at mean absolute RGB difference 2.694 after composition crop/resize (84.593% exact channels; 94.430% within 2 codes). Latest suite: 135 files, 1855 passed, 5 skipped (1860 total); flow-chain compatibility/schema, BUILD rejection messaging for Generator → Mosaic → Flow Feedback, and v3 migration regressions pass, including retention of primary Mosaic with an empty added-stage chain. Typecheck, lint, build and `git diff --check` passed. The rebuilt macOS CLI identity gate also passed video/image mean-luma parity for all 11 registered built-ins within ±2/255; it does not assert neutral absolute output, and Mosaic/Motion Trails retained expected luminance drift. Current hardware inventory reports Apple M5 Pro with one built-in display and no MIDI endpoints; physical MIDI, second-display testing, uncapped GPU execution profiling on additional hardware, cross-GPU Output parity and assistive-technology matrix remain unverified. Accent, modulation, danger and success text tokens pass AA against all four base surfaces; danger was raised to #dc6b64 after finding a 4.28:1 failure. Windows CI for the current phase delta passes; macOS notarization, global coverage and hardware/accessibility gates remain open, so 1.0 sign-off stays open.

- Final release-candidate dependency refresh stayed within existing semver ranges: Electron 44.9.3, Zod 4.6.7, Vite 7.3.7, Vitest 4.1.12; `npm audit --audit-level=low` reports zero vulnerabilities. Rebuilt macOS arm64 app passes codesign verification and launches; rebuilt Windows ZIP passes integrity check and installer/unpacked executable are valid PE files. Re-ran full suite (137 files, 1855 passed, 5 skipped), typecheck, lint, build, identity gate (all 11 built-ins within video/image parity tolerance), and `git diff --check`. The Windows CI run above verifies packaging and audio smoke on a real Windows runner; local macOS still cannot verify interactive hardware behavior or notarization.
- Instrumented coverage across all `src`, `shared` and `electron` TypeScript files: 51.60% statements, 46.90% branches, 50.84% functions and 52.83% lines. The repository-wide 80% target in `AGENTS.md` is not met, so this remains an explicit Phase K release gate. The temporary V8 coverage provider was not added to project dependencies.

## Required verification per implementation phase

- Focused unit/integration/UI coverage for touched behavior, including legacy project fixtures and deterministic replay where applicable.
- Existing `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` gates.
- GPU preview/export comparison for rendering or evaluator changes; profile expensive UI/render additions against representative projects.
- Manual platform/hardware matrix only where applicable; label untested cases honestly.

## Likely change areas

- Product docs: `README.md`, `docs/ARCHITECTURE.md`, `ROADMAP.md`, `UI_V2.md`, `LAYERS.md`, `DECISIONS.md`.
- State and schema: `shared/schemas/project.ts`, `src/performance/lookCore.ts`, `src/explore/exploration.ts`, stores and project actions.
- User flows: `src/workspaces/`, `src/explore/`, `src/library/`, `src/performance/ui/`.
- Materials/techniques/rendering: `src/materials/`, `src/techniques/`, `src/rendering/layers/`, `src/export/`.
- Focused tests listed in `V1_AUDIT.md`, with new fixtures only for format or migration behavior.

## Explicitly outside this plan

Node graph, accounts/cloud/collaboration, AI generation, mobile, marketplace, traditional editing timeline, arbitrary 3D, complex physics, unlimited layers/effect chains, executable JavaScript plugins, NDI/Syphon/Spout, DMX, projection mapping expansion, tracking/recognition and generic professional-VJ parity.

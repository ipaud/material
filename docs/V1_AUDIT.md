# MATERIAL 1.0 — Repository Audit

- Audit date: 2026-10-25
- Repository version: `0.8.6`
- Project format: v5
Scope: source and docs review plus the repository's existing automated checks. No product code changed.

## Current status

| Check | Result |
|---|---|
| `npm test` | Pass — 119 files, 1,720 passed, 5 skipped |
| `npm run typecheck` | Pass |
| `npm run lint` | Pass |
| `npm run build` | Pass; Vite reports mixed static/dynamic imports for candidate and Take modules and emits large renderer bundles (1.33 MB and 1.49 MB) |

The test runner prints `Not implemented: HTMLMediaElement's load() method`; tests still pass. Build warnings are not failures. No packaged app, GPU pixel gate, physical MIDI device, or hands-on Windows pass was run in this audit.

## Architecture

- Electron main owns filesystem, media probing, FFmpeg, windows and export. Renderer is sandboxed with `contextIsolation`, `sandbox`, and `nodeIntegration: false`; preload exposes the typed IPC bridge. Main validates IPC and project data with Zod.
- React and Zustand own UI and serializable project state. `engineBridge` pushes state into an imperative Three.js/WebGL runtime. Render loop and high-rate parameter work stay outside React.
- `LayerHost` owns composition and compositor; each layer runtime owns one source/technique branch. This reuses one render implementation for preview, output and export.
- Technique definitions and custom shader packs are registry driven. Built-in material catalogue is much thinner: six geometric entries, while custom SVG/raster assets use separate paths.
- Deterministic evaluation, seeded PRNG, frame-time addressing and export replay are explicit contracts. Performance Capture records semantic gestures above the render runtime and shares evaluators with export.
- Project writes are validated and atomic. v1→v5 migrations are explicit; unknown future versions refuse to open. Existing schema defaults make additive fields inexpensive, but structural state changes require migrations and old fixtures.

## Current product and UX

- Product identity and onboarding already position MATERIAL as a local moving-image instrument. README's flow is source → technique → material → modulation → output.
- App already has BUILD, EXPLORE and PERFORM, plus OUTPUT as a fourth workspace. PERFORM includes Looks, macros, action pads, Take strip, quantization and Tab HUD.
- BUILD combines library, viewport, inspector, technique browser and timeline. EXPLORE presents CURRENT, a candidate, a 12-item population strip and actions. Candidate audition uses existing overlay/runtime path, not a second live engine.
- P saves a Look; Looks have thumbnails, slots, project persistence and recall. This is a useful preservation foundation, but it is not yet the proposed universal, unslotted PIN workflow with one-click compare/export-still/Explore-Around actions.
- Explore variations are deterministic partial patches over the selected layer's technique params and modulation shaping. It has locks and seeded generation; it is not the proposed eight-state visual landscape or curated mutation modes.

## Reusable systems

| Product need | Existing system | Reuse / gap |
|---|---|---|
| Preserve and recall | `PinnedLook`, `captureLookCore`, layer looks, thumbnail capture | Keep serialization and recall semantics; add a pin concept only if it adds useful semantics beyond Looks. |
| Temporary mutation | `CandidateRuntime`, `LookCore`, intensity and lock model | Reuse preview isolation and deterministic mutation; candidate differs from Explore's partial patch model. |
| Explore | seeded `generatePopulation` / `mutatePopulation`, parameter locks, thumbnail strip | Extend generation navigation and mutation intent; no new render engine. |
| Morph | `LookCore`, interpolation, `morphRuntime`; preview and export share deterministic semantics | Preserve one-active-morph behavior and evaluator contract. |
| Performance | macros, pads, quantized actions, Looks, Freeze, Takes, minimal HUD | Strong PLAY foundation; map concepts and terms before replacing UI. |
| Serialization | schema validation, `parseProject`, repair path, migrations v1–v5 | Additive features can default; new project-owned creative states need explicit migration and round-trip coverage. |
| Rendering | per-layer runtime, compositor, technique registry, GPU test harness | Preserve runtime ownership and single opaque Normal fast path; technique chains remain a separate high-risk architecture project. |

## Findings and product gaps

1. **Conceptual state fragmentation.** Look is persistent whole-stack state; `LookCore` is mostly selected-layer morph/apply state; Candidate stores a `LookCore`; Explore `Variation` stores a sparse patch. Thumbnails and IDs are separate again. This is not yet one state abstraction. Normalize only where it reduces duplicate serialization or enables a real shared action; do not flatten the distinct runtime roles.
2. **Preservation UX is Look-centric.** Existing `P` and slot behavior are useful. Universal Pins should be evaluated against that behavior and its established shortcut before adding a parallel asset list.
3. **Explore has two different mutation paths.** BUILD/Explore population changes parameters and mappings; Candidate mutation can change selected LookCore with intensity and grouped locks. Their vocabulary, ranges, locks and history are not unified.
4. **Product language is ahead of UI language.** Source/Technique/Material/Modulation remain central. Behavior and BUILD/EXPLORE/PLAY language needs an incremental copy and navigation pass; existing PERFORM has working users, shortcuts and Takes.
5. **Material is intentionally narrow.** Registry has six geometric SDF shapes and custom image/SVG paths. Typography is absent. Rendering repeated glyphs needs an explicit model for font fallback/portability, modulation and GPU cost before UI work.
6. **Technique chains do not exist per layer.** Each layer schema has one technique. Legacy project-level `techniques[]` remains for compatibility, not rendering. Chain support needs ping-pong targets, compatibility rules, export parity, migration and profiling; do not mix into UX cleanup.
7. **Layer cap conflicts with target.** Current implementation and PROJECT_FORMAT enforce eight layers, LAYERS documents the measured reason, while the requested 1.0 direction says four. This is a product tradeoff; no code change should silently lower cap or reject existing eight-layer projects.
8. **Docs contain stale or conflicting status.** ARCHITECTURE calls composition four layers; implementation is eight. ROADMAP still lists some already shipped items as next. UI_V2 documents OUTPUT and PERFORM. README accurately reports v0.8.6 and v5. Reconcile canonical docs before using them as implementation contracts.

## Technical debt and risks

- Build output contains mixed static/dynamic import warnings around `candidateRuntime.ts` and `takeActions.ts`; renderer chunks are large. Measure interaction/startup cost before restructuring imports or splitting chunks.
- Preview/export parity has historically exposed bugs that unit tests miss. GPU identity and technique-specific pixel tests still require the documented real-render harness.
- `LookCore` does not encode every full-composition property. Whole-stack Look capture is in `PinnedLook.layers`; morph core currently represents the selected creative layer plus mappings/triggers. Any generalized snapshot must specify source/layer identity, composition state, behavior routes, seed, timeline and excluded runtime state precisely.
- Typography can introduce cross-machine variation from fonts and glyph rasterization. A fallback/bundled-font/licensing policy is prerequisite to reproducible output.
- Raising or changing layer/technique structure can affect GPU memory and export time. Use existing measured harnesses and representative four/eight-layer compositions.
- Windows has limited manual use; physical MIDI hardware is untested; output temporal history is independent when opened mid-session. These are release-validation risks, not reasons to redesign core architecture now.

## What should remain untouched

- Electron isolation, typed preload bridge, Zod validation and intent-gated device permissions.
- Imperative render ownership outside React; one creative runtime implementation per layer; Output and export resolving shared project state.
- Deterministic seeded evaluation and preview/export semantic parity.
- Performance Capture's position above the runtime and reusable gesture seams.
- Registry-based techniques and shader-pack data model.
- Atomic project writes, explicit migration behavior, recovery and media-path rules.
- Existing user projects and the eight-layer format limit until a deliberate compatibility decision is made.

## Relevant code and tests

- State/schema: `shared/schemas/project.ts`, `src/state/projectStore.ts`, `src/performance/lookCore.ts`, `src/performance/candidateRuntime.ts`.
- Explore/mutation: `src/explore/exploration.ts`, `src/explore/exploreActions.ts`, `src/performance/mutation.ts`, `src/state/exploreStore.ts`.
- UI: `src/workspaces/BuildWorkspace.tsx`, `ExploreWorkspace.tsx`, `PerformWorkspace.tsx`, `src/explore/`, `src/performance/ui/`.
- Render/export: `src/rendering/engineBridge.ts`, `src/rendering/layers/`, `src/techniques/registry.ts`, `src/materials/builtins.ts`, `src/export/exportRunner.ts`.
- Existing focused coverage: `tests/project-schema.test.ts`, `migration.test.ts`, `project-repair.test.ts`, `exploration.test.ts`, `candidate.test.ts`, `morph.test.ts`, `morph-repeat.test.ts`, `take-record-replay.test.ts`, `take-export.test.ts`, `export-determinism.test.ts`, `ui-explore.test.tsx`, plus GPU harness docs.

## Audit boundary

This audit reviews the documented architecture and key state, UI, registry, rendering, migration and export paths. It is not a full visual usability study, GPU benchmark, packaged-app run or hardware compatibility sign-off. No feature implementation begins in this phase.

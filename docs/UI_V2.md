# UI v2 — BUILD / EXPLORE / PERFORM / OUTPUT

UI v2 is a shell and workspace redesign. No engine, data model, project format,
or deterministic behaviour changed: `.material` v1 and v2 projects open exactly
as before.

## The four modes

| Workspace   | Question it answers                   | Replaces                            |
| ----------- | ------------------------------------- | ----------------------------------- |
| **BUILD**   | How is the visual system constructed? | CREATE + TECHNIQUES + MODULATION    |
| **EXPLORE** | What else could this be?              | EXPLORE / Candidate                 |
| **PERFORM** | How does it play live?                | PERFORMANCE                         |
| **OUTPUT**  | How does it leave the app?            | new (export lived only in a dialog) |

### Rationale

The old five tabs exposed the implementation: TECHNIQUES and MODULATION are
_parts of building_, not places you go. Collapsing them into BUILD leaves four
modes that map to intent, and frees the bottom of the window — which now belongs
entirely to the timeline (BUILD) or the performance strip (PERFORM).

Navigation moved into the header. Active workspace = Signal Yellow text plus a
1px underline, never a pill or filled tab, and always with `aria-current` so the
state is not colour-only.

Switch with `⌘⌥1`–`⌘⌥4`. Meta+Alt keeps the workspace keys clear of the
performance keys, which bail out on any modifier — Looks `1`–`9` are untouched.

## Workspace ids and migration

`WorkspaceId` is `'build' | 'explore' | 'perform' | 'output'`. Workspace state is
UI-only and never persisted to a project, but `normalizeWorkspace()` still maps
old ids (`create`/`techniques`/`modulation` → `build`, `performance` → `perform`,
anything unknown → `build`), and `setWorkspace` routes through it. A stale id can
never render a blank shell.

## Visual language

Quiet, precise, technical, editorial. The generated image is the loudest thing
on screen; the interface is the frame around it.

| Token                    | Value                 | Use                                              |
| ------------------------ | --------------------- | ------------------------------------------------ |
| `--surface-0`            | `#08090a`             | app background, viewport well                    |
| `--surface-1`            | `#0d0f11`             | panels                                           |
| `--surface-2` / `-3`     | `#121416` / `#181a1d` | inputs, hover                                    |
| `--border-0` / `-1`      | white 7% / 12%        | hairlines                                        |
| `--border-active`        | yellow 72%            | active framing                                   |
| `--text-0` / `-1` / `-2` | white 92% / 60% / 34% | primary / secondary / labels                     |
| `--accent`               | `#ffd800`             | **Signal Yellow** — active state, primary action |
| `--accent-hover`         | `#ffe238`             | hover on primary                                 |
| `--accent-dim`           | yellow 38%            | gutters, wash                                    |
| `--mod`                  | `#4fb3bf`             | modulated values, CANDIDATE                      |
| `--ok` / `--danger`      | green / red           | connected / error                                |

Colour discipline: yellow = active/system signal, cyan = candidate or
modulation-driven, green = connected, red = error, everything else monochrome.

Also: 2px/4px radii, hairline separators instead of cards, no gradients, no
shadows (small popovers excepted), 4/8/12/16/24 spacing, animation limited to
120ms hover/focus and semantically meaningful pulses.

## OUTPUT and v0.3

Phase A OUTPUT exposes only what v0.2 supports: the render preview, real project
output settings (resolution, background, source, audio), and the existing export
pipeline via `ExportDialog` — there is no second export engine.

Live destinations (Fullscreen, Second Display, Syphon, NDI, Camera Input, Screen
Input) are rendered as disabled, `aria-disabled`, `NOT AVAILABLE · v0.3` rows
with **no handlers at all**. Nothing is faked. The v0.3 work attaches at the
component seams in `src/output/OutputWorkspace.tsx`: `OutputDestinationList`
(inputs and destinations), `OutputPreview` (what a destination shows),
`OutputSettingsPanel` (per-destination settings).

## BUILD (Phase B)

BUILD is the technical creation workspace: header → system path → Library /
Viewport / System Inspector → timeline. All three panels still resize; the
gutters are invisible until hover.

### System path

One line above the viewport, generated from project state — never hardcoded:

```
VIDEO → TEMPORAL MOSAIC → SQUARE → BASS / ONSET / BEAT · 1/4 → OUTPUT
```

| Segment   | Source of truth                                                                | Empty state         |
| --------- | ------------------------------------------------------------------------------ | ------------------- |
| SOURCE    | `composition.sourceId` → source kind (title = file name)                       | `SOURCE`, dimmed    |
| TECHNIQUE | enabled technique; prefixed `TEMPORAL` when `techniqueNeedsTemporal()` is true | `TECHNIQUE`, dimmed |
| MATERIAL  | builtin material name, or the custom asset's file name                         | —                   |
| SIGNALS   | up to three enabled modulation/trigger sources, then `+n`                      | `NO SIGNAL`, dimmed |
| OUTPUT    | static                                                                         | —                   |

Signal Yellow marks only the technique segment — the current core of the
system. Everything else is monochrome, placeholders dimmed.

### Inspector grouping

Technique parameters are presented under conceptual groups instead of
per-technique section names. The mapping lives in
`src/inspector/paramGroups.ts`, keyed by parameter id:

- **STRUCTURE** — grid, counts, scale bounds, spacing, depth, strips, axis
- **SAMPLING** — threshold, contrast, gamma, invert, luminance mappings
- **TIME** — tile mode, offsets, span, step, hold, decay, direction
- **BEHAVIOR** — rotation, jitter, opacity, blend, distribution, mode
- **SIGNALS** — modulation mappings, triggers, macros, MIDI
- **MATERIAL** — shape, colour mode, aspect

Every parameter appears exactly once, and a parameter the table does not know
keeps its own technique section as its group heading — new techniques cannot
silently lose controls (covered by `tests/ui-build.test.tsx`).

### Timeline height

Default 96px, minimum 64px, capped at `38vh` so it can never crowd out the
viewport on a small window. With no media the strip collapses to the 23px hint
line instead of reserving the user's chosen track height for empty space.

### Signal surfaces (no duplication)

Three distinct jobs, one place each:

- **Near the timeline** — live levels (`Meters`) plus the musical readout
  (BAR / BEAT). Glanceable while working.
- **Inspector → SIGNALS** — the relationships: source → target, amount, freeze
  state, triggers, macros, MIDI.
- **SignalMonitor overlay** (`SIG`) — the detailed per-track debug view, opt-in.

### Where the mockup and the app disagree

- The reference library shows a MATERIALS section with `+ New Material`.
  MATERIAL v0.2 has no material library: builtin shapes live in the Inspector
  and custom materials come from an image/SVG source row (`MAT`). No fake
  browser was added.
- The reference inspector shows a single technique name with no selector; the
  real app needs the technique `<select>` (and BROWSE) to switch systems, so
  both are kept in the SYSTEM block.

## Phase status

| Phase | Scope                                                                      | State         |
| ----- | -------------------------------------------------------------------------- | ------------- |
| A     | tokens, header, workspace model, router, App shell                         | done          |
| B     | BUILD: library, system path, viewport chrome, inspector grouping, timeline | pending       |
| C     | EXPLORE: CURRENT/CANDIDATE, population, mutation rail                      | pending       |
| D     | PERFORM: output dominance, looks, macros, actions, status rail, HUD        | pending       |
| E     | OUTPUT: full workspace                                                     | stub in place |
| F     | dialogs, toasts, empty state, small-window QA, accessibility pass          | pending       |

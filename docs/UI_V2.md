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

## OUTPUT (Phase E)

OUTPUT is the delivery workspace: what MATERIAL is producing, where it can go,
how it is delivered.

```
DESTINATIONS         OUTPUT PREVIEW (the one live engine)       PROJECT / SOURCE /
● EDITOR PREVIEW                                                AUDIO / EXPORT
  FILE EXPORT                                                   DEFAULT / STATUS
LIVE OUTPUT — v0.3
○ FULLSCREEN  ○ SECOND DISPLAY
INTEROP — FUTURE
○ SYPHON
──────────────────────────────────────────────────────────────
FILE EXPORT · name · W×H · duration · trust note        EXPORT
```

### Destination model

`EDITOR PREVIEW` (● ACTIVE — it is the live engine) and `FILE EXPORT` (ON
DEMAND) are the only real v0.2 destinations. Future rows are capped at three,
grouped and disabled with no handlers: `LIVE OUTPUT — v0.3` (FULLSCREEN,
SECOND DISPLAY · NOT AVAILABLE) and `INTEROP — FUTURE` (SYPHON · RESEARCH —
deliberately not promised for v0.3).

**Sources are not destinations.** Camera and screen capture were removed from
this rail entirely — they are inputs and belong to BUILD/SOURCE in v0.3. The
taxonomy the UI teaches is `SOURCE → system → OUTPUT`.

### Honest settings

Everything in the right rail is read from real state: project resolution
(plus `SOURCE RES` only when it differs), background, duration, source file +
real probed FPS, audio file + BPM (or NONE). Export resolution/fps/format are
configured per export in the one ExportDialog — the rail labels them `EXPORT
DEFAULT` and offers `CONFIGURE EXPORT` instead of a second settings state
that could diverge. ALPHA lists the two formats that genuinely support it
(PNG sequence, ProRes 4444). STATUS mirrors the real export store
(IDLE / RENDERING n% FRAME x/y / COMPLETE / ERROR / CANCELLED).

### States

Empty project: `NOTHING TO OUTPUT → GO TO BUILD`, EXPORT disabled with a
stated `NO MEDIA` reason, rails stay structurally present. Offline source:
red `MEDIA OFFLINE` chip on the preview header; export eligibility unchanged.

### v0.3 expansion points

`OutputDestinations` / `OutputPreviewPane` / `OutputSettings` /
`OutputStatus` / `OutputExportBar` in `src/output/OutputWorkspace.tsx`. A new
destination is one row in the rail plus its surface in the preview pane; the
shell does not change.

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

## EXPLORE (Phase C)

EXPLORE is the discovery workspace: compare, mutate, keep. It deliberately does
not reuse BUILD's Library/Inspector layout.

```
STAGE (live CURRENT)          CANDIDATE (thumbnail)   RAIL
                              HOLD B TO AUDITION      MUTATION / LOCKS / LINEAGE
──────────────────────────────────────────────────────────
VARIATIONS filmstrip (existing Explore population)
──────────────────────────────────────────────────────────
LOW MED HIGH · MUTATE · MUTATE AGAIN · APPLY · PIN · DISCARD · RE-THUMBNAIL
```

### Rendering strategy — one live engine

There is exactly one RenderEngine. The stage always shows the live output:
CURRENT normally, and the candidate while B is held, through the existing pure
overlay path (`candidateRuntime.resolveOverlay()` consumed by the modulation
runtime). The CANDIDATE pane is the deterministic static thumbnail — never a
second engine. Measured: 120 fps idle, 118.8 fps while auditioning with
playback running, preview→frame 10.2 ms. Two live panes were rejected as pure
cost: the comparison reads better with hold-to-audition on the big stage.

### Semantics preserved

- Candidate lives entirely outside the project; preview never mutates the
  document (regression-tested at the UI path).
- Hold-to-audition only — releasing B (or the pointer) always lands on
  CURRENT. Preview state is also text (`PREVIEWING CANDIDATE`, `ON STAGE`,
  `AUDITIONING`), never colour alone.
- APPLY is the existing atomic commit (quantized only when a beat grid
  exists — that behaviour is candidateRuntime's, untouched).
- The candidate keyboard cluster (G, ⇧G, B, Enter, ⌫) now also works in
  EXPLORE; it was PERFORM-only before. Same handlers, workspace-gated.
- The population strip is the existing Explore population system (counts,
  generate, mutate-around-selected, pin, apply, per-param locks untouched
  under the hood).

### Colour discipline

Yellow = CURRENT / selection / primary action. Cyan = CANDIDATE only. No
filled panels — hairline frames and text labels carry the state.

## PERFORM (Phase D)

PERFORM is the instrument: output on top (60–70% of useful height), a status
rail on the right, then three flat strips — LOOKS 1–9, MACROS, ACTIONS.

```
STAGE (live output + corner overlays)          STATUS RAIL
                                               BAR (largest readout)
                                               BEAT · BPM · TAP · ▶
                                               queue / morph line
                                               SIGNALS  BASS ONSET BEAT
                                               MIDI
LOOKS 01–09
MACROS (large flat sliders)
STATE | MORPH | PADS | CANDIDATE | SYNC
```

### Stage overlays — one chip, priority ordered

Top-left: current look (slot · name · ● modified). Top-right: exactly one
state chip, highest priority wins: `MEDIA OFFLINE > ■ FROZEN > PREVIEWING
CANDIDATE > MORPH → target > QUEUED`. Detail (progress, beats-left) lives in
the rail's queue line, so state never appears in three places.

### Looks

Flat slots separated by hairlines: small thumbnail (30px) kept above a
number+name line — text-first, thumbnail as recognition aid. Active = yellow
top border + yellow number; queued = dashed outline + QUEUED tag; morph
target = cyan top border + MORPH tag; modified = ●; empty = dim number only.

### Macros

Large flat sliders (native range inputs — keyboard/ARIA preserved): name,
big yellow value, and a CC status line in words — `CC21 · LIVE / PICKUP /
FROZEN / OFFLINE` (engine `MappingStatus` mapped 1:1; `waiting` reads as
PICKUP). Right-click learn/rename/reset unchanged.

### Actions

Grouped with 7px labels: STATE (FREEZE → `■ FROZEN` engaged, quiet PIN) ·
MORPH (target, duration, launch) · PADS (Z/X/C/V, real payload names,
imperative 120ms fire flash driven by a `material:pad-fired` DOM event — no
React on the trigger path) · CANDIDATE (compact live shortcut: MUTATE +
intensity/locks, or identity + B·HOLD + APPLY + AGAIN/PIN/✕; full workflow
stays in EXPLORE) · SYNC (quantize segmented, sticky right so it never
scrolls out of view).

### HUD (Tab)

Stage + one 28px line: look · BAR/BEAT/BPM · queue · PREVIEWING CANDIDATE ·
`■ FROZEN` (still a working release button — regression-tested) · MIDI ·
TAB EXIT HUD. Control strips disappear; all keyboard control remains.

### Hot paths

BAR/BEAT/queue/meters are imperative textContent writes at 10Hz; beat pulse
and pad flash are CSS animations restarted imperatively; MIDI and macro
engine paths untouched. Toasts shift left of the rail in PERFORM so they
never cover the BAR readout.

## Phase status

| Phase | Scope                                                                      | State         |
| ----- | -------------------------------------------------------------------------- | ------------- |
| A     | tokens, header, workspace model, router, App shell                         | done          |
| B     | BUILD: library, system path, viewport chrome, inspector grouping, timeline | pending       |
| C     | EXPLORE: CURRENT/CANDIDATE, population, mutation rail                      | pending       |
| D     | PERFORM: output dominance, looks, macros, actions, status rail, HUD        | pending       |
| E     | OUTPUT: full workspace                                                     | stub in place |
| F     | dialogs, toasts, empty state, small-window QA, accessibility pass          | pending       |

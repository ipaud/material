# Release Notes

## v0.9.1 — EACH LAYER ITS OWN TEXT

Fixes for 0.9.0. Same project format: 0.9.1 opens and saves exactly what 0.9.0 does.

- **Two typography layers showed the wrong letters.** Every layer used the texture of the *selected* layer's
  material, so a second typography layer drew the first one's glyphs with its own count and spacing. The same
  happened with two custom-image materials. Each layer now loads its own. Projects with more than one such layer
  render differently from 0.9.0 — correctly. Projects with one are unchanged.
- **Typing in the typography Text field** is now one undo step for the whole edit, not one per key.
- **⇧ + number on an empty Look slot** is one undo step. Undoing it no longer leaves a stray Pin behind.
- **Morphing to a Look saved before chains** keeps the layer's chain the whole way through, instead of fading it
  out and snapping it back at the end.
- **Exports at a size other than the composition** with a technique chain no longer reallocate the chain's
  working buffers on every frame.

## v0.9.0 — CHAINS, RECIPES, A FIRST RUN THAT WORKS

The last feature release before 1.0. Build a visual system, explore what it can become, play it.

- **Technique chains.** A layer can run up to three techniques in a row (BUILD → Add stage). Only combinations that
  render correctly are offered: stateless and flow techniques chain; temporal, feedback and simulation techniques
  stay single, and BUILD says why. Takes, MIDI Learn, modulation and Morph reach each stage's parameters, in the
  preview, on Output and in the export. See [TECHNIQUE_CHAINS](TECHNIQUE_CHAINS.md).
- **Recipes.** Thirteen tested starting points (source, technique, material, a Behavior mapping, a Macro and a trigger
  Pad). A Recipe fills a blank layer or adds one, never overwrites what you built, and one undo takes it back.
- **First run.** The empty screen offers VIDEO / IMAGE, CAMERA, SCREEN, a generator, or a Recipe, and each leads
  straight to a running system. CAMERA and SCREEN ask for permission only when you press START.
- **Pins and Looks.** **P** now saves a Pin: a snapshot kept in the project. **Make Look** gives a Pin one of the nine
  performance slots. Hold **Compare** on a Pin to see it on the output without changing anything; **Explore Around**
  generates variations centred on it.
- **Typography material.** Characters, words or phrases as the repeated material, set in the bundled Noto Sans Mono.
- **Macros.** Each mapping has its own range, curve and invert.
- **PERFORM is now PLAY.** Same workspace, same shortcut (⌘⌥3).
- **Narrow windows and zoom.** BUILD panels become drawers below 760 px, Explore and Output stack their rails, and
  View → Zoom works up to the point where everything still fits and scrolls.

**Projects saved by 0.9.0 do not open in 0.8.x** (project format 7, for the chains). Older builds refuse them
instead of opening them with the chains silently removed. Projects from every earlier version open here unchanged.

**Not 1.0 yet.** Still open before 1.0: macOS notarization (macOS warns the first time you open the app),
physical MIDI and second-display testing, and an assistive-technology pass.

## v0.8.7 — FEEDBACK EXPORTS START FROM THE REAL FRAME

One fix, for an export that did not always match itself.

- **Flow Feedback and Motion Mosh on a video could export a black opening.** About one export in four began from a
  black frame, and because these techniques feed each frame into the next, the black faded out over the first
  frames instead of vanishing. Exporting the same project again could give a different file.
- **Why.** At the first frame the export filled the feedback surface from the video before the video had finished
  decoding that frame. It now waits for the frame first. Every later frame is handled exactly as before, so an export
  that was correct in v0.8.6 is unchanged.
- **Checked** on the packaged app: 30 out of 30 exports start from the real frame (before: about 1 in 4 black), and
  repeated exports of the same project are byte-identical frame by frame.

## v0.8.6 — WINDOWS

MATERIAL now has a Windows build (64-bit): an installer and a portable zip.

- **Same app.** Same engine, same exports, same project files: a project saved on macOS opens on Windows and the
  other way round (relative media paths are stored with `/`).
- **What changes there.** The system window frame and a normal menu bar (File, Edit, View, Window, Help),
  **Ctrl** where macOS uses ⌘, and FFmpeg found on the PATH or where winget, Chocolatey and Scoop put it.
- **Updates on Windows tell you, they do not install.** "Check for Updates…" (Help) says when a newer release exists
  and opens its page. Installing by itself needs a code-signing certificate the project does not have.
- **Not signed.** Windows SmartScreen shows "Windows protected your PC": **More info → Run anyway**.
- **Tested** on a real Windows machine in CI (the suite, the installer build and a start of the app on an audio file),
  not yet by hand: please report what you find.

## v0.8.5 — IT UPDATES ITSELF

MATERIAL now tells you when a newer version exists and can install it for you.

- **Check for Updates…** in the MATERIAL menu, and a quiet check at launch (at most once a day). If there is a new
  release it asks; **Update now** downloads it (progress on the Dock icon), verifies it, and offers **Restart now**
  or **On next quit**.
- **Check for Updates Automatically** in the same menu turns the launch check off. That check is the only
  network request MATERIAL makes by itself.
- Works without an Apple Developer ID: the app verifies size, SHA-256, bundle id, version and signature of what it
  downloads, and swaps the bundle in after it quits. If it cannot (for example it runs from a read-only location)
  it sends you to the download page. Details: [UPDATES](UPDATES.md), [SECURITY](SECURITY.md#updates).
- The restart prompt never offers to restart while an export is running.

## v0.8.4 — EVERY LAYER'S HISTORY EXPORTS

Two more found by the same piece, after v0.8.3 made the preview truthful.

### A temporal technique on a non-selected layer never exported real history

The export asked the *selected* layer whether temporal history was needed.
With a mosaic selected and an Echo on the trail layer, the answer was no, and
the Echo's frame atlas was never written during the export — it sampled
whatever the preview had last left in it, every frame, deterministically.
v0.6.1 fixed exactly this for feedback and left temporal on the old
predicate. The set-wide one had existed, unused, since v0.6. Echo, slit-scan,
step-print, time-field and temporal mosaic on any layer but the selected one
now rebuild their history from exact seeks like the selected layer always
did. Rendered output changes for every project that had one.

### A generator param the record omits takes its definition default

A voronoi written without `contrast` fed that uniform 0 and rendered a flat
0.5. The definition's default is 1. The dark preview of the time hid it.

### v0.8.3's version gate

v0.8.3 was tagged with the app-version test still pinned to 0.8.2 — the bump
came after the last full run. It is correct at 0.8.4; the tag stands.

## v0.8.3 — THE PREVIEW SHOWS WHAT THE EXPORT WRITES

Three faults, all found by making a piece and comparing what was on screen
with what came out of the file. None had a failing test. Each was invisible
to the tests that existed because each side of it was self-consistent.

### The preview was dark

A 128-grey image previewed as 55 and exported as 128. Since the layer
compositor arrived, every mid-tone on screen has been the *linear* value of
what the export writes: every texture and target is an sRGB8 surface the GPU
decodes on read and encodes on write, and the one destination that is not —
the canvas — got a raw copy. White and black were exact, which is why nothing
noticed.

The transfer is now applied at exactly one place, the preview's canvas write.
Export bytes do not change in this release. The preview gets brighter
mid-tones, and they are the right ones: a two-layer `screen` at half opacity
now reads 149 on both sides, the linear blend, encoded once.

Anything you tuned by eye before this release was tuned against a darker
picture than it exports. Open it and look again.

### A Look that changes a layer's source now exports that source

Preview recalled a Look's whole layer stack; export recalled only the primary
layer's parameters. A piece whose three Looks were three Chladni plates
exported as one plate dressed three ways. The export working copy now carries
the stack, follows it through the bridge's own source reconciliation on the
frames a Look lands, and puts the document back when it finishes. Generator
sources only; a Look that switches a layer to a file or live source keeps its
parameters and stays on the source it had (BACKLOG).

### `motion.amount` is a velocity

It was texels per measured frame, and a generator's frame is one display
frame in preview and one export frame in export. The same figure read 2–4×
larger exported, which pushed the calibration envelope into a different
regime: 0.27 live against 0.00 exported for the same seconds, and a Look's
echo rotation went from 11° to 1.5°. The signal is now rescaled to a
reference frame of 1/30 s, so 30 fps export is the identity and every floor
and fixture keeps its meaning.

### Method

`docs/GPU_TESTING.md` gains the **128-grey gate** — file, preview and export
must agree at three points — and the lesson that parameter differencing is
not pixel differencing. Warm the preview before you capture it.

## v0.8.2 — INTERRUPTING A MORPH NO LONGER JUMPS

Start a morph, change your mind halfway, morph somewhere else. Until now the
picture **snapped back to where the first morph began** before setting off
again — measured at 5.62 to 2.00 in a single frame on a two-second morph
interrupted at its halfway point.

Changing your mind mid-morph is the most ordinary live gesture there is, so
this was never an edge case. It happened every time.

The cause: morph state deliberately lives in an overlay and never touches the
saved document until it completes, but an interrupting morph took the
*document* as its starting point — the state from before the morph you were
watching. It now starts from what is on screen, which is what `cancel and keep`
has always committed.

### And export was inventing morphs preview cannot make

Preview holds exactly one morph; starting another replaces it. Export kept a
list where every morph ran to its own end and applied its result, so overlapping
morphs rendered something you could never have seen while performing. With a
trigger firing four times per morph the two disagreed by 2.9.

Export now holds one at a time too. An interrupted morph is cut short and does
**not** apply its target, because it never got there.

### What this changes for you

If a trigger fires morphs faster than they finish, the value now climbs toward
the Look forever without arriving — each morph only gets part of the way before
the next replaces it. That is what you asked for. Export reaching the Look and
holding was the bug.

### How these were found

By differencing preview against export directly: sampling the live parameter
while the transport plays, running the real export evaluator over the same
span, and subtracting. Three morph faults had survived since v0.3 with a fully
green suite, because each side was self-consistent and nothing compared them to
each other.

Worst disagreements: 7.0 → 0.13, 7.0 → 0.06, and a 3.6 single-frame snap →
0.002. The method is written down in `docs/GPU_TESTING.md`.

## v0.8.1 — A FINISHED MORPH SETTLES FIRST

One fix, and it changes what some projects render.

If you have a trigger that morphs to a Look on a repeating beat or bar,
**preview and export were showing you two different pictures.** Preview
sawtoothed forever — climbing toward the Look, snapping back, climbing again —
while export arrived at the Look and stayed there. On a parameter whose whole
range is 0.2 to 6, the two disagreed by 7.0.

Both sides had the same fault, mirrored. The playback tick fires triggers
before it advances the morph runtime, so a morph whose end landed on the next
trigger was destroyed at the exact instant it finished and never committed —
every new morph then started over from the original state. Export applied a
finished morph's result *after* running its trigger scheduler, so a trigger
firing at that instant saw the state the morph left rather than the one it
arrived at.

A morph that has reached its end now settles before anything replaces it, on
both sides. Preview and export agree to the sampling resolution.

The guarantee lives in the morph runtime rather than in the playback tick,
because a morph can be started from a MIDI note, a pad, a Take replay or the
Looks panel, and all of them deserve it.

### If you use a repeating morph trigger

Your exports will change, and they will now match what you see. Nothing else
does.

### Known, measured, not yet fixed

A morph **interrupted before it finishes** restarts from the saved document
rather than from what is on screen, and preview and export disagree about the
result by the same 7.0. That is a different fault with a semantic decision
attached — see `docs/BACKLOG.md`.

## v0.8.0 — A SHOW THAT TRAVELS

A MATERIAL project could not leave the machine it was made on. Media paths were
absolute, relink was one file at a time through a Finder dialog, and nothing
bundled media with a project — so copying a four-layer show to a venue laptop
meant five dialogs and hoping the files came too.

This was hit for real while making the v0.7 creative test: the project pointed
at a scratch directory and had to be repointed by hand before it would open
anywhere.

### Media travels with the project

Paths are now stored **relative when the file lives at or below the project's
own folder**. Move the folder — to a stick, to another machine — and the links
follow. Media that lives elsewhere stays absolute, because a `../../..` chain
out of the project directory is a fragile absolute path rather than
portability.

Nothing in the app sees relative paths: the conversion happens only when
reading and writing the file.

### COLLECT MEDIA

One action copies everything the project uses into `<project>/media/` and
repoints it. The folder becomes the whole show.

Files already inside are left where they are — they already travel, and moving
them would break a layout you chose. Two different files with the same name get
separate copies. Re-collecting a show copies nothing twice.

### RELINK ALL

When something is offline, one button finds all of it in a single folder pick.
It matches on what the project has recorded about each file since v3 — name,
byte size, duration and kind — so a renamed file is found by its bytes and a
re-encoded one by its name.

A source whose best match ties with another candidate **stays offline and says
so**. Nothing is ever silently repointed at whichever file sorted first.

### Also fixed

Collecting a show with one missing file used to throw on that file, abandon the
whole operation, and leave an empty `media/` folder behind. It now gathers what
it can and tells you what it could not.

### Format

No change. Version stays at 5 — a path is a string either way, and a v0.7
project written with absolute paths opens exactly as it did.

### Security

Two channels were added and both open their own dialog, so the renderer never
names a directory. The folder walk is bounded to three levels and 2000 files,
skips dotfiles, and follows no symlinks. No new permission, no network, and no
preload API beyond those two.

## v0.7.1 — THE TAKE EDITOR, AFTER PLAYING IT

v0.7.0 shipped a Take editor that passed every test and was awkward to use.
Recording a real 71-second performance over a real song showed why, and this
release is the four things that showed up.

**Lanes fill the window.** The strip was a fixed 320 pixels whatever the Take's
length. At 71 seconds that is 4.5 pixels a second: two Freeze events two bars
apart drew almost on top of each other, and a point could be seen but not
aimed. Lanes are now fluid, and taller — 26 pixels was sized for a narrow box,
and the same gesture in the same height reads as a flat wobble once it is four
times wider.

**A lane is drawn against its control's range, not its own.** Every lane used
to auto-scale to whatever the gesture happened to cover, so one that moved 0.4
to 0.5 looked exactly as emphatic as one that swept 0 to 1. Two lanes could not
be compared by eye. Now a small gesture looks small, which is the truth.

**The value is on the row that draws it.** Each lane shows what its control is
doing at the playhead, with a marker on the curve at that point. Reading a
performance no longer means looking at the lane and then hunting for the fader.

**A macro fader shows what a Take is playing.** Takes drive macros through an
overlay that deliberately never writes the document, so the fader read 0.00
while the performance had it at 0.85. It now shows both numbers, the way the
layer fader already did when a signal drives it.

### Also fixed

Grabbing a point nudged it before the pointer moved. The renderer inset points
by three pixels and the drag handler did not, and the dot's own centre sat half
a pixel off its anchor. Measured: 4% of a control's range on contact, now zero
in time and one quantisation step in value.

### Not changed

No schema change, no new concepts, no new controls. The editor is still a
ruler, a polyline per control and a tick per event — deliberately not a
timeline. See `docs/BACKLOG.md` for what was left out and why.

## v0.7.0 — PERFORMANCE CAPTURE

MATERIAL can record what you play.

Not the picture, and not the thousands of numbers the engine works out each
frame — the things your hands did. A fader you moved, a Look you recalled, the
instant you hit Freeze. That recording is a **Take**: play it back, edit it a
little, export it.

It is deliberately not a timeline. No clips, no tracks for your footage, no
curve handles, no nested takes. A Take is a performance, and if one needs more
surgery than a handful of edits, recording it again is faster and better.

### Record what you play

Press **REC** (or `R`), press play, and perform. Layer faders, macro sweeps,
Look recalls, Morphs, Freeze, muting a layer, and anything you drive over MIDI.
Press REC again — or stop the transport — and the Take is saved.

Arming and *then* pressing play starts the recording in step with the song, so
your first gesture lands where you meant it. Press REC while the transport is
already running and it starts immediately.

Recording always creates a new Take. Nothing is ever recorded over.

### What it records, and what it works out again

| Recorded | Re-evaluated on every replay |
|---|---|
| Layer opacity you moved | Audio analysis |
| Macro position you swept | Image and Motion Signals |
| A parameter you dragged | Pattern output |
| A Look you recalled | Signal calibration |
| A Morph you launched | Every modulation result |
| Freeze on and off | |
| A layer you muted | |

This split is the whole design. If MATERIAL recorded resolved values instead, a
Take would sound right for about a minute and then start lying: change a
macro's targets and it would still drive the old ones, change a Look and it
would ignore it, load it at a different frame rate and the timing would drift.

Because it records intent, a Take stays alive. Replay it over a different song
and the Signals react to the new song while your gestures stay exactly as you
played them. Edit a macro's targets afterwards and the Take drives the new
ones — which is the point of having macros at all.

MIDI is captured as the control it resolved to, never as device plus CC number,
so a Take replays with nothing plugged in.

### Play it back, and scrub it

Select a Take and press **TAKE** (or `T`). Scrub anywhere and the composition
shows what the Take was doing at that instant — including part-way through a
Morph, and on the correct side of a Freeze.

That works because seeking *reconstructs* rather than rewinds: the baseline is
restored and every event replayed from the origin, while continuous controls
are a pure function of time. Measured: six out-of-order seeks resolve to the
same values as a frame-by-frame walk, twice over, to the digit.

While a Take plays it owns the controls it recorded. Press STOP and the faders
stay where it left them, so you carry on from there rather than from a value
that just jumped.

### Edit, minimally

Press **EDIT** and you get a ruler for the Take's own length, one line per
recorded control, one tick per event.

Drag points, drag events, ⌥-click to delete, **SIMPLIFY** to thin the recorded
points, **TRIM IN / TRIM OUT** to cut to the playhead. Everything is undoable.

Trim does more than it looks: a Take cut to start after its Freeze still
replays frozen, and a lane gets a sample planted exactly at the new boundary so
replay begins at the value the gesture actually had there.

Recording is thinned automatically. A ten-second fader move stores under eight
points instead of six hundred, with a maximum error of 0.004 — about one pixel
of a 300 px fader.

### Export

Export as usual and the selected Take drives the render, evaluated exactly as
it was in preview. Exporting the same range twice gives identical frames.
Exporting a slice of a longer performance gives frames identical to the same
span of the whole thing — including the parts where your automation changed a
feedback or simulation parameter *before* the slice began, because the Take is
evaluated through the export's existing preroll rather than beside it.

### Numbers

| | |
|---|---|
| Recording overhead, two lanes at 60 Hz | within noise of 120 fps (−0.5 %) |
| Replay cost, six lanes | 0.33 µs per frame |
| Simplification | 81.5 % of samples removed, max error 0.00399 |
| Ten-minute Take, six lanes moving continuously | 996 kB |
| 11-minute record/replay/edit soak, 141 cycles | heap 53.0 → 55.3 MB, 120 fps, zero GL errors |

### Format

Project version 4 → 5. The change is additive and `migrateV4toV5` moves no
data; the number exists so a v0.7 project carrying a performance is *refused*
by v0.6.1 rather than opened with the performance silently stripped out. Old
projects open unchanged and gain an empty Take list.

### Not in v0.7

Punch-in and overdub, several Takes at once, loop recording, quantised or
beat-snapped events, curved automation, and recording structural edits — adding
layers, changing sources or techniques, editing routes. Those are composition
changes rather than performance. See `docs/BACKLOG.md`.

Classification: **INTERNAL** — ad-hoc signed, not notarized.

## v0.6.0 — LAYER COMPOSITION

Several visual materials can now coexist in one composition and be played
together. Up to four.

That is a small sentence and a large change. MATERIAL has always been one
source through one technique; from v0.6 a composition is a stack, each layer a
complete instrument with its own source, technique, material, feedback history
and image analysis.

It is deliberately still not a compositor. No nesting, no groups, no
adjustment layers, no timeline, no routing matrix. Four layers, blended
bottom-up, and the ability for one to listen to another.

### Layers

Add up to four. Each carries a blend mode — normal, add, screen, multiply,
difference, lighten, darken — an opacity, mute and solo. Reordering rebuilds
nothing: a feedback surface or a running simulation survives being moved up
the stack, because a layer is identified by what it is rather than where it
sits.

Mute and fade are not the same thing, on purpose. A muted layer is not
rendered at all, so it costs nothing and its history stops advancing. A layer
faded to zero is still rendered, so fading it back up resumes where the
material would have been rather than where it was abandoned. Solo is a view
over both: releasing it restores exactly the stack you had.

### One layer can listen to another

The part worth having. A mapping can read one layer's image and drive
another's:

```
Camera → motion signals → Reaction Diffusion's centre
                        → the video layer's opacity
```

Signals are addressed by layer, never by position, so reordering cannot
silently re-point a route. A layer reacts to itself unless told otherwise,
which means existing projects behave exactly as they did. Layers may form
loops — B reacting to A while A reacts to B — and they settle at one frame of
latency per hop rather than deadlocking, because every visual signal has
always been sampled from the previous frame.

Opacity joined the things a signal can drive, since fading one layer with
another's motion is half the reason to want layers at all.

### One camera, several layers

A live device is acquired once and shown by every layer pointed at it — one
permission, one decode, one calibration envelope, so a Look written against
that camera stays playable on both. Only layers something actually reads from
are analysed; the rest cost nothing.

### Looks are compositions now

A Look captures the whole stack: every layer's source, technique, material,
blend and opacity. Recalling one restores the composition and keeps the
runtimes alive, so a slot press does not visibly reset a feedback layer.
Looks pinned before v0.6 keep doing exactly what they always did — apply to
the selected layer, leave the rest alone.

### Everything downstream follows

Export resolves every layer, not just the selected one. The Output window
composites the same stack from the same code, driven entirely by resolved
values, with no evaluation of its own and no pixel crossing the process.

### Compatibility

Projects are schema v4. A v0.5 project opens as a single layer and renders
**byte-identically** — verified against a v0.5.0 build, not asserted.

### Measured

At 1920×1080 with four heavy techniques, each with its own generator: vsync
throughout, ~0.4 ms of CPU per frame, ~50 MB of layer targets. A single
opaque layer skips the compositor entirely.

Four-layer export with two cross-layer routes: repeat byte-identical,
full-versus-subrange byte-identical, and disabling the routes changes every
frame.

## v0.3.5 — CREATIVE EXPANSION 01

The creative layer. v0.3 made MATERIAL a live instrument; this release gives
it something to play.

### Generate your own material

Seven **generator sources** produce pixels without importing anything:
Noise Field, Wave Interference, Voronoi, Grid, Chladni Field, Reaction
Diffusion and Cellular Automata. They are real sources, not a special case —
anything that works on a video works on them, including temporal techniques,
Patterns, modulation and export.

The practical consequence: MATERIAL now opens to a working instrument with
zero imports and zero permissions.

### Time as a material

**Time Field** treats the past as an image you can shape: a field decides how
far back each part of the frame reaches, so brightness, position or motion can
pull different moments into one picture. **Slit Scan**, **Echo** and **Step
Print** address the same frame history from different angles.

### Feedback

Seven feedback techniques — Zoom, Rotate, Drift, RGB, Kaleido, Displace and
Bloom — that reprocess their own output on a fixed clock. Static image, static
parameters, and the image still evolves.

### Motion

Optical flow, computed on the GPU and shared by every technique that asks for
it: **Flow Displace**, **Motion RGB**, **Motion Trails**, **Directional
Smear**, **Flow Feedback** and **Motion Mosh** — the datamosh look, driven by
real measured movement rather than a random shuffle.

### Simulation

**Reaction Diffusion** and **Cellular Automata** evolve their own state on a
fixed step, seeded and reproducible, usable as techniques or as sources.

### Morph transitions

Morphing between two Looks of different techniques used to snap identity at
the midpoint — a hard cut inside a smooth gesture. Ten transition styles now
cover that moment: Smooth, Cut, Directional, Noise, Pixel, Radial, Zoom,
Displace, Glitch and Luma. Smooth reproduces the old behaviour exactly, and
projects saved before this release replay unchanged.

### 107 presets

Twelve families — Minimal, Temporal, Optical, Geometry, Analog, Digital
Damage, Studies, Live, Performance, Feedback, Motion and Simulation — each
curated against four reference sources rather than one.

### What you can trust

Every system exports deterministically. Repeat an export and you get the same
bytes; export a range out of the middle of a timeline and you get the same
frames a full export would have produced there. That holds for feedback,
frame history, optical flow, simulations and morph transitions — all of which
carry state that could have made it untrue.

### Known limitations

- Live sources (Camera / Screen / Window) have no timeline to seek, so
  sequence and movie export stays unavailable for them; a PNG still is not.
- The Output window renders locally and warms its own state. Feedback,
  history and simulations there start when it opens rather than inheriting
  what the editor has built.
- Preview and export can differ for living systems: during a morph reveal the
  outgoing image is frozen in preview and re-rendered in export, because
  preview must run in real time and export must not depend on where it began.
- Compressed video can decode to slightly different pixels for the same
  timestamp depending on the seek path. The temporal *schedule* is exact; the
  decoder is not.
- Optical flow is single-scale: it reads ordinary movement well and very fast
  movement poorly.
- Reaction Diffusion needs time to mature — its patterns are a process, not a
  frame.
- Runtime state (feedback contents, simulation state, frame history) is never
  written to a project file. Looks and projects carry configuration; the
  image is rebuilt.

### Release classification

**INTERNAL.** Signing is still ad-hoc and the app is not notarized, so this
is not ready for public distribution.

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

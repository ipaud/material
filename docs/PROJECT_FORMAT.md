# Project Format

`.material` files are plain JSON, validated with zod on both read and write.
They are meant to be readable and diffable.

```jsonc
{
  "version": 4,
  "name": "Burnout",
  "sources": [
    {
      "id": "src_a1d8858c",
      "kind": "video",              // image | video | audio | svg
      "path": "/Users/…/take-03.mp4",
      "metadata": { "durationSec": 15, "width": 3840, "height": 2160, "frameRate": 30, "videoCodec": "h264", … }
    }
  ],
  "composition": {
    "sourceId": "src_a1d8858c",
    "audioSourceId": "src_c7441549",
    "width": 3840, "height": 2160,
    "background": "#000000"
  },
  // v4: a composition is a stack of up to four layers, each a complete
  // instrument. Order is bottom-first — layers[0] is underneath.
  "layers": [
    {
      "id": "layer_1",
      "name": "",
      "enabled": true,
      "solo": false,
      "opacity": 1,
      "blendMode": "normal",     // normal|add|screen|multiply|difference|lighten|darken
      "sourceId": "src_a1d8858c",
      "technique": { "id": "tech_1", "techniqueId": "mosaic", "enabled": true, "params": { "columns": 18, … } },
      "material": { "materialId": "square", "colorMode": "source", "params": { "aspect": 1 }, "assetPath": null }
    }
  ],
  "selectedLayerId": "layer_1",
  "material": { "materialId": "square", "colorMode": "source", "params": { "aspect": 1 }, "assetPath": null },
  "modulations": [
    {
      "id": "mod_1", "enabled": true,
      "source": "bass", "target": "maxOffsetSec",
      "amount": 0.6, "min": 0, "max": 1,
      "invert": false, "smoothing": 0.3, "curve": "linear",
      "frozenValue": null
    }
  ],
  "patternSources": [
    {
      "id": "pat_9f31c2ab",       // stable creative identity — seeds probability
      "enabled": true,
      "beatsPerCycle": 4,          // cycle length in BEATS (independent of beatsPerBar)
      "pattern": { "type": "sequence", "values": [0, 1, 0.25, 0.8] },
      "transforms": [{ "type": "fast", "factor": 2 }, { "type": "degrade", "probability": 0.63 }]
    },
    {
      "id": "pat_4c07de55",
      "enabled": true,
      "beatsPerCycle": 4,
      "pattern": { "type": "euclidean", "pulses": 5, "steps": 16, "rotation": 0, "activeValue": 1, "inactiveValue": 0 },
      "transforms": []
    }
  ],
  "triggers": [
    {
      "id": "trig_1", "enabled": true,
      "source": "beat",                 // beat | bar | div:1/8 | onset | marker:<id> | manual
      "action": "pulse",                // pulse | freeze | applyLook | morphToLook | applyCandidate | …
      "targetParam": "scale", "targetMappingId": null, "lookSlot": null,
      "quantize": "off", "cooldownSec": 0,
      "attackSec": 0.01, "holdSec": 0, "decaySec": 0.3, "amount": 0.45, "curve": "easeOut"
    }
  ],
  "timeline": {
    "inSec": null, "outSec": null, "loop": true,
    "bpm": 78.03, "beatOffsetSec": 0.021, "beatsPerBar": 4,
    "markers": [ { "id": "mk_1", "timeSec": 32.5, "label": "DROP" } ]
  },
  "pinnedLooks": [
    {
      "id": "look_1", "createdAt": "…", "label": "ECHO CHAMBER", "note": "",
      "slot": 3, "seed": 1, "thumbnail": "data:image/jpeg;base64,…",
      "techniques": [...], "material": {...}, "modulations": [...], "triggers": [...]
    }
  ],
  "activeLookId": "look_1",
  "morphEvents": [
    { "id": "morph_1", "startTime": 83.07, "endTime": 89.22, "curve": "easeInOut",
      "sourceSnapshot": { "techniqueId": "mosaic", "params": {…}, "material": {…},
                          "modulations": [...], "triggers": [...], "seed": 1 },
      "targetLookId": "look_5" }
  ],
  "midiMappings": [
    { "id": "mm_1", "enabled": true, "deviceId": "…", "deviceLabel": "Novation · Launch Control XL",
      "channel": null, "messageType": "cc", "control": 21,
      "targetType": "param",            // param | macro | triggerAction
      "targetParam": "depth", "action": null, "lookSlot": null, "targetMappingId": null,
      "quantize": "off", "min": 0, "max": 1, "invert": false, "smoothing": 0,
      "curve": "linear", "pickupMode": "pickup", "mode": "absolute" }
  ],
  "macros": [
    { "id": "mac_1", "name": "MEMORY", "value": 0.73,
      "mappings": [ { "targetParam": "maxOffsetSec", "amount": 0.8, "min": 0, "max": 1,
                      "invert": false, "curve": "linear", "enabled": true } ] }
  ],
  "performancePads": [
    { "id": "pad_a", "label": "HIT", "velocityScale": false, "trigger": { … } }
  ],
  "performanceQuantize": "bar",
  "explore": { "lockedParams": ["columns", "mod:mod_1"], "lastSeed": 841295 }
}
```

## Rules

- **Media is referenced, never embedded.** Projects stay small; sources are
  absolute paths. A missing file shows as **MEDIA OFFLINE** in the library and
  can be relinked in place.
- **Writes are atomic** — a temp file in the same directory, then `rename`, so
  an interrupted save cannot truncate a good project.
- **Unknown version = refuse.** `parseProject` throws rather than guessing.
  Migrations belong in that function as the version increments.
- **v1 → v2 migration is automatic and additive.** A v0.1 project keeps its
  visual state exactly; musical fields keep any BPM that was set and gain
  `beatsPerBar: 4` and empty `markers`; every v0.2 system (`triggers`,
  `midiMappings`, `macros`, `performancePads`, `morphEvents`) arrives empty
  rather than invented, and looks gain defaulted identity fields. Migration is
  idempotent and never rewrites the file on disk without an explicit Save.
- **New v2 fields are defaulted, not required.** A v2 project written before a
  field existed still parses — which is how `macros`, `performancePads` and
  `performanceQuantize` were added inside v2 without a version bump.
- **v2 → v3 (Phase 18D) is a version stamp for live sources.** v3 makes
  `sources` a union: file refs (`image` / `video` / `audio`, with `path`) and
  live refs (`kind: "camera"` with a nullable `deviceId`). No v2 field
  changed shape, so the migration only stamps the version; every v1/v2
  project opens unchanged. A camera ref persists CONFIGURATION only — never
  stream, track, permission or resolution state — and opening a project with
  one never touches the OS camera: acquisition happens exclusively on the
  explicit START action.
- **v3 → v4 (v0.6) introduces layers, and is invisible.** A v3 project's
  `composition.sourceId`, `techniques[0]` and `material` become `layers[0]`,
  whose id is the fixed `layer_1` so the migration is deterministic and a
  re-migrated project is byte-identical. `composition.sourceId` is KEPT as the
  project-wide anchor — frame size derives from it, and it is what the
  migration reads — but a layer owns its own `sourceId` from v4 on and does
  **not** fall back to the composition's: a layer with `sourceId: null`
  renders nothing, deliberately, because a silent fallback makes "which source
  is this layer showing" unanswerable. Single-layer output is byte-identical
  to v0.5.0, verified against a v0.5.0 build rather than asserted.
- **`layers` is capped at eight** (`MAX_LAYERS`; four before the activity
  windows, see docs/LAYERS.md).
- **`layer.activity`** (optional, `null` = always active): `{ start, end,
  fadeIn, fadeOut }` in composition seconds; `end: null` is open-ended and
  `end` must be after `start`. Files without it parse unchanged (no version
  bump). It is timeline structure, so a Look does not carry it.
- **`trigger.targetLayerId`** (optional): the layer a pulse drives. Absent =
  the primary layer, which is what an untargeted trigger always did in the
  export.
- **Modulation gained two optional layer ids**, `targetLayerId` and
  `sourceLayerId`, both stored as ids and never indices so reordering the
  stack cannot re-point a route. Absent means "the bottom layer, from its own
  signals", which is what a pre-v4 mapping meant.
- **Looks gained an optional `layers` array** and a `selectedLayerId`. A Look
  pinned before v0.6 has neither and keeps applying to the selected layer
  alone; absence is the record of "this predates layers", not an empty stack.
- **Screen/Window sources (18E) are additive variants INSIDE v3.** The
  source union gained `{kind:"screen", displayId}` and
  `{kind:"window", titleHint}` without a version bump: no existing field
  changed shape, defaults cover both new refs, and a v3 file without them
  parses exactly as before. (A v3 file that USES them will be refused by a
  pre-18E build — the standard cost of additive evolution, same as new
  technique params inside v2.) Window refs persist only the human-readable
  hint — OS capture ids are ephemeral and never written to disk.
- Locked exploration parameters use bare param ids, and `mod:<id>` for
  modulation mappings.
- **Custom shader techniques (v0.5) are additive INSIDE v3.** A technique from
  a shader pack stores the same three things a native one does — a
  `techniqueId`, `enabled`, and its `params` — with the id shaped
  `custom:<packId>:<shaderId>`. No field changed and no field was added, so a
  project that uses one is an ordinary v3 project.

  The project stores a **reference, never the shader source**. Embedding GLSL
  would make a document carry code from elsewhere, would fork silently from the
  pack it came from, and would give a project file a job that belongs to a
  pack. The cost is a dependency: opening a project whose pack is not installed
  shows a clearly-labelled placeholder that passes the frame through, keeps
  every stored parameter value, and restores itself the moment the pack is
  installed. MATERIAL never substitutes a different shader.

  Pack version and content hash are deliberately NOT written into the project.
  A hash in a document is a promise about someone else's file that the document
  cannot keep; the honest statement is which pack and shader were used, which
  is exactly what the id says.

## Pattern sources

`patternSources[]` holds project-global temporal signals; a modulation
mapping consumes one by setting `source: "pattern:<id>"`, exactly like
`"bass"` or `"beat:1/4"`. Only creative definitions persist — compiled
patterns, the clock, diagnostics and probability samples are runtime-only
and can never reach the file (the writer re-validates with the schema, which
strips anything unknown).

| Field | Meaning |
|---|---|
| `id` | Stable identity. Also the deterministic probability lane — see below. |
| `enabled` | Disabled sources persist and contribute nothing. |
| `beatsPerCycle` | Cycle length in beats. Independent of `beatsPerBar`. |
| `pattern` | `constant` · `sequence` · `euclidean` (see PATTERN_ENGINE). |
| `transforms` | Ordered chain: `fast`/`slow`/`reverse`/`rotate`/`every`/`degrade`. |

Format rules specific to patterns:

- **Ids are never rewritten.** They feed the deterministic hash, so a
  renamed id would change what a saved project renders. Duplicate ids are
  therefore REFUSED at parse and write time
  (`Duplicate Pattern source id: pat-a`) rather than silently deduplicated.
- **Transform order is creative meaning.** `fast → reverse` and
  `reverse → fast` are different patterns; serialization never sorts them.
- **Structure vs semantics.** The schema validates shape; `compilePattern`
  remains the authority on semantics (`pulses > steps`, nested `every`). A
  structurally valid but uncompilable pattern still OPENS — it simply
  contributes nothing, and the diagnostic names the error.
- **Orphan mappings are safe.** A mapping pointing at a missing pattern
  loads and resolves neutral; removing a source through the app removes its
  mappings in the same undoable step, so the app never creates orphans
  itself.
- **Pattern sources are project-global** and are NOT captured by looks — see
  [DECISIONS](DECISIONS.md). Looks capture mappings, so two looks can use one
  pattern for different targets and amounts.
- `patternSources` is an additive v2 field: a project written before it
  existed parses with `[]`, exactly like `macros` and `performancePads`.

## Presets

Presets live outside projects, in `userData/presets.json`:

```jsonc
{ "version": 1, "presets": [ { "id": "…", "name": "Echo Chamber", "techniqueId": "mosaic", "params": {…}, "material": {…}, "modulations": [...], "builtin": false } ] }
```

A preset stores technique, material, parameters and modulation mappings — but
**never source media**, so presets travel between projects.

## Media paths, and moving a project (v0.8)

Media paths are stored **relative when the file lives at or below the project's
own directory**, and absolute otherwise:

```jsonc
"sources": [
  { "kind": "video", "path": "media/clip.mp4" },              // travels
  { "kind": "audio", "path": "/Volumes/Drive/song.wav" }      // does not
]
```

The in-memory project always holds absolute paths. Conversion happens only at
the disk boundary, in `electron/filesystem/projectPaths.ts`, so nothing in the
renderer — `material://` approval, probing, relinking — knows relative paths
exist.

Only descendants are relativised. A `../../..` chain out of the project's
directory is not portability: it is a different absolute path written more
fragilely, and moving the folder breaks it just as thoroughly while looking
like it should work.

**COLLECT MEDIA** copies everything the project uses into `<project>/media/`
and repoints it, so the folder becomes the whole show. Files already inside are
left where they are — they already travel, and moving them would break a layout
the user chose. Two different files with the same name get a numeric suffix;
re-collecting the same show copies nothing twice.

**RELINK ALL** appears when something is offline. It walks one folder the user
picks and matches by what the project already records about each file —
`fileName`, `fileSize`, `durationSec` and kind have been in `MediaMetadata`
since v3. A source whose best match ties with another candidate stays offline
and says so; nothing is ever silently repointed.

Neither changes the format version. Relative paths parse as strings, and a
project written by v0.7 with absolute paths opens unchanged.

## Recovery

Autosaves go to `userData/recovery/<sessionId>.json` every 15 s while the
project is dirty. They record the project's original path but are never written
back to it — see [TROUBLESHOOTING](TROUBLESHOOTING.md#recovery).

## Takes (v0.7)

`project.takes` holds recorded performances; `project.activeTakeId` names the
one the transport replays and the panel edits. Both default, so a v4 document
satisfies the v5 shape untouched.

```jsonc
{
  "id": "take_9f3a",
  "name": "TAKE 01",
  "createdAt": "2026-08-31T18:12:04.221Z",
  "startSec": 0,            // composition time the recording began
  "durationSec": 12,        // from the actual STOP, so trailing silence survives
  "lanes": [
    {
      "target": "layer:layer_3f21:opacity",   // never an index
      "samples": [ { "t": 0, "v": 1 }, { "t": 2.4167, "v": 0.15 } ]
    }
  ],
  "events": [
    { "id": "tev_a1", "t": 6, "order": 1, "kind": "morph.start",
      "lookId": "look_22", "morph": { "durationMode": "seconds",
      "durationValue": 2, "curve": "easeInOut" }, "on": null,
      "layerId": null, "origin": "user" }
  ],
  "baseline": {
    "lanes": { "layer:layer_3f21:opacity": 1 },
    "layerEnabled": { "layer_3f21": true },
    "frozen": { "mod_7c": null },
    "lookCore": null,         // present only in Takes that recall a Look
    "activeLookId": null
  }
}
```

Lane times are **relative to `startSec`**, and both `t` and `v` are stored to
four decimals — 0.05 ms against a 16.7 ms frame, and a value error eighty times
under the simplification tolerance the gesture already passed through. It
halves the file: a ten-minute six-lane worst case is 996 kB rather than 1.73 MB.

`order` breaks ties between two events at the same `t`. It is identity, not
position — editing never renumbers it.

`origin` (`"user"` | `"midi"`) is diagnostics. Replay ignores it entirely.

A lane whose `target` does not parse, or names a layer, macro or Look that no
longer exists, goes inert and is reported in the panel. Nothing is ever
silently repointed. Full semantics in [AUTOMATION](AUTOMATION.md).

### Version 5

Version 4 → 5 is a stamp; `migrateV4toV5` changes no data. The number moved so
v0.6.1 refuses a project carrying a Take rather than opening it and stripping
the performance as an unknown key.

## Keyframes

The format reserves room for parameter automation (parameter, time, value,
interpolation) predating v0.7. Nothing writes it — Takes are how MATERIAL
records automation, and they record intent rather than baked values.

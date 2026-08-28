# Project Format

`.material` files are plain JSON, validated with zod on both read and write.
They are meant to be readable and diffable.

```jsonc
{
  "version": 2,
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
  "techniques": [
    { "id": "tech_1", "techniqueId": "mosaic", "enabled": true, "params": { "columns": 18, "maxOffsetSec": 0.9, … } }
  ],
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
- Locked exploration parameters use bare param ids, and `mod:<id>` for
  modulation mappings.

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

## Recovery

Autosaves go to `userData/recovery/<sessionId>.json` every 15 s while the
project is dirty. They record the project's original path but are never written
back to it — see [TROUBLESHOOTING](TROUBLESHOOTING.md#recovery).

## Keyframes

The format reserves room for parameter automation (parameter, time, value,
interpolation), but there is still no keyframe UI and nothing writes them.

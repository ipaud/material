# Project Format

`.material` files are plain JSON, validated with zod on both read and write.
They are meant to be readable and diffable.

```jsonc
{
  "version": 1,
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
  "timeline": { "inSec": null, "outSec": null, "loop": true, "bpm": 120, "beatOffsetSec": 0 },
  "pinnedLooks": [ { "id": "look_1", "createdAt": "…", "label": "Look 1", "techniques": [...], "material": {...}, "modulations": [...] } ],
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
- Locked exploration parameters use bare param ids, and `mod:<id>` for
  modulation mappings.

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
interpolation), but v0.1 ships no keyframe UI and writes none.

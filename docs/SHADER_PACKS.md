# Authoring a shader pack

Everything you need to write a pack, without reading MATERIAL's source.

## Layout

```
MyPack/
  material-pack.json
  shaders/
    liquid.frag
    scan.frag
```

Import copies the manifest and the shader files it declares into MATERIAL's own
storage — nothing else in the folder travels, so a README or a `.git` directory
is simply ignored.

## Manifest

```json
{
  "format": 1,
  "materialShaderVersion": 1,
  "id": "com.yourname.mypack",
  "name": "My Pack",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "What these shaders are for.",
  "shaders": [
    {
      "id": "liquid",
      "name": "Liquid",
      "description": "Domain-warped flow.",
      "file": "shaders/liquid.frag",
      "params": [
        { "id": "amount", "label": "Amount", "type": "float",
          "group": "Structure", "min": 0, "max": 0.2, "step": 0.001, "default": 0.04 },
        { "id": "steps", "label": "Steps", "type": "int",
          "group": "Color", "min": 2, "max": 32, "default": 6 },
        { "id": "mono", "label": "Monochrome", "type": "bool",
          "group": "Color", "default": false },
        { "id": "mode", "label": "Direction", "type": "enum", "group": "Motion",
          "default": "alternate",
          "options": [
            { "value": "alternate", "label": "Alternate" },
            { "value": "same", "label": "Same Way" }
          ] }
      ],
      "presets": [
        { "id": "deep", "name": "Deep", "params": { "amount": 0.12, "steps": 3 } }
      ]
    }
  ]
}
```

| Field | Rule |
|---|---|
| `format` | `1` |
| `materialShaderVersion` | `1` — the [Shader Contract](SHADERS.md) you wrote against |
| `id` | lowercase slug or reverse-domain; must be unique, and cannot be a MATERIAL built-in |
| `version` | semantic, `x.y.z` |
| `shaders[].id` | unique in the pack; a valid GLSL identifier |
| `shaders[].file` | relative to the pack root — no `..`, no absolute paths, no symlinks pointing out |
| `params[].id` | a valid GLSL identifier; becomes `uParam_<id>` |
| `presets[]` | params only |

Unknown fields are ignored, so a manifest written for a later MATERIAL still
loads — but nothing unknown survives into anything the app runs.

### Limits

| | |
|---|---|
| shader source | 256 KB |
| manifest | 256 KB |
| shaders per pack | 64 |
| parameters per shader | 32 |
| enum options | 16 |

## The shader file

Write the body only — the host declares the uniforms, `vUv` and `fragColor`.

```glsl
// Liquid — Shader Contract v1

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 uv = vUv + vec2(hash(vUv * 8.0) - 0.5) * uParam_amount;
  fragColor = texture(uMaterial_source, clamp(uv, 0.0, 1.0));
}
```

See [SHADERS.md](SHADERS.md) for the complete list of what is available.

## Installing

**Shader Packs** in the inspector → **IMPORT PACK**, and choose the folder
containing `material-pack.json`. Your shaders then appear in the technique
picker like any other technique, and their presets alongside the built-in ones.

**RELOAD** re-reads a pack after you have edited it. **REMOVE** uninstalls it —
a project still using it keeps its settings and shows a missing-pack notice
until you reinstall.

## Debugging

- A compile error appears in the inspector with the compiler's message at
  **your** line number. The previously working version keeps rendering while
  you fix it.
- A parameter that does nothing is usually a name mismatch: the manifest `id`
  `amount` is the uniform `uParam_amount`.
- Redeclaring a host uniform is refused by name — delete the declaration, the
  host already made it.
- `RELOAD` after every edit; there is no file watching.

## Sharing

A pack is a folder. Zip it and send it. There is no signing, no registry and no
dependency bundling in v0.5, so a project that uses your pack needs your pack
installed — it will say so clearly if it is not.

## A worked example

`resources/shader-packs/material-starter/` in the MATERIAL repository is a
real pack in this exact format, loaded through this exact loader. Copy it as a
starting point.

# MATERIAL v0.5.0 — Shader Extensibility

**Internal release.** Ad-hoc signed, not notarised.

Until now MATERIAL's visual vocabulary was fixed: whatever techniques shipped
were the techniques you had. This release opens it.

## Shader packs

A **shader pack** is a folder with a manifest and some GLSL. Import one and its
shaders appear in the technique picker beside the built-in ones — not in a
separate "plugins" area, because they are not a separate kind of thing.

A pack is **data and GLSL. There is no plugin code.** Nothing in a pack is ever
executed as a program: it declares shaders and parameters, and MATERIAL builds
everything else. That is what makes it safe to install one from someone else,
and it is a deliberate limit rather than a stage on the way to something bigger.

## Parameters that behave like MATERIAL's own

Declare a parameter in the manifest and you get a real control — and everything
that comes with one:

- **Modulation.** Audio, patterns, beat, MIDI, and the image and motion signals
  from v0.4 all drive pack parameters, in Add or Set mode, with no work from
  the pack.
- **Looks and Morph.** A custom shader is captured by a Look and interpolated by
  a morph, including native → custom and custom → custom.
- **Explore.** Candidate mutation works on custom parameters.
- **Presets.** A pack can ship presets for its own shaders.
- **Output and export.** The Output window compiles the same shader locally and
  renders it; exports are deterministic, the same as everything else.

Moving a slider never recompiles anything.

## Six shaders to start with

**Soft Warp · Scan Bands · Posterise · Ripple · Chromatic Shift · Grain Field**

They ship inside the app in exactly the format you would write by hand — copy
the folder as a starting point for your own pack.

## ISF single-pass filters

MATERIAL imports **ISF image filters**: one image input, one pass, with `float`,
`bool` and `long` inputs, `TIME` and `RENDERSIZE`. An imported ISF file becomes
an ordinary MATERIAL shader, so everything above applies to it too.

The phrase is precise on purpose. Multipass, persistent buffers, multiple image
inputs, generators, audio inputs, colour and point2D inputs are **not**
supported — and an import that hits one of them says which feature stopped it
rather than failing quietly.

## When a shader is broken

- **A compile error** names the shader and shows the compiler's message at
  *your* line number, while the last version that worked keeps rendering. A
  missing semicolon does not black out a performance.
- **A missing pack** — opening a project on a machine without it — passes the
  frame through and says which pack and shader are missing. Your settings are
  kept, and come back when the pack does.

## Honest limitations

- **A shader pack is not sandboxed.** MATERIAL refuses the obvious accidents and
  bounds what a pack may declare, but well-formed GLSL can still overload the
  GPU. Install packs from people you trust.
- Fragment shaders only, one source texture, one pass.
- No colour or position parameter types yet.
- No pack signing, no marketplace, and no bundling a pack into a project file.

## Everything else

Nothing about existing projects changed. The project format is still v3, and a
project written before this release opens and behaves identically.

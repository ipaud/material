# v0.8 — output audit

No implementation. This records what "getting MATERIAL's output somewhere
else" actually costs, because the three obvious readings are three different
projects and the choice should be made on facts.

## What exists today

**The Output window is a second renderer, not a screen.** It receives resolved
configuration (`RenderInputsMsg`) plus per-frame resolved state (`FrameState`)
over a `MessageChannelMain` pair and re-renders the composition locally. It
evaluates nothing.

**No pixel ever crosses a boundary.** This is not incidental — it is written
into `shared/outputChannel.ts`, into `docs/SECURITY.md` ("No compiled program
and no pixel ever crosses that channel"), and into the structural gates in
`tests/take-signature.test.ts` and `tests/layer-output.test.ts`.

**The app has no native dependencies.** `three`, `zod`, `zustand`. Every
renderer runs `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`, `webSecurity: true`.

## What each direction costs

### Syphon — to another app on this machine

Electron 44 *does* support the zero-copy path:
`webPreferences.offscreen.useSharedTexture` delivers an `OffscreenSharedTexture`
(an IOSurface on macOS) to the **main process** on every paint.

Needs:
- a third renderer (offscreen) running the replica — the composition would be
  rendered three times: editor, Output window, publisher;
- a native Objective-C addon linking the Syphon framework, which is the first
  native dependency the project would have, with its own signing and
  notarization consequences;
- explicitly retiring "no pixel ever leaves" as a stated property.

Gains: Resolume, VDMX, MadMapper and OBS all speak Syphon. GPU to GPU, no
encode.

### NDI — to another machine

Everything Syphon needs, plus the NDI SDK (redistribution is licensed),
encoding cost, and a network surface in an app that currently makes no network
requests at all.

### A show file — a project that can leave this machine

Needs no native code, no third renderer, no new permission, and moves no
pixels. Every property above survives intact.

## The finding

**A MATERIAL project cannot leave the machine it was made on.**

Media paths are stored absolute:

```
video  /Users/pauavila/Desktop/IRATI-source-97s.mp4
audio  /Users/pauavila/Desktop/03 Vídeo y audio/Cançó per a Irati (Indie Folk).wav
```

Relink exists (`projectActions.ts:79`) but is one file at a time through a
Finder dialog, and nothing bundles media with a project. Copying a four-layer
show to a venue laptop means five dialogs and hoping the files came too.

This was hit empirically while making the v0.7 creative test: the IRATI project
pointed at a scratch directory and had to be repointed by hand before it would
open anywhere.

## Recommendation

**The show file, before the pixel protocols.**

Not because it is more exciting — Syphon plainly is — but because a pixel
protocol makes a show reach a second application on a machine the show cannot
yet be carried to. Portability is the one that is already broken, is cheap, and
is the precondition for the others being worth having.

Syphon after, as its own version, with the "no pixel leaves" property retired
deliberately and in writing rather than by accident.

---

## Outcome

The recommendation was taken. **v0.8.0 shipped the show file**, and the pixel
protocols remain unbuilt and unbudgeted.

What shipped: relative media paths at the disk boundary
(`electron/filesystem/projectPaths.ts`), COLLECT MEDIA and RELINK ALL
(`electron/filesystem/mediaFolder.ts`, `src/projects/relink.ts`). No format
change, no native dependency, no new permission, and no pixel moved — every
property this audit recorded survives intact.

Verified end to end: import media from one folder, collect, rename the project
folder, delete the original media, reopen. Paths resolved to the new location,
zero sources offline, audio analysed, canvas rendering.

One defect the work found: `collectMediaBeside` threw on the first unreadable
file and abandoned the whole operation, leaving an empty `media/` directory as
its only trace. Found by collecting a real project whose video had been
deleted between sessions.

**Known limit.** The Finder dialog inside `media:pick-folder` is not driven by
any automated test: `contextBridge` freezes the preload object, so it cannot be
stubbed from a live probe either. Everything on both sides of it is covered —
the matcher purely, the folder walk against a real disk, and the apply /
re-probe / recheck path with a stubbed preload — but the `showOpenDialog` call
itself is verified only by having opened it by hand.

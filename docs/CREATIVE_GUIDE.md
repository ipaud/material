# MATERIAL — Creative Guide

What the instrument does, in the language of making images. The engineering
names (`FeedbackSurface`, `SimulationRunner`, `TemporalSource`) live in the
developer docs and never appear in the interface.

## Seven things MATERIAL does

| | |
|---|---|
| **SOURCE** | Where the image comes from: a file, a camera, a screen, a window. |
| **GENERATE** | Make the image from nothing — noise, waves, cells, chemistry. |
| **TRANSFORM** | Reshape the frame you have: grids, geometry, colour. |
| **TIME** | Reach into what already happened. The past as a material. |
| **MOTION** | Use measured movement in the image to drive what happens to it. |
| **FEEDBACK** | Let the image reprocess itself, over and over, on its own clock. |
| **PERFORM** | Play it: Looks, morphs, macros, pads, Patterns, MIDI. |

## Where to start

**With nothing.** Add a Noise Field or a Grid, put a technique on it, and you
have a working instrument — no import, no permission prompt. This is the
fastest way to understand what a technique actually does, because a generator
holds still when you want it to and moves when you ask.

**With footage.** Import a clip, then reach for TIME first. Time Field is the
technique that most changes how people think about the app.

**With a camera.** Camera plus Motion is the most immediate thing MATERIAL
does — the image reacts to you moving, not to a clock.

## Combinations worth knowing

These are the pairings where the systems make each other better, not just
coexist:

| Combination | Why it works |
|---|---|
| **Camera + Motion Mosh** | Datamosh driven by your actual movement. The closer you are to the lens, the more the image tears. |
| **Camera + Time Field (Motion)** | Moving parts of the frame reach further back in time than still ones. The room stays sharp; you smear. |
| **Generator + Feedback** | A generator never stops changing, so feedback never settles. Endless, no source material. |
| **Noise Field + Time Field** | Smooth noise makes the cleanest possible read of what a time field is doing. The best way to learn the technique. |
| **Reaction Diffusion + Mosaic** | Chemistry decides which tiles are big. Organic structure on a rigid grid. |
| **Cellular Automata + RGB Feedback** | Discrete cells, then colour channels drifting apart. Digital and analogue at once. |
| **Grid + Motion** | Hard geometry is where flow displacement is most legible — you can see exactly what moved. |
| **Morph between two Generators** | Two procedural worlds, one transition style. No media, fully deterministic, exports frame-exact. |

## Signature MATERIAL techniques

Not the most technically impressive — the ones that feel like this instrument
and not a plugin folder.

1. **Time Field (Luma)** — brightness decides how far back each part of the
   frame reaches. One image containing many moments, organised by light.
2. **Time Field (Motion)** — the same idea driven by movement instead. What
   moves, remembers.
3. **Motion Mosh** — datamosh from measured optical flow rather than a random
   block shuffle. It tears where the image actually moves.
4. **Flow Feedback** — feedback that follows motion instead of a fixed
   transform. The trails have direction because the image gave them one.
5. **Feedback Zoom** — the oldest trick in video, done on a fixed clock so it
   behaves the same in preview and in export.
6. **Reaction Diffusion + Pattern** — chemistry with its parameters on a
   rhythmic grid. Slow biology, hard timing.
7. **Generator → Temporal** — a procedural source addressed backwards in
   time. Nothing was recorded, and there is still a past to reach into.
8. **Snapshot morph transitions** — the frame you were looking at is held
   still while the next one arrives through it.

## What MATERIAL will not do

It has no node graph, no layers and no effect marketplace. One source, one
technique, one image — and everything else is about playing that well.

# Performance Capture

MATERIAL can record what you play.

Not the picture, and not the thousands of numbers the engine works out each
frame — the things your hands did. A fader you moved, a Look you recalled, the
instant you hit Freeze. That recording is a **Take**, and a Take can be played
back, edited a little, and exported.

## Why it works this way

A performance is a set of decisions, not a set of pixels.

If MATERIAL recorded every resolved value of every frame, a Take would be a
huge, opaque block of numbers. It would sound right for about a minute and then
start lying: change a macro's targets and the Take would still drive the old
ones; change a Look and the Take would ignore it; load the project on a machine
with a different frame rate and the timing would drift.

So a Take records **intent**, and everything MATERIAL can work out for itself
is worked out again on replay:

| Recorded | Re-evaluated on every replay |
|---|---|
| Layer opacity you moved | Audio analysis |
| Macro position you swept | Image and Motion Signals |
| A parameter you dragged | Pattern output |
| A Look you recalled | Signal calibration |
| A Morph you launched | Every modulation result |
| Freeze on and off | |
| A layer you muted | |

That is why a Take stays alive: replay it against a different song and the
Signals react to the new song while your gestures stay exactly as you played
them.

## Recording

1. Select or load whatever you want to perform on.
2. Press **REC** (or `R`). It arms.
3. Press play. Recording starts with the transport, so your first gesture lands
   in time with the music.
4. Perform. Move layer faders, sweep macros, recall Looks, launch Morphs, hit
   Freeze, mute a layer.
5. Press **REC** again, or stop the transport. The Take is saved.

If the transport is already running when you press REC, recording starts
immediately.

**Two things end a recording.** Seeking, because a Take's time has to run
forwards; and stopping the transport. Both keep what you played. Looping is
switched off while you record and switched back afterwards.

Nothing is recorded that you did not do. A beat-driven trigger, a Signal
driving a parameter, a Pattern stepping through values — none of it lands in a
Take, because none of it needs to: it happens again by itself.

## Playing a Take back

Select it and press **TAKE** (or `T`). Scrub anywhere and the composition
shows what the Take was doing at that instant, including part-way through a
Morph.

While a Take is playing it owns the controls it recorded. To take over, press
STOP — the faders stay where the Take left them, and you carry on from there.
Playing from the beginning always restores the state the performance started
from.

Selecting a different Take, or recording a new one, stops playback.

## Editing a Take

Press **EDIT** on the selected Take. You get a small strip: a ruler for the
Take's own length, one line per recorded control, one tick per event.

- **Drag a point** to change when or how much.
- **Drag an event tick** to move it in time; **⌥-click** to delete it.
- **SIMPLIFY** thins the recorded points without changing the gesture.
- **TRIM IN / TRIM OUT** cut the Take to the playhead.
- **✕** on a line deletes that whole control's automation.

Every edit is undoable.

This is deliberately not a timeline. There are no clips, no tracks for your
video, no curve handles. If a Take needs more surgery than this, record it
again — it is faster, and it will be better.

## Several Takes

A project holds as many Takes as you want. Only one plays at a time. Double-
click a name to rename it, **⧉** to duplicate, **✕** to delete (undoable).

Recording always makes a new Take. Nothing is ever recorded over.

## Exporting

Export as usual. The selected Take drives the render, evaluated exactly as it
was in preview: same gestures, same timing, and the Signals, Audio and Patterns
re-evaluated against the exported timeline. Exporting the same range twice
gives identical frames, and exporting a slice of a longer performance gives
frames identical to the same span of the whole thing.

## If something is missing

Delete a layer or a Look a Take referred to and the Take still opens — the
panel says how many of its events no longer have a target, and those events do
nothing. Put the layer back and they work again. A Take is never silently
repointed at whatever happens to be in that slot now.

## What is not in v0.7

Punch-in and overdub, several Takes at once, loop recording, quantised or
beat-snapped events, curved automation, and recording structural edits (adding
layers, changing sources or techniques, editing routes). Those are composition
changes rather than performance, and they are listed in `docs/BACKLOG.md`.

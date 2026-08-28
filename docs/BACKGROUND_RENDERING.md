# Background & Minimized Rendering

What keeps running when MATERIAL's window is not in front — measured, not
assumed. This matters because MATERIAL is an instrument: a performer may put
the editor behind a set list, on a second display, or out of the way
entirely, and the show must not stop.

## The three throttling layers

A frame loop in Electron can be stopped by three independent mechanisms, and
they are easy to confuse:

1. **Chromium background throttling.** When a page is backgrounded, Chromium
   throttles `requestAnimationFrame` and timers. Disabled for our window with
   `webPreferences.backgroundThrottling: false`.
2. **Page visibility.** A hidden document stops `requestAnimationFrame`
   entirely and sets `document.visibilityState = "hidden"`.
3. **macOS App Nap.** The OS suspends an application's timers when it decides
   the app is inactive — hidden or fully occluded, no audio, little work.
   This happens *below* Chromium: `backgroundThrottling: false` does not
   affect it, and `document.visibilityState` still reports `"visible"`.

Layer 3 is the one that bit us, and it is the reason the first symptom looked
impossible ("the document says it is visible, but rAF is dead").

## Measured behaviour (macOS 15, Electron 44, ProMotion display)

Method: a 3-second rAF counter plus audio-clock and video-clock deltas,
driven over CDP so the measurement itself never focuses the window. Scene:
BALAS video + audio, ECHO CHAMBER look, temporal engine active.

| State | rAF | Audio clock | Video | Modulation | Temporal cache |
| --- | --- | --- | --- | --- | --- |
| Visible + focused | 120 fps | exact | exact | ✓ | advancing |
| Visible, another app focused | 120 fps | exact | exact | ✓ | advancing |
| Fully obscured by another window | 120 fps | exact | exact | ✓ | advancing |
| Minimized (AXMinimized) | 110 fps | exact | exact | ✓ | advancing |
| App hidden (⌘H) **while playing** | 120 fps | exact | exact | ✓ | advancing |
| App hidden **while paused, then idle** | **~1 fps** | n/a (paused) | n/a | 1 Hz | idle |

Two results are worth stating plainly because they contradict the obvious
guesses:

- **Minimizing is not the problem.** A minimized window keeps rendering at
  full rate. The Phase 16 observation that blamed minimization was wrong.
- **Audio playback inhibits App Nap.** Hiding the app while a track is
  playing changes nothing at all. The failure needs the app to first look
  idle to the OS.

### The failure mode that mattered

Once App Nap has engaged (app hidden, playback paused, idle for a while),
**starting playback does not recover the frame rate**. Measured: rAF stayed
at 1 fps while the audio clock advanced 3.003 s in 3 s. Output freezes under
a running track — exactly the situation a performer would hit by hiding the
editor and then starting the set from a controller.

App Nap engagement is not deterministic on a timer; it depends on the OS's
own idleness accounting. It reproduced after the app had been hidden and
paused, untouched, for several minutes.

An honest caveat about verifying the fix: a *scripted* soak cannot reproduce
the failure, because the CDP evaluation used to measure frame rate is itself
activity — polling the app every minute keeps App Nap from ever engaging. Six
minutes of hidden-and-paused soak stayed at 120 fps purely because it was
being watched. The fix is therefore verified at the mechanism level (the
`prevent-app-suspension` blocker is confirmed held while the transport runs
and released when it stops) rather than by re-triggering the original
symptom.

## Product decision

**While playback runs, MATERIAL stays fully live regardless of window
state.** Playing is the declaration that this is a performance, so the app
holds a macOS `prevent-app-suspension` power-save blocker for exactly as long
as the transport is running (`PlaybackController.play()` acquires it,
`pause()` releases it). Nothing is held while the editor sits idle, so a
paused MATERIAL naps like any well-behaved Mac app.

**While paused and hidden, the OS may throttle the editor preview.** Nothing
is playing, so nothing is lost: the document is authoritative, all state is
deterministic, and full rate returns on the next play. This is option B from
the phase brief, with the important half fixed — the transport, not the
window, decides whether the engine is live.

Explicit guarantees:

| Situation | Behaviour |
| --- | --- |
| Unfocused or covered | Everything continues normally |
| Second display | Everything continues normally |
| Minimized | Everything continues normally |
| Hidden while playing | Everything continues normally |
| Hidden while paused | Preview may throttle; state intact; play restores full rate |
| Export running | Preview rendering is paused deliberately (see EXPORT_PIPELINE.md) |

## Why not an offscreen/worker render loop

The alternatives considered — a dedicated hidden output window, an
OffscreenCanvas worker loop, timer-driven composition evaluation separate
from the UI's rAF — all solve a problem we do not have once the blocker is
in place, and each adds a second render path to keep deterministic. The
measured evidence says one renderer plus a suspension inhibitor is enough for
v0.2.

The separation those options would buy still matters for the future
(fullscreen output, second-display output, Syphon), and the current
architecture does not block it: the engine already renders from pushed state
rather than from React, `renderStill` already draws a complete frame
offscreen for thumbnails and export, and the transport already owns the
liveness signal. A future dedicated output window can subscribe to the same
engine without changing the evaluation pipeline.

## Limitations

- Verified on macOS only. Windows and Linux have different suspension
  policies; the blocker call is harmless there but its necessity is untested.
- The blocker prevents *app suspension*, not display sleep. If the screen
  sleeps, the compositor may stop presenting frames; the audio clock and all
  deterministic state continue, and rendering resumes on wake.
- A paused, hidden editor genuinely does throttle. That is deliberate.

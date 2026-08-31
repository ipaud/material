# Keyboard Shortcuts

Everything MATERIAL binds, grouped by what you are doing. Bare keys work
anywhere except while typing in a field; ⌘ shortcuts come from the app menu.

## Workspaces

| Key   | Action                              |
| ----- | ----------------------------------- |
| `⌘⌥1` | BUILD — construct the visual system |
| `⌘⌥2` | EXPLORE — discover variations       |
| `⌘⌥3` | PERFORM — play the system           |
| `⌘⌥4` | OUTPUT — prepare and deliver        |

## Transport

| Key            | Action                                     |
| -------------- | ------------------------------------------ |
| `Space`        | Play / pause                               |
| `` ` `` (hold) | A/B — show the untouched source while held |

## File & edit (menu)

| Key   | Action                                                     |
| ----- | ---------------------------------------------------------- |
| `⌘N`  | New project                                                |
| `⌘O`  | Open project                                               |
| `⌘S`  | Save                                                       |
| `⌘⇧S` | Save as                                                    |
| `⌘I`  | Import media                                               |
| `⌘E`  | Export                                                     |
| `⌘⇧F` | Display output — fullscreen / windowed                     |
| `⌘Z`  | Undo                                                       |
| `⌘⇧Z` | Redo                                                       |
| `⌘D`  | Toggle the debug overlay (fps, frame time, instance count) |

## Looks (everywhere)

| Key       | Action                                     |
| --------- | ------------------------------------------ |
| `1`–`9`   | Apply the Look in that slot                |
| `⇧1`–`⇧9` | Overwrite that slot with the current state |
| `P`       | Pin the current state as a new Look        |
| `F`       | Freeze all modulated values / release them |
| `R`       | Arm recording — starts with the transport; stops it if recording |
| `T`       | Play / stop the selected Take               |

`R` and `T` are Performance Capture (`docs/PERFORMANCE_CAPTURE.md`). Arming
and pressing play starts the recording in step with the song; pressing `R`
while the transport already runs starts it immediately.

In the PERFORM workspace, `1`–`9` obey the global quantization: the Look
arrives on the next beat or bar rather than instantly.

## PERFORM workspace only

| Key             | Action                                                                     |
| --------------- | -------------------------------------------------------------------------- |
| `Q`             | Cycle quantization (Off → Beat → Bar → 2 Bars → 4 Bars)                    |
| `M`             | Morph to the selected target Look                                          |
| `Z` `X` `C` `V` | Trigger pads 1–4                                                           |
| `Tab`           | Minimal HUD                                                                |
| `Esc`           | Cancel queued actions; with nothing queued, cancel-and-keep an armed morph |

Right-click a Look tile to make it the morph target.

## Candidate (EXPLORE and PERFORM workspaces)

| Key                    | Action                                               |
| ---------------------- | ---------------------------------------------------- |
| `G`                    | Mutate — generate a candidate from CURRENT           |
| `⇧G`                   | Mutate again, using the candidate as the parent      |
| `B` (hold)             | Audition the candidate; releasing returns to CURRENT |
| `Enter`                | Apply the candidate (obeys quantization)             |
| `Backspace` / `Delete` | Discard the candidate                                |

`B` is held rather than toggled on purpose: whatever happens, letting go puts
CURRENT back on the output.

## Notes

- Shortcuts are ignored while a text field, number field or dropdown has
  focus, so typing a Look name never fires a pad.
- `⌘`, `⌃` and `⌥` combinations are reserved for the menu; the performance
  keys are deliberately bare so they can be hit without looking.
- `C` is a trigger pad, not candidate preview — the candidate uses `B` (A is
  CURRENT, B is the other side).

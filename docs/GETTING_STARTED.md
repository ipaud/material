# Getting Started

A practical run through MATERIAL, from an empty window to an exported file.
Roughly fifteen minutes end to end.

## 1. Import media

Drag a video (or image, or SVG) onto the window, or `⌘I`. Drop an audio file
too — MATERIAL analyses it offline and the whole musical side of the app
depends on it.

The video is your SOURCE. Audio drives modulation and the beat grid.

## 2. Apply a technique

The right-hand Inspector opens on the active technique. **Mosaic** is the one
to start with: it rebuilds the frame from a grid of elements.

Move **Columns** and **Rows** to set the grid, **Scale** and **Spacing** for
the elements. Under MATERIAL, a parameter is never a filter setting — it is a
rule about how the image is reconstructed.

Press `Space` to play.

## 3. Make it listen to the music

In the Inspector, **Modulation → + ADD MAPPING**. Pick a signal on the left
and a parameter on the right:

```
Bass  →  Scale
```

Set **Amount** to taste. The element size now follows the low end. Amount is
signed, so a negative value makes the image shrink on the beat instead.

Useful starting pairs: `Bass → Scale`, `Onset → Jitter`, `Master → Threshold`,
`Centroid → Rotation`.

## 4. Get on the grid

In the timeline: **DETECT** analyses the tempo, **TAP** lets you tap it in.
Detection is advisory — your manual value always wins. The readout shows
`BAR 021 · BEAT 3 / 4`.

With a grid you unlock everything musical: quantized changes, bar-length
morphs, beat pulses.

Add a beat pulse in **Triggers → + ADD TRIGGER**: source `Beat`, action
`Pulse Parameter`, target `Scale`. Pulses ride *on top* of modulation, so the
image can breathe with the bass and still snap on the beat.

## 5. Pin some Looks

When something works, press `P`. That is a Look: technique, parameters,
material, modulations, triggers and seed, captured together with a thumbnail.

Pin five or six contrasting ones. Keys `1`–`9` recall them instantly.
`⇧1`–`⇧9` overwrites a slot with what is on screen now.

A Look you have drifted from shows `●` — press **Update** to fold the changes
in, or leave it and the stored Look stays untouched.

## 6. Morph between them

In the Looks panel, choose a target and a duration in bars, then **MORPH**.
MATERIAL interpolates everything it can: numbers glide, techniques and
materials switch cleanly at the midpoint, modulation amounts cross-fade.

A four-bar morph from a clean grid into a temporal look reads as an
arrangement change, not a crossfade. Cancel at any point keeps whatever is on
screen at that moment.

## 7. Enable MIDI

Inspector → **MIDI → ENABLE MIDI**. Connected controllers appear by name.
Nothing is requested until you ask for it, and sysex is never requested.

## 8. MIDI Learn

Right-click any numeric parameter → **MIDI Learn** → move a knob. Bound.

For pads: MIDI panel → choose an action (Freeze, Apply Look 3, Morph to Look
5…) → **LEARN NOTE** → hit the pad.

Knobs take control with **pickup**: a knob whose position disagrees with the
software value waits until you sweep across it, so nothing jumps. After a Look
change the affected knobs go back to waiting — which is exactly what makes
Look switching safe with fixed controllers.

## 9. Perform

Switch to the **PERFORMANCE** tab. The output takes over; below it sit the
nine Look slots, your macros, the actions and the musical readout.

Set **QUANT** to `BAR`. Now pressing `1`–`9` queues the Look and it lands on
the downbeat — the tile shows `QUEUED` and the status line counts the beats
down.

`F` freezes everything modulated. `Z X C V` fire the pads. `Tab` strips the
interface back to output, Looks and macros.

### Macros

A macro is one 0–1 control wired to several parameters at once. Build them in
CREATE (**Inspector → Macros → + ADD**, then **+ TARGET** per parameter);
play them in PERFORMANCE.

This is where MATERIAL's depth folds into something playable. In CREATE you
might have five separate relationships; in PERFORMANCE you have `MEMORY 0.73`,
and behind it four parameters move by different amounts.

Right-click a macro → **MIDI Learn** to put it under a physical knob.

## 10. Mutate

Press `G`. MATERIAL generates a CANDIDATE — a mutation of what is playing —
without touching the output. The strip shows CURRENT on the left and the
candidate on the right.

- Hold `B` to audition it live. Let go and you are back on CURRENT.
- `⇧G` mutates again from the candidate, walking a lineage.
- `Enter` applies it (quantized, so it lands musically).
- **PIN** saves it as a Look without ever putting it on the output.
- `Backspace` discards it.

Use **MUTATION LOW / MED / HIGH** for how far it wanders, and the **LOCK**
buttons to protect what you like — lock `TIME` to keep the temporal feel while
the geometry moves.

## 11. Export

`⌘E`. Choose PNG still, PNG sequence, H.264 or ProRes (4444 carries alpha).

Export is offline and deterministic: it never screen-records. Re-exporting the
same project gives byte-identical output. Live input during an export —
knob moves, pad hits, keyboard — is ignored by design; what exports is the
project's deterministic state, including recorded morphs.

## Where to go next

- [SHORTCUTS.md](SHORTCUTS.md) — the full key map
- [PERFORMANCE.md](PERFORMANCE.md) — macros, candidates, quantization in depth
- [MODULATION.md](MODULATION.md) and [TRIGGERS.md](TRIGGERS.md) — the signal systems
- [PARAMETER_EVALUATION.md](PARAMETER_EVALUATION.md) — exactly how a final value is assembled

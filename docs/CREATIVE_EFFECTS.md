# Creative Effects Inventory

The product's creative architecture map (CE1x). One row per technique;
cost classes are MEASURED, not guessed.

## Primitives

| Primitive | State | Location |
|---|---|---|
| HISTORY | temporal atlas (56×256×144, ~7.9MB) | rendering/temporal |
| FEEDBACK | ping-pong pair at composition res (~16.6MB @1080p) | rendering/feedback |

## Techniques

| Technique | Family | Primitive | Passes | Persistent | Live | Export | Cost |
|---|---|---|---|---|---|---|---|
| Mosaic | space | HISTORY (tile mode) | 1 | atlas | ✓ | ✓ det. | LIGHT |
| Echo | time | HISTORY | 1 | atlas | ✓ | ✓ det. | LIGHT |
| Step Print | time | HISTORY | 1 | atlas | ✓ | ✓ det. | LIGHT |
| Slit Scan | time | HISTORY | 1 | atlas | ✓ | ✓ det. | LIGHT |
| Feedback Zoom | feedback | FEEDBACK | 1+1 step | surface | ✓ | ✓ det. (preroll) | LIGHT (0.3ms) |
| Feedback Rotate | feedback | FEEDBACK | 1+1 | surface | ✓ | ✓ det. | LIGHT |
| Feedback Drift | feedback | FEEDBACK | 1+1 | surface | ✓ | ✓ det. | LIGHT |
| Feedback Displace | feedback | FEEDBACK | 1+1 | surface | ✓ | ✓ det. | LIGHT (0.2ms) |
| Feedback Kaleido | feedback | FEEDBACK | 1+1 | surface | ✓ | ✓ det. | LIGHT |
| Feedback Bloom | feedback | FEEDBACK +4 bloom | 1+5 | surface+3 aux | ✓ | ✓ det. | MEDIUM (0.3ms) |
| RGB Feedback | feedback | FEEDBACK | 1+1 | surface | ✓ | ✓ det. | LIGHT (0.1ms) |

All feedback params (persistence/injection/mix + per-variant) are standard
definitions: Pattern/audio/beat/MIDI/macros modulate them with no special
branches. Measured on M-series @1080p comp: every feedback technique holds
120fps in the editor (frame 0.1–0.3ms after the pixelRatio fix).

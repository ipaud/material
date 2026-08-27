# Material API

A **material** is the element a technique repeats. Materials are orthogonal to
techniques: Mosaic decides *where* elements go, the material decides *what they
look like*.

## Built-in shapes

Drawn as signed distance fields in the fragment shader, so they stay crisp at
any scale and cost no geometry.

| id | shape |
|---|---|
| `square` | filled cell square |
| `circle` | filled circle |
| `line` | thin horizontal bar |
| `dot` | small centred circle |
| `rectangle` | wide rectangle |
| `triangle` | equilateral, pointing up |

Adding one means adding a branch to `sdShape` in
`rendering/shaders/chunks.ts` and an entry in `materials/builtins.ts`. **The
index in `BUILTIN_MATERIALS` must match the `shapeId` in the GLSL branch** —
they are two halves of the same enum.

## Custom materials (`materialId: 'custom'`)

Any imported SVG or raster image becomes the repeated element.

- **SVG** is read through `media:read-svg`, which strips `<script>`,
  `<foreignObject>`, inline event handlers, `javascript:` URLs and external
  references in the main process, then rasterizes it through an `<img>` — where
  Chromium already disables scripting and external loads. Two independent
  layers, because imported SVG is untrusted input.
- **Raster** (PNG/WebP, alpha preserved) is loaded over `material://`.

Both are contain-fit into a 512² transparent atlas texture, so aspect ratio is
preserved and the element footprint stays square in the grid.

## Colour modes

| mode | result |
|---|---|
| `source` | element filled with the colour sampled from the source cell |
| `mono` | element filled with a single colour |
| `original` | the material's own colours (custom materials only) |
| `sourceColor` | material colours tinted by the source cell |

## Video Tile

Not a material in the registry — a **mode of the Mosaic technique**
(`tileMode: 'tile'`). Each cell renders the source frame itself, optionally at
a different moment in time. It uses the same square-footprint rule as texture
materials, and composes with every other Mosaic parameter: grid, spacing,
threshold, rotation, jitter, depth and modulation.

See [TEMPORAL_ENGINE](TEMPORAL_ENGINE.md) for how the past frame is addressed.

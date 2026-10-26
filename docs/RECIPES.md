# Recipes

Recipes are project starters, not technique presets. Each applies a generator,
technique, material, image/motion Behavior, one Macro, and one trigger Pad using
existing project-state and render paths. Nothing is hidden after start: source,
parameters, mapping, Macro and Pad remain editable in BUILD and PLAY.

Starting a Recipe fills a genuinely empty layer or adds a layer while keeping
occupied layers intact. The operation is one undo step. New systems are limited
to four layers; old projects with up to eight still open and render.

## Initial collection

| Recipe | Source | Technique | Material | Category |
| --- | --- | --- | --- | --- |
| Noise Grid | Noise Field | Mosaic | Square | Minimal |
| Interference Dots | Wave Interference | Mosaic | Dot | Organic |
| Crystal Map | Voronoi | Mosaic | Circle | Geometry |
| Lattice Lines | Grid | Mosaic | Line | Geometry |
| Chladni Script | Chladni Field | Mosaic | Typography | Typography |
| Weather Type | Noise Field | Mosaic | Typography | Typography |
| Cellular Orbit | Cellular | Mosaic | Circle | Organic |
| Chemical Bloom | Reaction Diffusion | Mosaic | Dot | Organic |
| Motion RGB | Wave Interference | Motion RGB | Rectangle | Motion |
| Liquid Letter | Noise Field | Flow Displace | Typography | Typography |
| Soft Smear | Voronoi | Directional Smear | Line | Motion |
| Chladni Flow | Chladni Field | Motion RGB | Triangle | Motion |
| Voronoi Smear | Voronoi | Directional Smear | Rectangle | Glitch |

`tests/recipes.test.ts` validates each generated project against the project
schema, checks catalog references and parameter IDs/ranges, and covers
in-memory round-trip, filesystem save/reopen for Noise Grid, undo and
preservation of an occupied layer.
`tests/ui-onboarding.test.tsx` covers Recipe and generator start paths.

## Validation evidence and remaining work

The packaged macOS app exported all 13 starters at 1920×1080, H.264, 30 fps,
one second. `ffprobe` reported 30 frames per output; frame-md5 found 29–30
distinct frames, so every starter moved pixels. `docs/V1_PLAN.md` records this
manual matrix. Export files were temporary and are not checked into the repo.

`tests/recipes.test.ts` also saves and reopens Noise Grid through the production
project file helpers, proving serialized recipe state survives atomic write and
read. The file round-trip is representative of the shared project format, not
a separate filesystem test for all 13 recipe definitions. Per-recipe
deterministic variation is not separately tested.

For repeatable chain export evidence, `tests/fixtures/noise-grid-chain.material`
rendered twice through the production CLI to identical H.264 bytes. Both files
were 1920×1080, 30 fps, 30 frames; SHA-256 was
`527a94899d9c6439fc127ab6a56d4e6e5133ff9faf73d5ffd18fbe6654819206`, and decoded
frame-md5 streams matched. Artifacts were stored in `/tmp` and are not retained.

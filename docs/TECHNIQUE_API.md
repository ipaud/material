# Technique API

A technique is a definition plus a renderer. Adding one touches no engine code.

## 1. Define parameters

```ts
// src/techniques/my-technique/definition.ts
import type { TechniqueDefinition } from '../types';
import { MyRenderer } from './MyRenderer';

export const myDefinition: TechniqueDefinition = {
  id: 'my-technique',
  name: 'My Technique',
  category: 'space',            // space | time | image | material
  description: 'One sentence, technical, no marketing.',
  sections: [
    {
      label: 'Grid',
      params: [
        {
          type: 'number',
          id: 'density',
          label: 'Density',
          min: 2, max: 200, step: 1, default: 48,
          modulatable: true,     // may be a modulation target
          explore: { randomizable: true, min: 8, max: 160, weight: 1 },
        },
        { type: 'boolean', id: 'invert', label: 'Invert', default: false },
        {
          type: 'select', id: 'mode', label: 'Mode',
          options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
          default: 'a',
        },
      ],
    },
  ],
  createRenderer: () => new MyRenderer(),
};
```

`sections` drive the inspector layout directly. `explore` metadata drives the
Explore workspace: omit it and the parameter is never randomized.

Only `type: 'number'` parameters with `modulatable: true` can be modulation
targets — the evaluator scales by the parameter's own range.

## 2. Implement the renderer

```ts
export class MyRenderer implements TechniqueRenderer {
  readonly object3d: THREE.Mesh;
  update(params: ParamRecord, ctx: TechniqueContext): void { /* write uniforms */ }
  dispose(): void { /* free geometry + material */ }
}
```

`update()` runs once per rendered frame. It must be cheap and **pure with
respect to time** — read `ctx.timeSec`, never `Date.now()` or a frame counter,
or export will not be reproducible.

### TechniqueContext

| Field | Meaning |
|---|---|
| `sourceTexture` | current source frame (image or video) |
| `materialTexture` | rasterized custom SVG/image material, or null |
| `temporal` | composition-time frame history, or null |
| `compWidth` / `compHeight` | composition size in px |
| `material` | material id, colour mode, params |
| `timeSec` | composition time for this frame |
| `seed` | project seed — the only legitimate source of randomness |

## 3. Register it

```ts
// src/techniques/registry.ts
registerTechnique(myDefinition);
```

If the technique samples the past, add its id to `TEMPORAL_TECHNIQUES` so the
engine allocates a frame history for it.

## 4. Optional: a browser card

Add an entry to `CARDS` in `TechniquesBrowser.tsx` and representative params to
`PREVIEW_PARAMS`. Previews are rendered from owned procedural footage in an
isolated GL context — never from the user's composition, and never from
third-party artwork.

## Shared GLSL

Import chunks instead of copying them:

- `rendering/shaders/chunks.ts` — `luminance`, `hash11`/`hash21`,
  `adjustSample` (contrast/gamma/invert), `sdShape` (the SDF material shapes).
- `rendering/shaders/temporal.ts` — `sampleTemporal(uv, offsetSeconds)` and
  `temporalWeight(mode, …)` for the eight offset distributions.

The CPU mirrors in `rendering/sampling.ts` exist so the same maths can be
unit-tested; keep them in sync when you change a chunk.

## Rules

- **No decoding in a technique.** Ask `ctx.temporal` for a past frame; the
  `TemporalFrameProvider` owns seeking, caching and memory.
- **No wall-clock.** Only `ctx.timeSec`.
- **Seeded randomness only**, derived from `ctx.seed` and a stable index.
- **Bound your instance count.** Respect `MAX_MOSAIC_INSTANCES` or an
  equivalent cap.
- **Dispose everything** you allocate; renderers are created and destroyed on
  every technique switch.

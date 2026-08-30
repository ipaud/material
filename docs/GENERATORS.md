# Generators (CE1F)

A generator is a **Source** — not an effect, not a layer, not a mode. It
implements the same `SourceRuntime` contract as a file or a camera, hands
the engine a texture, and flows through the entire pipeline:

```
GENERATOR → TECHNIQUE → MATERIAL → SIGNALS → EXPLORE → PERFORM → OUTPUT
```

## The family

| Generator | Mode | Deterministic | Random-access time | TemporalSource | Passes |
|---|---|---|---|---|---|
| Noise Field | stateless | yes | yes | **exact** | 1 |
| Wave Interference | stateless | yes | yes | **exact** | 1 |
| Voronoi | stateless | yes | yes | **exact** | 1 |
| Grid | stateless | yes | yes | **exact** | 1 |
| Chladni Field | stateless | yes | yes | **exact** | 1 |
| Reaction Diffusion | simulation | canonical | no | realtime | CE1E |
| Cellular | simulation | canonical | no | realtime | CE1E |

**Stateless** generators are pure functions of `(uv, timeSec, params, seed)`
— the same composition time always yields the same pixels, at any
resolution and any export FPS. They therefore implement `acquireAt(t)`
exactly, which makes them MATERIAL's first **decoder-free deterministic
temporal source**.

**Simulation** generators reuse the CE1E solver unchanged (same kernels,
same `SimulationRunner`): wall-clock stepping in preview, canonical
integer stepping in export. They are honestly *not* randomly seekable.

## Time semantics (deliberately different per mode)

- Stateless: composition time. Pause freezes them, seek jumps
  deterministically, loop loops.
- Simulation: CE1E semantics — living state that keeps evolving while the
  transport is paused.

A project with only generators has **no media clock**, so the transport
now runs an internal composition clock (generators are unbounded — their
`duration` is `null`, never a fabricated length).

## Source-parameter modulation

Generator parameters use the same `ParamDef` vocabulary as techniques, so
Pattern / audio / beat / MIDI / macros drive them through the existing
engine. Targets are namespaced `source.<paramId>` so a generator's `scale`
can never collide with a technique's `scale`.

**Authority stays in the editor.** The editor resolves source params every
frame and sends the RESOLVED values in `FrameState.sourceParams`; the
Output builds the same generator locally from the low-frequency config and
applies those values. It never evaluates a mapping. No generated pixels
cross the process.

Measured: Euclidean 3/8 on `source.scale` produced 13 distinct values
between 17 and 59.4 over two seconds, with FrameState carrying the same
resolved numbers.

## Determinism (measured)

| Gate | Result |
|---|---|
| Repeat export (noise → mosaic) | **byte-identical** |
| Full vs subrange (noise → mosaic) | **12/12 identical** |
| Motion Mosh over animated grid, full vs subrange | **12/12 identical** |
| Time Field over waves, repeat export | **byte-identical** |
| Time Field over waves, full vs subrange | 0/12 — see below |

The Time Field subrange gap is now isolated: with the decoder gone, the
remaining divergence is the temporal atlas's `primeExact` vs
`advanceExact` paths producing different tail slots for a source whose
history extends before `t=0`. That is a precise, newly actionable finding
(CE1G/CE1H), no longer "H.264 is unstable".

## Schema

Additive inside **v3**: the source union gained
`{kind:"generator", generator, params, seed}`. No existing field changed
shape; older projects open untouched. The seed persists so generated
content is stable across save/reload; runtime textures are never
serialized.

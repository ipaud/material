# GPU Numeric Testing (CE1D-2 methodology)

The standard for verifying numeric GPU state in MATERIAL (optical flow
today; Reaction Diffusion, Cellular Automata and Motion Signals tomorrow).

## The contract

Never read float render targets raw and never trust a measurement the
harness has not proven it can make:

```
float GPU state
   ↓  GPU ENCODE pass (documented scale, signed→0..255, saturation visible)
RGBA8 diagnostic target        (UnsignedByte, NoColorSpace — data-safe)
   ↓  typed Uint8Array readback (validated: type, glGetError — throw loud)
numeric assertions
```

## Self-test FIRST (mandatory)

Before any conclusion about the state under test, the probe must pass:
- constants: −MAX→0, 0→128, +MAX→255 on each axis;
- a gradient;
- an orientation marker (top-left dot → high `yFromBottom` rows: GL
  readback is bottom-row-first).
If the self-test fails, STOP — every downstream number is meaningless.
`FlowProbe.selfTest()` in `src/rendering/flow/flowDiagnostics.ts` is the
reference implementation.

## Clean-process rule

Golden evidence only from a freshly started app. Editing ANY source while
the dev app runs invalidates the session (HMR splits module graphs and
poisons singletons). Cycle: stop → edit → build/start → measure → stop.

## The traps this methodology exists for (all measured in CE1D)

1. **`renderer.setViewport` multiplies by pixelRatio — always.** After
   `setRenderTarget(rt)` Three already applies the RT's full viewport
   WITHOUT ratio; a manual `setViewport(0,0,w,h)` on a ratio-2 canvas
   paints only the lower-left quadrant. Symptom: fragments that consume
   `vUv` read zeros at sample points; constant shaders look fine.
2. **`readRenderTargetPixels` returns silent zeros** on buffer/type
   mismatch (Float32Array from an RGBA8 target, Uint8 from a float
   target). Always match types and check `gl.getError()`.
3. **Dynamic `import()` in dev can load a second module graph** (second
   `three`): objects from one copy rendered by the other fail silently.
   Dev harness entry points use static imports.
4. **Lossless H.264 (`-qp 0`) decodes to BLACK silently** in this
   Chromium. Core goldens use shader-generated synthetic frames — no
   decoder in the truth path (`SyntheticMotionSource`).
5. `dot` is a GLSL built-in — never a variable name.

## Flow goldens (reference numbers, M-series, 320-grid)

Self-test PASS. Units: ‰ uv/frame; ENCODE_MAX = 30‰; truth for a 2-px
shift at 320 = 6.25‰.

| Case | meanX | meanY | bg mag |
|---|---|---|---|
| STATIC | 0.12 | 0.12 | 0.166 (≈ encoder half-LSB) |
| RIGHT2 | +6.45 | 0.00 | 0.166 |
| LEFT2 | −6.49 | 0.00 | 0.166 |
| UP2 | −0.00 | +5.34 | 0.166 |
| DOWN2 | 0.00 | −5.38 | 0.166 |
| DIAG2 | +6.65 | −5.85 | 0.166 |

Velocity accuracy ±3% at 2px. Useful range 1–4 grid-px (8px incoherent,
16px dead — mono-scale LK limit, documented). Resolution sweep: 320
optimal (256: +12% bias; 512: −32%, weaker signal). UP = +Y (UV-up).

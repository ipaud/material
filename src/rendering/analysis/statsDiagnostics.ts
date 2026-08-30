import * as THREE from 'three';
import { ImageStatsReducer } from './ImageStatsReducer';

/**
 * v0.4A A2 — GPU goldens for the reduction ladder.
 *
 * Self-test FIRST, per docs/GPU_TESTING.md: nothing downstream means anything
 * until the harness has proven it can make the measurement. The strongest
 * assertion here is `n === gridWidth * gridHeight` exactly — it proves no
 * padded texel contributed and none was dropped, which answers the whole
 * odd-dimension question with one integer.
 *
 * Deliberate deviation from the encode-to-RGBA8 doctrine, recorded in
 * GPU_TESTING.md: this reads FloatType straight into a Float32Array. That rule
 * exists for signed, unknown-scale diagnostics; sums reaching 57 600 cannot
 * survive 8 bits.
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }
`;

function renderToTexture(
  renderer: THREE.WebGLRenderer,
  width: number,
  height: number,
  frag: string,
  float = false,
): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: false,
    colorSpace: THREE.NoColorSpace,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    ...(float ? { type: THREE.FloatType } : {}),
  });
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: frag,
    depthTest: false,
    depthWrite: false,
  });
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const cam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.setScissorTest(false);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prev);
  mat.dispose();
  mesh.geometry.dispose();
  return rt;
}

interface Case {
  name: string;
  width: number;
  height: number;
  source: string;
  /** Uniform signed flow in uv/frame, written as an RGBA32F texture. */
  flow?: { x: number; y: number };
  /** Flow confined to a rectangle in NORMALISED IMAGE coordinates, y down from
   * the top — the coordinates a person uses to describe where something is. */
  flowPatch?: { x0: number; x1: number; y0: number; y1: number; x: number; y: number };
  expect: {
    n: number;
    luminance?: number;
    contrast?: number;
    edgeEnergyGt?: number;
    edgeEnergyLt?: number;
    motionX?: number;
    motionY?: number;
    motionAmountGt?: number;
    activity?: number;
    centroidX?: number;
    centroidY?: number;
    centroidValid?: boolean;
  };
}

const grey = (v: number) => `void main(){ gl_FragColor = vec4(vec3(${v.toFixed(6)}), 1.0); }`;

export function runStatsGoldens(renderer: THREE.WebGLRenderer): Record<string, unknown> {
  const cases: Case[] = [
    {
      name: 'constant',
      width: 320,
      height: 180,
      source: grey(0.25),
      expect: { n: 320 * 180, luminance: 0.25 },
    },
    {
      // Mean over texel CENTRES of (i+0.5)/W is exactly 0.5 for any width.
      name: 'ramp',
      width: 320,
      height: 180,
      source: `varying vec2 vUv; void main(){ gl_FragColor = vec4(vec3(vUv.x), 1.0); }`,
      expect: { n: 320 * 180, luminance: 0.5 },
    },
    {
      name: 'oddHalfHalf',
      width: 317,
      height: 179,
      // 159 of 317 columns lit; only exact if odd-dimension coverage is exact.
      source: `varying vec2 vUv; void main(){ float on = step(vUv.x * 317.0, 159.0); gl_FragColor = vec4(vec3(on), 1.0); }`,
      expect: { n: 317 * 179, luminance: 159 / 317 },
    },
    {
      name: 'flowRight',
      width: 320,
      height: 180,
      source: grey(0.5),
      flow: { x: 0.01, y: 0 },
      expect: { n: 320 * 180, motionX: 1, motionAmountGt: 1 },
    },
    {
      name: 'flowLeft',
      width: 320,
      height: 180,
      source: grey(0.5),
      flow: { x: -0.01, y: 0 },
      expect: { n: 320 * 180, motionX: 0, motionAmountGt: 1 },
    },
    {
      name: 'flowVertical',
      width: 320,
      height: 180,
      source: grey(0.5),
      flow: { x: 0, y: 0.01 },
      // Vertical motion has no horizontal dominance — dead centre is correct.
      expect: { n: 320 * 180, motionX: 0.5, motionAmountGt: 1 },
    },
    {
      name: 'flowStill',
      width: 320,
      height: 180,
      source: grey(0.5),
      flow: { x: 0, y: 0 },
      expect: { n: 320 * 180, motionX: 0.5, motionY: 0.5, activity: 0, centroidValid: false },
    },
    // ---- v0.4B ------------------------------------------------------------
    {
      // A flat frame has no spread and no structure, whatever its brightness.
      name: 'flatContrast',
      width: 320,
      height: 180,
      source: grey(0.5),
      expect: { n: 320 * 180, contrast: 0, edgeEnergyLt: 1e-5 },
    },
    {
      // Half black, half white: the theoretical maximum standard deviation.
      name: 'splitContrast',
      width: 320,
      height: 180,
      source: `varying vec2 vUv; void main(){ gl_FragColor = vec4(vec3(step(0.5, vUv.x)), 1.0); }`,
      expect: { n: 320 * 180, luminance: 0.5, contrast: 0.5 },
    },
    {
      // Same 50/50 black and white, so the SAME contrast — but crossing the
      // range 16 times instead of once. Only edge energy separates them.
      name: 'stripesEdge',
      width: 320,
      height: 180,
      source: `varying vec2 vUv; void main(){ float s = step(0.5, fract(vUv.x * 16.0)); gl_FragColor = vec4(vec3(s), 1.0); }`,
      expect: { n: 320 * 180, contrast: 0.5, edgeEnergyGt: 0.05 },
    },
    {
      // The same 16 cycles as a SINE at full amplitude. Edge energy is total
      // variation per texel, and a sine traverses exactly as much range per
      // cycle as a square does — so this reads the same, and that is correct.
      // Recorded as a fixture so nobody "fixes" it later.
      name: 'sineEdge',
      width: 320,
      height: 180,
      source: `varying vec2 vUv; void main(){ float s = 0.5 + 0.5 * sin(vUv.x * 100.53); gl_FragColor = vec4(vec3(s), 1.0); }`,
      expect: { n: 320 * 180, edgeEnergyGt: 0.05 },
    },
    {
      // What blur ACTUALLY does to fine detail: it removes amplitude. Same 16
      // cycles at a quarter of the swing reads a quarter of the structure.
      name: 'blurredEdge',
      width: 320,
      height: 180,
      source: `varying vec2 vUv; void main(){ float s = 0.5 + 0.125 * sin(vUv.x * 100.53); gl_FragColor = vec4(vec3(s), 1.0); }`,
      expect: { n: 320 * 180, edgeEnergyLt: 0.03 },
    },
    {
      name: 'flowUp',
      width: 320,
      height: 180,
      source: grey(0.5),
      flow: { x: 0, y: 0.01 },
      expect: { n: 320 * 180, motionY: 1, motionX: 0.5, activity: 1 },
    },
    {
      name: 'flowDown',
      width: 320,
      height: 180,
      source: grey(0.5),
      flow: { x: 0, y: -0.01 },
      expect: { n: 320 * 180, motionY: 0, motionX: 0.5, activity: 1 },
    },
    {
      // A quarter of the frame moving reads a quarter, whatever the speed.
      name: 'activityQuarter',
      width: 320,
      height: 180,
      source: grey(0.5),
      flowPatch: { x0: 0, x1: 0.5, y0: 0, y1: 0.5, x: 0.01, y: 0 },
      expect: { n: 320 * 180, activity: 0.25 },
    },
    {
      name: 'centroidLeft',
      width: 320,
      height: 180,
      source: grey(0.5),
      flowPatch: { x0: 0, x1: 0.25, y0: 0.25, y1: 0.75, x: 0.02, y: 0 },
      expect: { n: 320 * 180, centroidX: 0.125, centroidY: 0.5, centroidValid: true },
    },
    {
      name: 'centroidRight',
      width: 320,
      height: 180,
      source: grey(0.5),
      flowPatch: { x0: 0.75, x1: 1, y0: 0.25, y1: 0.75, x: 0.02, y: 0 },
      expect: { n: 320 * 180, centroidX: 0.875, centroidY: 0.5, centroidValid: true },
    },
    {
      // THE orientation fixture: a patch across the TOP of the image must read
      // centroidY near 0. Nothing else in the codebase pins this convention.
      name: 'centroidTop',
      width: 320,
      height: 180,
      source: grey(0.5),
      flowPatch: { x0: 0.25, x1: 0.75, y0: 0, y1: 0.25, x: 0.02, y: 0 },
      expect: { n: 320 * 180, centroidY: 0.125, centroidX: 0.5, centroidValid: true },
    },
    {
      name: 'centroidBottom',
      width: 320,
      height: 180,
      source: grey(0.5),
      flowPatch: { x0: 0.25, x1: 0.75, y0: 0.75, y1: 1, x: 0.02, y: 0 },
      expect: { n: 320 * 180, centroidY: 0.875, centroidX: 0.5, centroidValid: true },
    },
  ];

  const out: Record<string, unknown> = {};
  const reducer = new ImageStatsReducer();
  try {
    for (const c of cases) {
      const srcRt = renderToTexture(renderer, c.width, c.height, c.source);
      // A patch is expressed with y measured DOWN from the top, and the source
      // texture's v runs the other way, so the fixture flips it here rather
      // than in the shader — the shader's convention is what is under test.
      const patchFrag = c.flowPatch
        ? `varying vec2 vUv;
           void main(){
             float yTop = 1.0 - vUv.y;
             float inside = step(${c.flowPatch.x0.toFixed(6)}, vUv.x) * step(vUv.x, ${c.flowPatch.x1.toFixed(6)})
                          * step(${c.flowPatch.y0.toFixed(6)}, yTop) * step(yTop, ${c.flowPatch.y1.toFixed(6)});
             gl_FragColor = vec4(${c.flowPatch.x.toFixed(6)} * inside, ${c.flowPatch.y.toFixed(6)} * inside, 0.0, 1.0);
           }`
        : c.flow
          ? `void main(){ gl_FragColor = vec4(${c.flow.x.toFixed(6)}, ${c.flow.y.toFixed(6)}, 0.0, 1.0); }`
          : null;
      const flowRt = patchFrag
        ? renderToTexture(renderer, c.width, c.height, patchFrag, true)
        : null;
      const s = reducer.analyse(
        renderer,
        srcRt.texture,
        flowRt ? flowRt.texture : null,
        c.width,
        c.height,
        `golden:${c.name}`,
      );
      const near = (got: number, want: number | undefined, tol: number) =>
        want === undefined || Math.abs(got - want) < tol;
      out[c.name] = s
        ? {
            n: s.n,
            nExact: s.n === c.expect.n,
            luminance: +s.luminance.toFixed(6),
            contrast: +s.contrast.toFixed(6),
            edgeEnergy: +s.edgeEnergy.toFixed(6),
            motionAmount: +s.motionAmount.toFixed(4),
            motionX: +s.motionX.toFixed(6),
            motionY: +s.motionY.toFixed(6),
            activity: +s.motionActivity.toFixed(6),
            centroidX: +s.centroidX.toFixed(6),
            centroidY: +s.centroidY.toFixed(6),
            centroidValid: s.centroidValid,
            ok:
              s.n === c.expect.n &&
              // Source fixtures are RGBA8, like real sources: 0.25 stores as
              // 64/255 = 0.25098. Half an 8-bit LSB is the honest tolerance;
              // tightening it would only be testing the fixture's precision.
              near(s.luminance, c.expect.luminance, 1 / 510) &&
              near(s.contrast, c.expect.contrast, 1 / 255) &&
              near(s.motionX, c.expect.motionX, 1e-4) &&
              near(s.motionY, c.expect.motionY, 1e-4) &&
              // Activity is a texel count against a threshold, so a patch edge
              // that lands mid-texel moves it by one row's worth.
              near(s.motionActivity, c.expect.activity, 0.01) &&
              near(s.centroidX, c.expect.centroidX, 0.02) &&
              near(s.centroidY, c.expect.centroidY, 0.02) &&
              (c.expect.centroidValid === undefined ||
                s.centroidValid === c.expect.centroidValid) &&
              (c.expect.edgeEnergyGt === undefined || s.edgeEnergy > c.expect.edgeEnergyGt) &&
              (c.expect.edgeEnergyLt === undefined || s.edgeEnergy < c.expect.edgeEnergyLt) &&
              (c.expect.motionAmountGt === undefined || s.motionAmount > c.expect.motionAmountGt),
          }
        : { error: 'no stats' };
      srcRt.dispose();
      flowRt?.dispose();
    }

    // Gate: the same frame key must not reduce twice.
    const rt = renderToTexture(renderer, 64, 36, grey(0.4));
    const before = reducer.reductions;
    reducer.analyse(renderer, rt.texture, null, 64, 36, 'gate:same');
    reducer.analyse(renderer, rt.texture, null, 64, 36, 'gate:same');
    out.gateRerunsOnce = reducer.reductions - before === 1;
    // And the same frame reduced again under a new key is bit-identical.
    const a = reducer.analyse(renderer, rt.texture, null, 64, 36, 'gate:a');
    const b = reducer.analyse(renderer, rt.texture, null, 64, 36, 'gate:b');
    out.deterministic = a !== null && b !== null && a.luminance === b.luminance;
    rt.dispose();
  } finally {
    reducer.dispose();
  }
  out.allOk = Object.entries(out).every(([k, v]) =>
    k === 'allOk' || typeof v === 'boolean' ? v !== false : (v as { ok?: boolean }).ok !== false,
  );
  return out;
}

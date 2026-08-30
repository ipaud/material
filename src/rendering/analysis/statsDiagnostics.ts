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
  /** Signed flow in uv/frame, written as an RGBA32F texture. */
  flow?: { x: number; y: number };
  expect: { n: number; luminance?: number; motionX?: number; motionAmountGt?: number };
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
      expect: { n: 320 * 180, motionX: 0.5 },
    },
  ];

  const out: Record<string, unknown> = {};
  const reducer = new ImageStatsReducer();
  try {
    for (const c of cases) {
      const srcRt = renderToTexture(renderer, c.width, c.height, c.source);
      const flowRt = c.flow
        ? renderToTexture(
            renderer,
            c.width,
            c.height,
            `void main(){ gl_FragColor = vec4(${c.flow.x.toFixed(6)}, ${c.flow.y.toFixed(6)}, 0.0, 1.0); }`,
            true,
          )
        : null;
      const s = reducer.analyse(
        renderer,
        srcRt.texture,
        flowRt ? flowRt.texture : null,
        c.width,
        c.height,
        `golden:${c.name}`,
      );
      out[c.name] = s
        ? {
            n: s.n,
            nExact: s.n === c.expect.n,
            luminance: +s.luminance.toFixed(6),
            motionAmount: +s.motionAmount.toFixed(4),
            motionX: +s.motionX.toFixed(6),
            ok:
              s.n === c.expect.n &&
              // Source fixtures are RGBA8, like real sources: 0.25 stores as
              // 64/255 = 0.25098. Half an 8-bit LSB is the honest tolerance;
              // tightening it would only be testing the fixture's precision.
              (c.expect.luminance === undefined ||
                Math.abs(s.luminance - c.expect.luminance) < 1 / 510) &&
              (c.expect.motionX === undefined || Math.abs(s.motionX - c.expect.motionX) < 1e-4) &&
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

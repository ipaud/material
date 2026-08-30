import * as THREE from 'three';
import {
  DEFAULT_TRANSITION,
  TransitionCompositor,
  TRANSITION_STYLES,
  type TransitionParams,
  type TransitionStyle,
} from './TransitionCompositor';

/**
 * CE1G — transition goldens on the CE1D-2 GPU methodology: render the
 * composite of two KNOWN solid colours into an RGBA8 target, read it back
 * typed, assert exact numbers. Endpoint law, coverage monotonicity and the
 * Smooth colour-space midpoint all become measurements, not screenshots.
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }
`;

function solidTexture(
  renderer: THREE.WebGLRenderer,
  w: number,
  h: number,
  frag: string,
): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
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
  return rt;
}

export interface TransitionSample {
  /** Fraction of pixels that are (mostly) the B colour. */
  coverageB: number;
  /** Mean RGB of the composite. */
  mean: [number, number, number];
  /** Exact centre pixel. */
  centre: [number, number, number];
  /** Pixels that are neither pure A nor pure B (blend band). */
  blended: number;
  /** Reveal fraction (0..1) per image half, measured on A's red channel —
   * B contributes no red, so this is uncontaminated by B's own brightness. */
  revealLeft: number;
  revealRight: number;
}

/**
 * Composite A=red, B=blue with the given style/progress and measure.
 * `half` paints B's right half white so LUMA order can be checked.
 */
export function sampleTransition(
  renderer: THREE.WebGLRenderer,
  style: TransitionStyle,
  progress: number,
  overrides: Partial<TransitionParams> = {},
  size = 64,
  bVariant: 'solid' | 'halfBright' = 'solid',
): TransitionSample {
  const a = solidTexture(renderer, size, size, `void main(){ gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); }`);
  const b = solidTexture(
    renderer,
    size,
    size,
    bVariant === 'solid'
      ? `void main(){ gl_FragColor = vec4(0.0, 0.0, 1.0, 1.0); }`
      // Cyan, not blue: luma(cyan)=0.787 vs luma(blue)=0.072, so the bright
      // and dark halves land far apart on the luma axis instead of both
      // crushing into the top of the reveal order.
      : `varying vec2 vUv; void main(){ float v = vUv.x > 0.5 ? 1.0 : 0.1; gl_FragColor = vec4(0.0, v, v, 1.0); }`,
  );
  const out = new THREE.WebGLRenderTarget(size, size, { depthBuffer: false });
  const comp = new TransitionCompositor();
  // Inject the A snapshot by capturing a pass that draws the A texture.
  const copyMat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: `varying vec2 vUv; uniform sampler2D uTex; void main(){ gl_FragColor = texture2D(uTex, vUv); }`,
    depthTest: false,
    depthWrite: false,
    uniforms: { uTex: { value: a.texture } },
  });
  const copyScene = new THREE.Scene();
  const copyMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), copyMat);
  copyMesh.frustumCulled = false;
  copyScene.add(copyMesh);
  const cam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  comp.capture(renderer, size, size, () => renderer.render(copyScene, cam));

  const params: TransitionParams = { ...DEFAULT_TRANSITION, style, ...overrides };
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(out);
  renderer.setScissorTest(false);
  comp.composite(renderer, b.texture, progress, params, 1);
  renderer.setRenderTarget(prev);

  const buf = new Uint8Array(size * size * 4);
  renderer.readRenderTargetPixels(out, 0, 0, size, size, buf);
  const gl = renderer.getContext();
  const err = gl.getError();
  if (err !== gl.NO_ERROR) throw new Error(`glGetError: 0x${err.toString(16)}`);

  let bCount = 0,
    blended = 0,
    sr = 0,
    sg = 0,
    sb = 0,
    rLeft = 0,
    rRight = 0;
  for (let i = 0; i < buf.length; i += 4) {
    const r = buf[i]!;
    const bl = buf[i + 2]!;
    sr += r;
    sg += buf[i + 1]!;
    sb += bl;
    if ((i / 4) % size < size / 2) rLeft += r;
    else rRight += r;
    if (bl > 200 && r < 55) bCount++;
    else if (!(r > 200 && bl < 55)) blended++;
  }
  const n = size * size;
  const half = n / 2;
  const c = ((size / 2) * size + size / 2) * 4;
  const result: TransitionSample = {
    coverageB: bCount / n,
    mean: [sr / n, sg / n, sb / n],
    centre: [buf[c]!, buf[c + 1]!, buf[c + 2]!],
    blended: blended / n,
    revealLeft: 1 - rLeft / half / 255,
    revealRight: 1 - rRight / half / 255,
  };
  comp.dispose();
  copyMat.dispose();
  a.dispose();
  b.dispose();
  out.dispose();
  return result;
}

/** Full protocol: endpoints + monotonic coverage + determinism per style. */
export function runTransitionGoldens(renderer: THREE.WebGLRenderer): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const style of TRANSITION_STYLES) {
    try {
      const at0 = sampleTransition(renderer, style, 0);
      const at1 = sampleTransition(renderer, style, 1);
      // Mean blue is the right monotonicity metric: pure-pixel coverage is
      // blind to continuous blends (Smooth's midpoint is neither A nor B).
      const mid = [0.25, 0.5, 0.75].map((p) => sampleTransition(renderer, style, p).mean[2]);
      const repeat = sampleTransition(renderer, style, 0.5);
      const repeat2 = sampleTransition(renderer, style, 0.5);
      out[style] = {
        endpointA: at0.centre,
        endpointB: at1.centre,
        blueRamp: mid.map((v) => +v.toFixed(1)),
        monotonic: mid[0]! <= mid[1]! + 1e-6 && mid[1]! <= mid[2]! + 1e-6,
        deterministic:
          repeat.coverageB === repeat2.coverageB &&
          repeat.centre.join() === repeat2.centre.join(),
      };
    } catch (err) {
      out[style] = { error: String(err) };
    }
  }
  // Smooth colour-space midpoint: red→blue at 0.5 must be an even blend.
  out.smoothMidpoint = sampleTransition(renderer, 'smooth', 0.5).centre;
  // Luma order: B's right half is bright, so the right half must reveal
  // FIRST — the defining semantic of the style, and unprovable by eye.
  const lumaEarly = sampleTransition(renderer, 'luma', 0.4, { softness: 0.1 }, 64, 'halfBright');
  const lumaLate = sampleTransition(renderer, 'luma', 0.9, { softness: 0.1 }, 64, 'halfBright');
  out.lumaOrder = {
    earlyBright: +lumaEarly.revealRight.toFixed(3),
    earlyDark: +lumaEarly.revealLeft.toFixed(3),
    lateBright: +lumaLate.revealRight.toFixed(3),
    lateDark: +lumaLate.revealLeft.toFixed(3),
    brightFirst: lumaEarly.revealRight > lumaEarly.revealLeft + 0.2,
  };
  return out;
}

const SHEET_A = `varying vec2 vUv; void main(){
  float s = step(0.5, fract((vUv.x + vUv.y) * 9.0));
  vec3 warm = mix(vec3(0.85, 0.32, 0.10), vec3(0.99, 0.80, 0.25), vUv.y);
  gl_FragColor = vec4(warm * (0.55 + 0.45 * s), 1.0); }`;
const SHEET_B = `varying vec2 vUv; void main(){
  float d = length(vUv - 0.5);
  float r = step(0.5, fract(d * 14.0));
  vec3 cool = mix(vec3(0.05, 0.18, 0.42), vec3(0.35, 0.85, 0.95), 1.0 - d * 1.6);
  gl_FragColor = vec4(cool * (0.45 + 0.55 * r), 1.0); }`;

/** One composited cell, read back as raw RGBA8 (GL bottom-up order). */
function compositeCell(
  renderer: THREE.WebGLRenderer,
  style: TransitionStyle,
  progress: number,
  size: number,
): Uint8Array {
  const a = solidTexture(renderer, size, size, SHEET_A);
  const b = solidTexture(renderer, size, size, SHEET_B);
  const out = new THREE.WebGLRenderTarget(size, size, { depthBuffer: false });
  const comp = new TransitionCompositor();
  const copyMat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: `varying vec2 vUv; uniform sampler2D uTex; void main(){ gl_FragColor = texture2D(uTex, vUv); }`,
    depthTest: false,
    depthWrite: false,
    uniforms: { uTex: { value: a.texture } },
  });
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), copyMat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const cam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  comp.capture(renderer, size, size, () => renderer.render(scene, cam));

  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(out);
  renderer.setScissorTest(false);
  comp.composite(renderer, b.texture, progress, { ...DEFAULT_TRANSITION, style }, 1);
  renderer.setRenderTarget(prev);

  const px = new Uint8Array(size * size * 4);
  renderer.readRenderTargetPixels(out, 0, 0, size, size, px);
  comp.dispose();
  copyMat.dispose();
  a.dispose();
  b.dispose();
  out.dispose();
  return px;
}

/**
 * Dev-only CONTACT SHEET: every style at three progresses over the same
 * pair of images, so curation (KEEP / MAYBE / REJECT) is a decision made by
 * looking, not by reading shader source. A is a warm diagonal stripe field,
 * B a cool concentric ring field — different enough in structure that a
 * reveal mask is legible, procedural so the sheet is reproducible.
 *
 * The grid is assembled in JS from per-cell readbacks. Tiling it on the GPU
 * would need setViewport after setRenderTarget, which is precisely the
 * CE1D-2 trap (×pixelRatio → cells land in the wrong quadrant on retina).
 */
export function transitionContactSheet(
  renderer: THREE.WebGLRenderer,
  cell = 160,
  progresses = [0.25, 0.5, 0.75],
): { width: number; height: number; pixels: Uint8Array; labels: string[] } {
  const W = cell * progresses.length;
  const H = cell * TRANSITION_STYLES.length;
  const pixels = new Uint8Array(W * H * 4);
  TRANSITION_STYLES.forEach((style, row) => {
    progresses.forEach((p, col) => {
      const px = compositeCell(renderer, style, p, cell);
      for (let y = 0; y < cell; y++) {
        // Cell rows are bottom-up; place them so the sheet reads top-down.
        const dstY = H - (row * cell + (cell - 1 - y)) - 1;
        const src = y * cell * 4;
        pixels.set(px.subarray(src, src + cell * 4), (dstY * W + col * cell) * 4);
      }
    });
  });
  return { width: W, height: H, pixels, labels: [...TRANSITION_STYLES] };
}

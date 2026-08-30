import * as THREE from 'three';
import { OpticalFlowField } from './OpticalFlowField';

/**
 * CE1D-2 — the GPU verification harness for numeric GPU state.
 *
 * Never read float render targets raw. The trustworthy path is:
 *
 *   float state → GPU ENCODE pass → RGBA8 diagnostic target → Uint8 readback
 *
 * with loud validation at every step (framebuffer completeness, buffer
 * shape, glGetError) and harness SELF-TESTS that must pass before any
 * conclusion about the state under test is allowed. This module is
 * dev/test-only; nothing here runs in the product render path.
 *
 * Encoding contract (documented, §7):
 *   R = signed flow.x   −ENCODE_MAX→0, 0→128, +ENCODE_MAX→255
 *   G = signed flow.y   same scale (y is UV-up: +y = up on screen)
 *   B = |flow| / ENCODE_MAX clamped 0..255 (saturation visible at 255)
 *   A = 255
 */

export const ENCODE_MAX = 0.03; // uv/frame — comfortably above the ±8-texel clamp at 320px

export const encodeByte = (v: number): number =>
  Math.max(0, Math.min(255, Math.round((v / ENCODE_MAX) * 127.5 + 127.5)));
export const decodeByte = (b: number): number => ((b - 127.5) / 127.5) * ENCODE_MAX;

const FSQ = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }
`;

const ENCODE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uFlow;
uniform float uMax;
void main() {
  vec2 f = texture2D(uFlow, vUv).rg;
  vec2 s = clamp(f / uMax, -1.0, 1.0) * 0.5 + 0.5;
  float m = clamp(length(f) / uMax, 0.0, 1.0);
  gl_FragColor = vec4(s, m, 1.0);
}
`;

// Self-test pattern: quadrant constants + a marker dot for orientation.
const SELFTEST_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uMax;
void main() {
  // left half: x=-MAX ; right half: x=+MAX ; center column: 0
  float x = vUv.x < 0.45 ? -uMax : (vUv.x > 0.55 ? uMax : 0.0);
  // bottom half: y=-MAX ; top half: +MAX (UV-up)
  float y = vUv.y < 0.45 ? -uMax : (vUv.y > 0.55 ? uMax : 0.0);
  vec2 s = clamp(vec2(x, y) / uMax, -1.0, 1.0) * 0.5 + 0.5;
  // orientation dot: pure white marker near the TOP-LEFT of the image
  float dot = (vUv.x < 0.06 && vUv.y > 0.94) ? 1.0 : 0.0;
  gl_FragColor = vec4(max(s.x, dot), max(s.y, dot), dot, 1.0);
}
`;

// Deterministic textured fixture: checkered patch on black, position in UV.
const FIXTURE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec2 uPos;      // patch center, uv
uniform vec2 uSize;     // patch half-size, uv
uniform float uChecker; // checker cell count across the patch
void main() {
  vec2 d = abs(vUv - uPos);
  if (d.x > uSize.x || d.y > uSize.y) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 local = (vUv - (uPos - uSize)) / (uSize * 2.0);
  vec2 c = floor(local * uChecker);
  float v = mod(c.x + c.y, 2.0) < 0.5 ? 1.0 : 0.35;
  gl_FragColor = vec4(vec3(v), 1.0);
}
`;

function fsqMesh(material: THREE.ShaderMaterial): THREE.Mesh {
  material.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  // The FSQ vertex shader bypasses the camera; CPU frustum culling must not
  // get a vote (ortho near=0 puts the quad exactly on the near plane).
  mesh.frustumCulled = false;
  return mesh;
}

function drawInto(
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget,
  scene: THREE.Scene,
  camera: THREE.Camera,
): void {
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.setScissorTest(false);
  renderer.render(scene, camera);
  renderer.setRenderTarget(prev);
}

/** Loud, validated RGBA8 readback. Throws on any mismatch — never zeros. */
export function readRgba8(
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget,
): Uint8Array {
  const t = target.texture;
  if (t.type !== THREE.UnsignedByteType) {
    throw new Error(`diagnostic target must be UnsignedByte, got type=${String(t.type)}`);
  }
  const out = new Uint8Array(target.width * target.height * 4);
  renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, out);
  const gl = renderer.getContext();
  const err = gl.getError();
  if (err !== gl.NO_ERROR) throw new Error(`glGetError after readback: 0x${err.toString(16)}`);
  return out;
}

export interface RegionStats {
  meanX: number;
  meanY: number;
  meanMag: number;
  p95Mag: number;
  maxMag: number;
  pixels: number;
}

/** Decode + aggregate a region of an ENCODE_FRAG readback.
 * Row order: GL readback is bottom-row-first; `yFromBottom` coordinates. */
export function regionStats(
  buf: Uint8Array,
  width: number,
  height: number,
  region: { x0: number; x1: number; y0: number; y1: number },
): RegionStats {
  let sx = 0,
    sy = 0,
    sm = 0,
    n = 0,
    mx = 0;
  const mags: number[] = [];
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const i = (y * width + x) * 4;
      const fx = decodeByte(buf[i]!);
      const fy = decodeByte(buf[i + 1]!);
      const m = Math.hypot(fx, fy);
      sx += fx;
      sy += fy;
      sm += m;
      mags.push(m);
      if (m > mx) mx = m;
      n++;
    }
  }
  mags.sort((a, b) => a - b);
  return {
    meanX: n ? sx / n : 0,
    meanY: n ? sy / n : 0,
    meanMag: n ? sm / n : 0,
    p95Mag: mags[Math.floor(mags.length * 0.95)] ?? 0,
    maxMag: mx,
    pixels: n,
  };
}

/**
 * CE1D-2's A-E canaries lived here. They isolated the setViewport-after-
 * setRenderTarget bug (viewport units are multiplied by pixelRatio, so the
 * pass was confined to a quadrant) and were removed in CE1H: the bug is
 * fixed, and every affected subsystem now has a structural test asserting
 * the call is absent. The self-test and the synthetic goldens below are the
 * parts with ongoing value.
 */


export class FlowProbe {
  private encodeMat = new THREE.ShaderMaterial({
    vertexShader: FSQ,
    fragmentShader: ENCODE_FRAG,
    depthTest: false,
    depthWrite: false,
    uniforms: { uFlow: { value: null }, uMax: { value: ENCODE_MAX } },
  });
  private selfMat = new THREE.ShaderMaterial({
    vertexShader: FSQ,
    fragmentShader: SELFTEST_FRAG,
    depthTest: false,
    depthWrite: false,
    uniforms: { uMax: { value: ENCODE_MAX } },
  });
  private encodeScene = new THREE.Scene();
  private selfScene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  private target: THREE.WebGLRenderTarget;

  constructor(
    private renderer: THREE.WebGLRenderer,
    readonly width: number,
    readonly height: number,
  ) {
    // Data-safe RGBA8: default UnsignedByte, NoColorSpace — no sRGB math.
    this.target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: false });
    this.encodeScene.add(fsqMesh(this.encodeMat));
    this.selfScene.add(fsqMesh(this.selfMat));
  }

  /** §10-12: the harness must prove ITSELF before any flow conclusion. */
  selfTest(): { pass: boolean; detail: Record<string, number | boolean> } {
    drawInto(this.renderer, this.target, this.selfScene, this.camera);
    const buf = readRgba8(this.renderer, this.target);
    const w = this.width;
    const h = this.height;
    const px = (x: number, yFromBottom: number) => {
      const i = (yFromBottom * w + x) * 4;
      return [buf[i]!, buf[i + 1]!, buf[i + 2]!] as const;
    };
    const midY = Math.floor(h / 2);
    const left = px(Math.floor(w * 0.2), midY);
    const right = px(Math.floor(w * 0.8), midY);
    const centerX = px(Math.floor(w * 0.5), Math.floor(h * 0.2));
    const bottom = px(Math.floor(w * 0.2), Math.floor(h * 0.2));
    const top = px(Math.floor(w * 0.2), Math.floor(h * 0.8));
    // Orientation: the marker was painted at image TOP-left → must appear
    // in HIGH yFromBottom rows.
    const markTop = px(Math.floor(w * 0.03), h - 2)[2];
    const markBottom = px(Math.floor(w * 0.03), 1)[2];
    const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;
    const detail = {
      leftR: left[0],
      rightR: right[0],
      centerR: centerX[0],
      bottomG: bottom[1],
      topG: top[1],
      markTopB: markTop,
      markBottomB: markBottom,
    };
    const pass =
      near(left[0], 0) &&
      near(right[0], 255) &&
      near(centerX[0], 128) &&
      near(bottom[1], 0) &&
      near(top[1], 255) &&
      markTop === 255 &&
      markBottom === 0;
    return { pass, detail };
  }

  /** Encode a flow texture into the diagnostic target and read it back. */
  readFlow(flowTexture: THREE.Texture): Uint8Array {
    this.encodeMat.uniforms.uFlow!.value = flowTexture;
    drawInto(this.renderer, this.target, this.encodeScene, this.camera);
    return readRgba8(this.renderer, this.target);
  }

  dispose(): void {
    this.target.dispose();
    this.encodeMat.dispose();
    this.selfMat.dispose();
  }
}

/** GPU-generated deterministic motion fixture (no decoder, §3-5). */
export class SyntheticMotionSource {
  private mat = new THREE.ShaderMaterial({
    vertexShader: FSQ,
    fragmentShader: FIXTURE_FRAG,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uPos: { value: new THREE.Vector2(0.5, 0.5) },
      uSize: { value: new THREE.Vector2(0.125, 0.2222) },
      uChecker: { value: 10 },
    },
  });
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  readonly target: THREE.WebGLRenderTarget;

  constructor(
    private renderer: THREE.WebGLRenderer,
    readonly width = 640,
    readonly height = 360,
  ) {
    this.target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: false });
    this.scene.add(fsqMesh(this.mat));
  }

  /** Draw the checkered patch centered at (u,v). */
  frame(u: number, v: number): THREE.Texture {
    (this.mat.uniforms.uPos!.value as THREE.Vector2).set(u, v);
    drawInto(this.renderer, this.target, this.scene, this.camera);
    return this.target.texture;
  }

  dispose(): void {
    this.target.dispose();
    this.mat.dispose();
  }
}

export interface GoldenCase {
  name: string;
  du: number; // uv shift applied to frame B
  dv: number;
}

export interface GoldenResult {
  name: string;
  object: RegionStats;
  background: RegionStats;
}

/**
 * Run the full golden protocol on a fresh OpticalFlowField:
 * frame A at center, frame B shifted by (du,dv); read encoded flow;
 * aggregate object-region vs background stats (§6 truth regions).
 */
export function runFlowGolden(
  renderer: THREE.WebGLRenderer,
  kase: GoldenCase,
  maxDim = 320,
): GoldenResult {
  const src = new SyntheticMotionSource(renderer);
  const flow = new OpticalFlowField(maxDim);
  const cu = 0.5;
  const cv = 0.5;
  flow.update(renderer, src.frame(cu, cv), src.width, src.height, `${kase.name}:a`);
  flow.update(renderer, src.frame(cu + kase.du, cv + kase.dv), src.width, src.height, `${kase.name}:b`);
  const { width, height } = flow.resolution;
  const probe = new FlowProbe(renderer, width, height);
  const self = probe.selfTest();
  if (!self.pass) {
    probe.dispose();
    flow.dispose();
    src.dispose();
    throw new Error(`harness self-test failed: ${JSON.stringify(self.detail)}`);
  }
  const tex = flow.texture();
  if (!tex) throw new Error('flow texture missing after two updates');
  const buf = probe.readFlow(tex);
  // Object region: patch half-size 0.125×0.2222 uv around center (post-move
  // intersection): use a conservative inner box around the B position.
  const bx = cu + kase.du;
  const by = cv + kase.dv;
  const obj = {
    x0: Math.floor((bx - 0.09) * width),
    x1: Math.floor((bx + 0.09) * width),
    y0: Math.floor((by - 0.16) * height),
    y1: Math.floor((by + 0.16) * height),
  };
  const bg = { x0: Math.floor(width * 0.72), x1: width - 4, y0: 4, y1: Math.floor(height * 0.3) };
  const result = {
    name: kase.name,
    object: regionStats(buf, width, height, obj),
    background: regionStats(buf, width, height, bg),
  };
  probe.dispose();
  flow.dispose();
  src.dispose();
  return result;
}

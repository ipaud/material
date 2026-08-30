import * as THREE from 'three';
import { SimulationRunner } from './SimulationRunner';
import { cellularKernel, reactionDiffusionKernel, CA_RULES } from './kernels';

/**
 * CE1E — simulation verification, built on the CE1D-2 methodology
 * (docs/GPU_TESTING.md): GPU state → encode pass → RGBA8 target → typed
 * readback → assertions, self-test first, loud failures.
 *
 * Two encodings:
 *   CELLULAR   state is already 0/1 in R — read the RGBA8 target directly,
 *              exact cell truth (the "truth machine").
 *   CONTINUOUS half-float A/B → encode with NaN/Inf detection (§52: invalid
 *              state paints magenta so a shader explosion cannot hide).
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }
`;

const ENCODE_STATE = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uState;
void main() {
  vec2 s = texture2D(uState, vUv).rg;
  // NaN/Inf are loud: any non-finite component paints pure magenta.
  bool bad = !(s.r == s.r) || !(s.g == s.g) || abs(s.r) > 1e6 || abs(s.g) > 1e6;
  if (bad) { gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); return; }
  gl_FragColor = vec4(clamp(s, 0.0, 1.0), 0.0, 1.0);
}
`;

function fsqScene(mat: THREE.ShaderMaterial): THREE.Scene {
  const s = new THREE.Scene();
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  m.frustumCulled = false;
  s.add(m);
  return s;
}

export class SimProbe {
  private mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: ENCODE_STATE,
    depthTest: false,
    depthWrite: false,
    uniforms: { uState: { value: null } },
  });
  private scene = fsqScene(this.mat);
  private camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  private target: THREE.WebGLRenderTarget;

  constructor(
    private renderer: THREE.WebGLRenderer,
    readonly width: number,
    readonly height: number,
  ) {
    this.target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: false });
  }

  /** §6/§10: prove the probe before trusting any simulation number. */
  selfTest(): { pass: boolean; detail: Record<string, number> } {
    const probeMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      depthTest: false,
      depthWrite: false,
      // Resolution-aware self-test: the marker is defined in TEXELS, not in
      // a uv fraction, so a 16×16 golden grid proves the same invariants as
      // a 512² one. The gradient is compared against its own exact texel
      // centers instead of an absolute byte.
      uniforms: { uTexel: { value: new THREE.Vector2(1 / this.width, 1 / this.height) } },
      fragmentShader: /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec2 uTexel;
void main() {
  // marker = exactly the top-left texel
  float dotm = (vUv.x < uTexel.x && vUv.y > 1.0 - uTexel.y) ? 1.0 : 0.0;
  gl_FragColor = vec4(vUv.x, 0.5, dotm, 1.0);
}`,
    });
    const sc = fsqScene(probeMat);
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.target);
    this.renderer.setScissorTest(false);
    this.renderer.render(sc, this.camera);
    this.renderer.setRenderTarget(prev);
    const buf = this.readBytes();
    const at = (x: number, yFromBottom: number, c = 0) =>
      buf[(yFromBottom * this.width + x) * 4 + c]!;
    const midY = Math.floor(this.height / 2);
    // Expected byte at texel x: uv center = (x+0.5)/width.
    const expect = (x: number) => Math.round(((x + 0.5) / this.width) * 255);
    const detail = {
      leftR: at(0, midY),
      leftExpect: expect(0),
      rightR: at(this.width - 1, midY),
      rightExpect: expect(this.width - 1),
      midG: at(Math.floor(this.width / 2), midY, 1),
      markTopB: at(0, this.height - 1, 2),
      markBottomB: at(0, 0, 2),
      gradientMonotonic: at(this.width - 1, midY) > at(0, midY) ? 1 : 0,
    };
    probeMat.dispose();
    const pass =
      Math.abs(detail.leftR - detail.leftExpect) <= 2 &&
      Math.abs(detail.rightR - detail.rightExpect) <= 2 &&
      Math.abs(detail.midG - 128) <= 2 &&
      detail.markTopB === 255 &&
      detail.markBottomB === 0;
    return { pass, detail };
  }

  private readBytes(): Uint8Array {
    if (this.target.texture.type !== THREE.UnsignedByteType) {
      throw new Error('diagnostic target must be UnsignedByte');
    }
    const out = new Uint8Array(this.width * this.height * 4);
    this.renderer.readRenderTargetPixels(this.target, 0, 0, this.width, this.height, out);
    const gl = this.renderer.getContext();
    const err = gl.getError();
    if (err !== gl.NO_ERROR) throw new Error(`glGetError: 0x${err.toString(16)}`);
    return out;
  }

  /** Encode + read continuous state (RD). */
  readState(texture: THREE.Texture): Uint8Array {
    this.mat.uniforms.uState!.value = texture;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.target);
    this.renderer.setScissorTest(false);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
    return this.readBytes();
  }

  dispose(): void {
    this.target.dispose();
    this.mat.dispose();
  }
}

export interface StateStats {
  minA: number;
  maxA: number;
  meanA: number;
  minB: number;
  maxB: number;
  meanB: number;
  varB: number;
  nanPixels: number;
}

export function stateStats(buf: Uint8Array): StateStats {
  let minA = 255, maxA = 0, sumA = 0, minB = 255, maxB = 0, sumB = 0, sumB2 = 0, nan = 0;
  const n = buf.length / 4;
  for (let i = 0; i < buf.length; i += 4) {
    const a = buf[i]!;
    const b = buf[i + 1]!;
    // magenta marker = invalid state
    if (a === 255 && b === 0 && buf[i + 2] === 255) nan++;
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
    sumA += a;
    sumB += b;
    sumB2 += b * b;
  }
  const meanB = sumB / n;
  return {
    minA: minA / 255,
    maxA: maxA / 255,
    meanA: sumA / n / 255,
    minB: minB / 255,
    maxB: maxB / 255,
    meanB: meanB / 255,
    varB: (sumB2 / n - meanB * meanB) / (255 * 255),
    nanPixels: nan,
  };
}

/** Exact cell readout for CA goldens: [x][y] booleans, y from bottom. */
export function cellGrid(buf: Uint8Array, width: number, height: number): boolean[][] {
  const g: boolean[][] = [];
  for (let y = 0; y < height; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < width; x++) row.push(buf[(y * width + x) * 4]! > 127);
    g.push(row);
  }
  return g;
}

export function liveCells(grid: boolean[][]): [number, number][] {
  const out: [number, number][] = [];
  grid.forEach((row, y) => row.forEach((on, x) => { if (on) out.push([x, y]); }));
  return out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

/** CE1E truth machine: run a canonical Life pattern N generations. */
export function runCellularGolden(
  renderer: THREE.WebGLRenderer,
  pattern: 'block' | 'blinker' | 'glider',
  generations: number,
  grid = 16,
): { cells: [number, number][]; selfTest: boolean } {
  const kernel = cellularKernel();
  const runner = new SimulationRunner(kernel, grid, grid);
  runner.setUniform('uPreset', 1);
  runner.setUniform('uPattern', pattern === 'block' ? 0 : pattern === 'blinker' ? 1 : 2);
  runner.setUniform('uBirth', CA_RULES.life!.birth);
  runner.setUniform('uSurvive', CA_RULES.life!.survive);
  runner.setUniform('uWrap', 1);
  const probe = new SimProbe(renderer, grid, grid);
  const self = probe.selfTest();
  if (!self.pass) {
    probe.dispose();
    runner.dispose();
    throw new Error(`sim probe self-test failed: ${JSON.stringify(self.detail)}`);
  }
  // advanceExact drives the canonical integer step index, exactly as export
  // does — the goldens therefore validate the EXPORT path too.
  runner.advanceExact(renderer, generations / 60 + 1e-6);
  const buf = probe.readState(runner.texture);
  const cells = liveCells(cellGrid(buf, grid, grid));
  probe.dispose();
  runner.dispose();
  return { cells, selfTest: self.pass };
}

/** RD numeric run: stats after N steps (§50-51). */
export function runRdGolden(
  renderer: THREE.WebGLRenderer,
  steps: number,
  opts: { seed?: number; feed?: number; kill?: number; size?: number } = {},
): StateStats & { stepIndex: number } {
  const size = opts.size ?? 128;
  const runner = new SimulationRunner(reactionDiffusionKernel(), size, size);
  runner.setUniform('uSeed', opts.seed ?? 1);
  runner.setUniform('uFeed', opts.feed ?? 0.055);
  runner.setUniform('uKill', opts.kill ?? 0.062);
  const probe = new SimProbe(renderer, size, size);
  if (!probe.selfTest().pass) {
    probe.dispose();
    runner.dispose();
    throw new Error('sim probe self-test failed');
  }
  runner.advanceExact(renderer, steps / 60 + 1e-6);
  const stats = stateStats(probe.readState(runner.texture));
  const stepIndex = runner.stepIndex;
  probe.dispose();
  runner.dispose();
  return { ...stats, stepIndex };
}

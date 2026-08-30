import * as THREE from 'three';
import { GLSL_LUMINANCE } from '@/rendering/shaders/chunks';
import { disposeSceneGeometry } from '@/rendering/disposeScene';
import type { RawVisualStats } from '@/signals/visual/types';
import { REDUCE_FACTOR, decodeStats, levelSizes } from './reductionLadder';

/**
 * v0.4A A2 — source frame → four scalars, entirely on the GPU.
 *
 * One extract pass packs the per-texel quantities, then 4×4 sum passes walk
 * the ladder down to a tile of at most 8×8, and only that tile is read back —
 * typically 5×3 RGBA floats, 240 bytes. Reading the frame itself would be the
 * whole thing this design exists to avoid.
 *
 * Channels (see reductionLadder.ts for why B is unweighted):
 *   R = luma   G = |flow|   B = flow.x signed   A = coverage
 *
 * Targets are NoColorSpace on purpose: SRGBColorSpace would make three encode
 * on write and quietly destroy the numbers.
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }
`;

const EXTRACT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSource;
uniform sampler2D uFlow;
uniform float uHasFlow;
${GLSL_LUMINANCE}
void main() {
  float luma = matLuminance(texture2D(uSource, vUv).rgb);
  vec2 f = uHasFlow > 0.5 ? texture2D(uFlow, vUv).xy : vec2(0.0);
  float mag = length(f);
  // B carries the SIGNED x, unweighted: the magnitude weight cancels in the
  // ratio ΣB/Σ|f|, so no fifth accumulator is needed.
  gl_FragColor = vec4(luma, mag, f.x, 1.0);
}
`;

const REDUCE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uSrcSize;
void main() {
  vec2 base = floor(gl_FragCoord.xy) * ${REDUCE_FACTOR}.0;
  vec4 acc = vec4(0.0);
  for (int j = 0; j < ${REDUCE_FACTOR}; j++) {
    for (int i = 0; i < ${REDUCE_FACTOR}; i++) {
      vec2 p = base + vec2(float(i), float(j));
      // Out-of-range children are SKIPPED. Clamp-to-edge would duplicate edge
      // texels and bias the mean on odd dimensions; coverage in A is what
      // makes the skip exact.
      if (p.x < uSrcSize.x && p.y < uSrcSize.y) {
        acc += texture2D(uSrc, (p + 0.5) / uSrcSize);
      }
    }
  }
  gl_FragColor = acc;
}
`;

function statsTarget(width: number, height: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: false,
    stencilBuffer: false,
    type: THREE.FloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    colorSpace: THREE.NoColorSpace,
  });
}

function fsqScene(material: THREE.ShaderMaterial): THREE.Scene {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return scene;
}

export class ImageStatsReducer {
  private extractMat: THREE.ShaderMaterial;
  private reduceMat: THREE.ShaderMaterial;
  private extractScene: THREE.Scene;
  private reduceScene: THREE.Scene;
  private camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);

  private levels: THREE.WebGLRenderTarget[] = [];
  private gridWidth = 0;
  private gridHeight = 0;
  private readbackBuffer: Float32Array = new Float32Array(0);

  private lastFrameKey: string | null = null;
  private lastStats: RawVisualStats | null = null;

  /** Diagnostics: how many times the ladder actually ran. */
  reductions = 0;

  constructor() {
    this.extractMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: EXTRACT_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uSource: { value: null },
        uFlow: { value: null },
        uHasFlow: { value: 0 },
      },
    });
    this.reduceMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: REDUCE_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uSrc: { value: null },
        uSrcSize: { value: new THREE.Vector2(1, 1) },
      },
    });
    this.extractScene = fsqScene(this.extractMat);
    this.reduceScene = fsqScene(this.reduceMat);
  }

  get resolution(): { width: number; height: number } {
    return { width: this.gridWidth, height: this.gridHeight };
  }

  get bytes(): number {
    return this.levels.reduce((sum, t) => sum + t.width * t.height * 16, 0);
  }

  /** Latest result, or null before the first analysis. */
  get stats(): RawVisualStats | null {
    return this.lastStats;
  }

  private allocate(width: number, height: number): void {
    if (width === this.gridWidth && height === this.gridHeight) return;
    this.disposeTargets();
    this.gridWidth = width;
    this.gridHeight = height;
    this.levels = [statsTarget(width, height)];
    for (const [w, h] of levelSizes(width, height)) this.levels.push(statsTarget(w, h));
    const tile = this.levels[this.levels.length - 1] as THREE.WebGLRenderTarget;
    this.readbackBuffer = new Float32Array(tile.width * tile.height * 4);
    this.lastFrameKey = null;
  }

  private draw(
    renderer: THREE.WebGLRenderer,
    target: THREE.WebGLRenderTarget,
    scene: THREE.Scene,
  ): void {
    const prev = renderer.getRenderTarget();
    // No setViewport after setRenderTarget — it multiplies by pixelRatio and
    // would confine the pass to a quadrant (the CE1D-2 trap).
    renderer.setRenderTarget(target);
    renderer.setScissorTest(false);
    renderer.render(scene, this.camera);
    renderer.setRenderTarget(prev);
  }

  /**
   * Reduce one source frame. Returns the cached result when `frameKey` has not
   * changed — the same frame is never reduced twice.
   */
  analyse(
    renderer: THREE.WebGLRenderer,
    source: THREE.Texture | null,
    flow: THREE.Texture | null,
    gridWidth: number,
    gridHeight: number,
    frameKey: string,
  ): RawVisualStats | null {
    if (!source || gridWidth < 1 || gridHeight < 1) return this.lastStats;
    this.allocate(gridWidth, gridHeight);
    if (frameKey === this.lastFrameKey) return this.lastStats;

    const eu = this.extractMat.uniforms;
    eu.uSource!.value = source;
    eu.uFlow!.value = flow;
    eu.uHasFlow!.value = flow ? 1 : 0;
    this.draw(renderer, this.levels[0] as THREE.WebGLRenderTarget, this.extractScene);

    for (let i = 1; i < this.levels.length; i++) {
      const src = this.levels[i - 1] as THREE.WebGLRenderTarget;
      const dst = this.levels[i] as THREE.WebGLRenderTarget;
      const ru = this.reduceMat.uniforms;
      ru.uSrc!.value = src.texture;
      (ru.uSrcSize!.value as THREE.Vector2).set(src.width, src.height);
      this.draw(renderer, dst, this.reduceScene);
    }

    const tile = this.levels[this.levels.length - 1] as THREE.WebGLRenderTarget;
    renderer.readRenderTargetPixels(tile, 0, 0, tile.width, tile.height, this.readbackBuffer);
    const gl = renderer.getContext();
    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      throw new Error(`glGetError after stats readback: 0x${err.toString(16)}`);
    }

    this.lastFrameKey = frameKey;
    this.reductions++;
    this.lastStats = decodeStats(this.readbackBuffer, gridWidth, flow !== null);
    return this.lastStats;
  }

  /** Drop cached results — a new source must not inherit the old frame's key. */
  reset(): void {
    this.lastFrameKey = null;
    this.lastStats = null;
  }

  private disposeTargets(): void {
    for (const t of this.levels) t.dispose();
    this.levels = [];
  }

  dispose(): void {
    this.disposeTargets();
    this.extractMat.dispose();
    this.reduceMat.dispose();
    disposeSceneGeometry(this.extractScene);
    disposeSceneGeometry(this.reduceScene);
  }
}

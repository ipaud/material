import * as THREE from 'three';
import { GLSL_LUMINANCE } from '@/rendering/shaders/chunks';
import { disposeSceneGeometry } from '@/rendering/disposeScene';
import type { RawVisualStats } from '@/signals/visual/types';
import {
  ACTIVITY_TEXELS,
  MOTION_PLANES,
  REDUCE_FACTOR,
  decodeStats,
  levelSizes,
} from './reductionLadder';

/**
 * v0.4A/B — source frame → nine scalars, entirely on the GPU.
 *
 * One extract pass packs the per-texel quantities, then 4×4 sum passes walk
 * the ladder down to a tile of at most 8×8, and only that tile is read back —
 * typically 5×3 texels per plane. Reading the frame itself would be the whole
 * thing this design exists to avoid.
 *
 * v0.4B needed six more sums than four channels hold, so the ladder became
 * MRT: one to three RGBA32F attachments carried through every level together.
 * Running a second ladder instead would have cost a second readback, and the
 * readback stall — not the arithmetic — is what this subsystem pays for.
 *
 * TWO CONFIGURATIONS, chosen by demand:
 *   planes = 1   image signals only. No flow texture, one attachment, and the
 *                final tile is read straight back.
 *   planes = 3   any motion signal. Three attachments, plus one tiny PACK draw
 *                that stacks the three final tiles into a single target so the
 *                readback stays at exactly ONE sync point.
 *
 * Targets are NoColorSpace on purpose: SRGBColorSpace would make three encode
 * on write and quietly destroy the numbers.
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }
`;

/** Shared preamble declaring `planes` fragment outputs.
 *
 * three rewrites every ShaderMaterial to `#version 300 es` regardless, and
 * with glslVersion: GLSL3 it stops declaring `pc_fragColor` for us — so the
 * repo's ESSL1 idiom (`varying`, `texture2D`) still reads correctly here while
 * the outputs are explicit. */
const outputs = (planes: number): string =>
  Array.from({ length: planes }, (_, i) => `layout(location = ${i}) out vec4 o${i};`).join('\n');

const extractFrag = (planes: number): string => /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSource;
uniform sampler2D uFlow;
uniform vec2 uTexel;
uniform float uActivityGate;
${outputs(planes)}
${GLSL_LUMINANCE}

float lumaAt(vec2 uv) { return matLuminance(texture2D(uSource, uv).rgb); }

void main() {
  float luma = lumaAt(vUv);

  // Central difference at the ANALYSIS grid spacing. Structure is measured at
  // the resolution we analyse, which is the only scale the ladder can see.
  float gx = (lumaAt(vUv + vec2(uTexel.x, 0.0)) - lumaAt(vUv - vec2(uTexel.x, 0.0))) * 0.5;
  float gy = (lumaAt(vUv + vec2(0.0, uTexel.y)) - lumaAt(vUv - vec2(0.0, uTexel.y))) * 0.5;

  // A carries the sample count. Texels outside an odd-sized parent contribute
  // (0,0,0,0) and so change neither numerator nor denominator — which is why
  // the mean is unbiased on any dimensions, and why Sum(A) is an exact integer.
  o0 = vec4(luma, luma * luma, length(vec2(gx, gy)), 1.0);
${
  planes > 1
    ? /* glsl */ `
  vec2 f = texture2D(uFlow, vUv).xy;
  float mag = length(f);
  // B/G carry the SIGNED components, unweighted: the magnitude weight cancels
  // in the ratio Sum(f.x)/Sum(|f|), so no extra accumulator is needed.
  o1 = vec4(mag, f.x, f.y, mag > uActivityGate ? 1.0 : 0.0);
  // First moments of the magnitude. vUv.y is flipped so that plane 2's G
  // decodes as "0 = top", matching how a viewer describes the image.
  o2 = vec4(vUv.x * mag, (1.0 - vUv.y) * mag, 0.0, 0.0);`
    : ''
}
}
`;

const reduceFrag = (planes: number): string => /* glsl */ `
precision highp float;
uniform sampler2D uSrc0;
uniform sampler2D uSrc1;
uniform sampler2D uSrc2;
uniform vec2 uSrcSize;
${outputs(planes)}
void main() {
  vec2 base = floor(gl_FragCoord.xy) * ${REDUCE_FACTOR}.0;
  vec4 a0 = vec4(0.0);
  vec4 a1 = vec4(0.0);
  vec4 a2 = vec4(0.0);
  for (int j = 0; j < ${REDUCE_FACTOR}; j++) {
    for (int i = 0; i < ${REDUCE_FACTOR}; i++) {
      vec2 p = base + vec2(float(i), float(j));
      // Out-of-range children are SKIPPED. Clamp-to-edge would duplicate edge
      // texels and bias the mean on odd dimensions; coverage in A is what
      // makes the skip exact.
      if (p.x < uSrcSize.x && p.y < uSrcSize.y) {
        vec2 uv = (p + 0.5) / uSrcSize;
        a0 += texture2D(uSrc0, uv);
${planes > 1 ? '        a1 += texture2D(uSrc1, uv);\n        a2 += texture2D(uSrc2, uv);' : ''}
      }
    }
  }
  o0 = a0;
${planes > 1 ? '  o1 = a1;\n  o2 = a2;' : ''}
}
`;

/** Stack the three final tiles vertically into one target, so the CPU pays for
 * exactly one GPU sync instead of three. */
const PACK_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uSrc0;
uniform sampler2D uSrc1;
uniform sampler2D uSrc2;
uniform vec2 uTileSize;
void main() {
  vec2 p = floor(gl_FragCoord.xy);
  float plane = floor(p.y / uTileSize.y);
  vec2 uv = (vec2(p.x, mod(p.y, uTileSize.y)) + 0.5) / uTileSize;
  gl_FragColor = plane < 0.5
    ? texture2D(uSrc0, uv)
    : (plane < 1.5 ? texture2D(uSrc1, uv) : texture2D(uSrc2, uv));
}
`;

function statsTarget(width: number, height: number, count = 1): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: false,
    stencilBuffer: false,
    type: THREE.FloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    colorSpace: THREE.NoColorSpace,
    count,
  });
}

function fsqScene(material: THREE.ShaderMaterial): THREE.Scene {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return scene;
}

interface Pipeline {
  planes: number;
  extractMat: THREE.ShaderMaterial;
  reduceMat: THREE.ShaderMaterial;
  extractScene: THREE.Scene;
  reduceScene: THREE.Scene;
}

function buildPipeline(planes: number): Pipeline {
  const extractMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader: extractFrag(planes),
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uSource: { value: null },
      uFlow: { value: null },
      uTexel: { value: new THREE.Vector2(1, 1) },
      uActivityGate: { value: 0 },
    },
  });
  const reduceMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader: reduceFrag(planes),
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uSrc0: { value: null },
      uSrc1: { value: null },
      uSrc2: { value: null },
      uSrcSize: { value: new THREE.Vector2(1, 1) },
    },
  });
  return {
    planes,
    extractMat,
    reduceMat,
    extractScene: fsqScene(extractMat),
    reduceScene: fsqScene(reduceMat),
  };
}

export class ImageStatsReducer {
  private pipelines = new Map<number, Pipeline>();
  private packMat: THREE.ShaderMaterial;
  private packScene: THREE.Scene;
  private camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);

  private levels: THREE.WebGLRenderTarget[] = [];
  private packTarget: THREE.WebGLRenderTarget | null = null;
  private gridWidth = 0;
  private gridHeight = 0;
  private planes = 0;
  private readbackBuffer: Float32Array = new Float32Array(0);

  private lastFrameKey: string | null = null;
  private lastStats: RawVisualStats | null = null;
  /** Last centroid that meant something. A motion-driven effect should stay
   * where the motion left it rather than snapping to centre the instant a
   * gesture stops; `centroidValid` still reports the truth to diagnostics. */
  private heldCentroid: { x: number; y: number } | null = null;

  /** Diagnostics: how many times the ladder actually ran. */
  reductions = 0;

  constructor() {
    this.packMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: PACK_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uSrc0: { value: null },
        uSrc1: { value: null },
        uSrc2: { value: null },
        uTileSize: { value: new THREE.Vector2(1, 1) },
      },
    });
    this.packScene = fsqScene(this.packMat);
  }

  get resolution(): { width: number; height: number } {
    return { width: this.gridWidth, height: this.gridHeight };
  }

  get bytes(): number {
    const levels = this.levels.reduce((sum, t) => sum + t.width * t.height * 16 * this.planes, 0);
    const pack = this.packTarget ? this.packTarget.width * this.packTarget.height * 16 : 0;
    return levels + pack;
  }

  /** Diagnostics: draws per analysis, and bytes moved across the sync point. */
  get passes(): { draws: number; readbacks: number; readbackBytes: number } {
    if (this.levels.length === 0) return { draws: 0, readbacks: 0, readbackBytes: 0 };
    const packDraw = this.planes > 1 ? 1 : 0;
    return {
      draws: this.levels.length + packDraw,
      readbacks: 1,
      readbackBytes: this.readbackBuffer.byteLength,
    };
  }

  /** Latest result, or null before the first analysis. */
  get stats(): RawVisualStats | null {
    return this.lastStats;
  }

  private pipeline(planes: number): Pipeline {
    let p = this.pipelines.get(planes);
    if (!p) {
      p = buildPipeline(planes);
      this.pipelines.set(planes, p);
    }
    return p;
  }

  private allocate(width: number, height: number, planes: number): void {
    if (width === this.gridWidth && height === this.gridHeight && planes === this.planes) return;
    this.disposeTargets();
    this.gridWidth = width;
    this.gridHeight = height;
    this.planes = planes;
    this.levels = [statsTarget(width, height, planes)];
    for (const [w, h] of levelSizes(width, height)) this.levels.push(statsTarget(w, h, planes));
    const tile = this.levels[this.levels.length - 1] as THREE.WebGLRenderTarget;
    if (planes > 1) {
      this.packTarget = statsTarget(tile.width, tile.height * planes, 1);
      this.readbackBuffer = new Float32Array(tile.width * tile.height * planes * 4);
    } else {
      this.packTarget = null;
      this.readbackBuffer = new Float32Array(tile.width * tile.height * 4);
    }
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
    const planes = flow ? MOTION_PLANES : 1;
    this.allocate(gridWidth, gridHeight, planes);
    if (frameKey === this.lastFrameKey) return this.lastStats;

    const pipe = this.pipeline(planes);
    const eu = pipe.extractMat.uniforms;
    eu.uSource!.value = source;
    eu.uFlow!.value = flow;
    (eu.uTexel!.value as THREE.Vector2).set(1 / gridWidth, 1 / gridHeight);
    // The activity threshold is stated in texels and applied in uv, so the same
    // gesture counts as moving whatever grid the analysis happens to run at.
    eu.uActivityGate!.value = ACTIVITY_TEXELS / gridWidth;
    this.draw(renderer, this.levels[0] as THREE.WebGLRenderTarget, pipe.extractScene);

    for (let i = 1; i < this.levels.length; i++) {
      const src = this.levels[i - 1] as THREE.WebGLRenderTarget;
      const dst = this.levels[i] as THREE.WebGLRenderTarget;
      const ru = pipe.reduceMat.uniforms;
      ru.uSrc0!.value = src.textures[0] ?? src.texture;
      ru.uSrc1!.value = src.textures[1] ?? null;
      ru.uSrc2!.value = src.textures[2] ?? null;
      (ru.uSrcSize!.value as THREE.Vector2).set(src.width, src.height);
      this.draw(renderer, dst, pipe.reduceScene);
    }

    const tile = this.levels[this.levels.length - 1] as THREE.WebGLRenderTarget;
    let readFrom: THREE.WebGLRenderTarget = tile;
    if (this.packTarget) {
      const pu = this.packMat.uniforms;
      pu.uSrc0!.value = tile.textures[0] ?? tile.texture;
      pu.uSrc1!.value = tile.textures[1] ?? null;
      pu.uSrc2!.value = tile.textures[2] ?? null;
      (pu.uTileSize!.value as THREE.Vector2).set(tile.width, tile.height);
      this.draw(renderer, this.packTarget, this.packScene);
      readFrom = this.packTarget;
    }
    renderer.readRenderTargetPixels(
      readFrom,
      0,
      0,
      readFrom.width,
      readFrom.height,
      this.readbackBuffer,
    );
    const gl = renderer.getContext();
    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      throw new Error(`glGetError after stats readback: 0x${err.toString(16)}`);
    }

    this.lastFrameKey = frameKey;
    this.reductions++;
    const stats = decodeStats(
      this.readbackBuffer,
      tile.width,
      tile.height,
      gridWidth,
      flow !== null,
    );
    this.lastStats = this.withHeldCentroid(stats);
    return this.lastStats;
  }

  private withHeldCentroid(stats: RawVisualStats): RawVisualStats {
    if (stats.centroidValid) {
      this.heldCentroid = { x: stats.centroidX, y: stats.centroidY };
      return stats;
    }
    if (!this.heldCentroid) return stats;
    return { ...stats, centroidX: this.heldCentroid.x, centroidY: this.heldCentroid.y };
  }

  /** Drop cached results — a new source must not inherit the old frame's key,
   * nor the position where the previous source's motion happened to stop. */
  reset(): void {
    this.lastFrameKey = null;
    this.lastStats = null;
    this.heldCentroid = null;
  }

  private disposeTargets(): void {
    for (const t of this.levels) t.dispose();
    this.levels = [];
    this.packTarget?.dispose();
    this.packTarget = null;
  }

  dispose(): void {
    this.disposeTargets();
    for (const p of this.pipelines.values()) {
      p.extractMat.dispose();
      p.reduceMat.dispose();
      disposeSceneGeometry(p.extractScene);
      disposeSceneGeometry(p.reduceScene);
    }
    this.pipelines.clear();
    this.packMat.dispose();
    disposeSceneGeometry(this.packScene);
  }
}

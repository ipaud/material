import * as THREE from 'three';
import { disposeSceneGeometry } from '../disposeScene';

/**
 * CE1D — the OPTICAL FLOW primitive. ONE per renderer, shared by every
 * consumer (Flow Displace/Feedback, Motion Mosh/Trails/RGB, Directional
 * Smear, Time Field Motion): the engine calls update() once per rendered
 * frame with the source frame identity; the same source frame is NEVER
 * recomputed (a 30fps camera yields ~30 flow updates/s under a 120Hz
 * renderer — hard gate §83).
 *
 * Algorithm: dense single-scale Lucas–Kanade over reduced-resolution
 * luminance, one smoothing pass. Chosen over Horn–Schunck (10–50 iterative
 * passes) and block matching (search cost, blocky output) — see ADR. No
 * pyramid in v1: artistic gain covers the useful motion range.
 *
 * Pipeline (3 small passes at ≤320×180):
 *   source → luma downsample (ping-pong prev/curr)
 *   (prev,curr) → Lucas–Kanade → raw signed flow (RG16F)
 *   raw → 9-tap blur → flow texture (RG = signed UV motion per frame)
 *
 * Source-space analysis (§9): flow reads SOURCE pixels, never the styled
 * output — reusable, stable, and exactly what v0.4 signal extraction
 * (motion amount/x/y/centroid) will consume without replacing this class.
 * GPU-only: no readPixels anywhere in the normal path.
 */

export const FLOW_MAX_DIM = 320;

const FSQ_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }
`;

// Packs BOTH frames in one texture: R = current luma (blurred), G = the
// previous R carried over from the ping-pong partner. The flow pass then
// samples a single texture — sampling two separate luma RTs inside one
// fragment produced all-zero reads on this stack (measured; see ADR).
const LUMA_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform sampler2D uPrevPacked;
uniform vec2 uTexel;
float lum(vec2 o) {
  return dot(texture2D(uTex, vUv + o).rgb, vec3(0.2126, 0.7152, 0.0722));
}
void main() {
  // Small blur widens gradients so single-scale LK catches a few px of
  // motion (hard edges are otherwise invisible past ~1px).
  float l = lum(vec2(0.0)) * 4.0
    + (lum(vec2(uTexel.x, 0.0)) + lum(vec2(-uTexel.x, 0.0))
     + lum(vec2(0.0, uTexel.y)) + lum(vec2(0.0, -uTexel.y))) * 2.0
    + (lum(uTexel) + lum(-uTexel)
     + lum(vec2(uTexel.x, -uTexel.y)) + lum(vec2(-uTexel.x, uTexel.y)));
  float prevR = texture2D(uPrevPacked, vUv).r;
  gl_FragColor = vec4(l / 16.0, prevR, 0.0, 1.0);
}
`;

// Dense Lucas–Kanade: per pixel solve the 2x2 system from a 5x5 window of
// spatial gradients against the temporal difference. Original
// implementation from the classic formulation (Lucas & Kanade 1981).
export const LK_FRAG_EXPORTED = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uPacked; // R = current luma, G = previous luma
uniform vec2 uTexel;

void main() {
  float a11 = 0.0, a12 = 0.0, a22 = 0.0, b1 = 0.0, b2 = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 o = vUv + vec2(float(x), float(y)) * uTexel;
      vec2 xp = texture2D(uPacked, o + vec2(uTexel.x, 0.0)).rg;
      vec2 xm = texture2D(uPacked, o - vec2(uTexel.x, 0.0)).rg;
      vec2 yp = texture2D(uPacked, o + vec2(0.0, uTexel.y)).rg;
      vec2 ym = texture2D(uPacked, o - vec2(0.0, uTexel.y)).rg;
      vec2 ct = texture2D(uPacked, o).rg;
      // Classic LK: spatial gradients averaged over BOTH frames.
      float ix = ((xp.x - xm.x) + (xp.y - xm.y)) * 0.25;
      float iy = ((yp.x - ym.x) + (yp.y - ym.y)) * 0.25;
      float it = ct.x - ct.y;
      a11 += ix * ix; a12 += ix * iy; a22 += iy * iy;
      b1 += ix * it;  b2 += iy * it;
    }
  }
  // Tikhonov regularization ON THE DIAGONAL: pure-aperture edges (a22≈0 on
  // a vertical edge) must still solve their 1-D component — regularizing
  // the determinant alone collapses exactly those cases to zero (measured:
  // a flat moving square produced an all-zero field). Low-texture regions
  // (all terms ≈0) still yield ≈0 flow — built-in confidence (§21).
  float reg = 1e-3;
  a11 += reg;
  a22 += reg;
  float det = a11 * a22 - a12 * a12;
  vec2 flow;
  flow.x = (-a22 * b1 + a12 * b2) / det;
  flow.y = ( a12 * b1 - a11 * b2) / det;
  // Clamp to a sane per-frame displacement (in analysis texels).
  flow = clamp(flow, vec2(-8.0), vec2(8.0)) * uTexel;
  gl_FragColor = vec4(flow, 0.0, 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
void main() {
  vec2 acc = vec2(0.0);
  float wsum = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      float w = (x == 0 && y == 0) ? 4.0 : ((x == 0 || y == 0) ? 2.0 : 1.0);
      acc += texture2D(uTex, vUv + vec2(float(x), float(y)) * uTexel).rg * w;
      wsum += w;
    }
  }
  gl_FragColor = vec4(acc / wsum, 0.0, 1.0);
}
`;

export class OpticalFlowField {
  constructor(private readonly maxDim: number = FLOW_MAX_DIM) {
    this.lumaScene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.lumaMat));
    this.lkScene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.lkMat));
    this.blurScene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.blurMat));
  }

  private width = 0;
  private height = 0;
  private lumaA: THREE.WebGLRenderTarget | null = null;
  private lumaB: THREE.WebGLRenderTarget | null = null;
  private lumaFlip = false;
  private rawFlow: THREE.WebGLRenderTarget | null = null;
  private smoothFlow: THREE.WebGLRenderTarget | null = null;
  private lastFrameKey: string | null = null;
  private hasPrev = false;
  /** Diagnostics: how many unique source frames produced a flow update. */
  updates = 0;
  /** Real LK solves since the last prime. The priming update CLEARS the field,
   * so its all-zero result is not a measurement of anything — a consumer that
   * treats it as "no motion" feeds a false extreme to whatever it drives. */
  private solves = 0;

  private camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  private lumaMat = new THREE.ShaderMaterial({ vertexShader: FSQ_VERT, fragmentShader: LUMA_FRAG, depthTest: false, depthWrite: false, uniforms: { uTex: { value: null }, uPrevPacked: { value: null }, uTexel: { value: new THREE.Vector2() } } });
  private lkMat = new THREE.ShaderMaterial({ vertexShader: FSQ_VERT, fragmentShader: LK_FRAG_EXPORTED, depthTest: false, depthWrite: false, uniforms: { uPacked: { value: null }, uTexel: { value: new THREE.Vector2() } } });
  private blurMat = new THREE.ShaderMaterial({ vertexShader: FSQ_VERT, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false, uniforms: { uTex: { value: null }, uTexel: { value: new THREE.Vector2() } } });
  // One scene per pass — a shared mesh whose material is swapped between
  // offscreen renders proved unreliable; FeedbackStep's fixed pairing works.
  private lumaScene = new THREE.Scene();
  private lkScene = new THREE.Scene();
  private blurScene = new THREE.Scene();

  /** Bounded analysis resolution: long side ≤ FLOW_MAX_DIM, aspect kept. */
  private allocate(srcW: number, srcH: number): void {
    const scale = this.maxDim / Math.max(srcW, srcH, 1);
    const w = Math.max(Math.round(srcW * Math.min(scale, 1)), 16);
    const h = Math.max(Math.round(srcH * Math.min(scale, 1)), 16);
    if (w === this.width && h === this.height && this.lumaA) return;
    this.disposeTargets();
    this.width = w;
    this.height = h;
    const luma = () =>
      new THREE.WebGLRenderTarget(w, h, {
        depthBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
    this.lumaA = luma();
    this.lumaB = luma();
    const flow = () =>
      new THREE.WebGLRenderTarget(w, h, {
        depthBuffer: false,
        // FloatType (RGBA32F): renderable under EXT_color_buffer_float and
        // readable straight into Float32Array — 2.3MB total at 320×180,
        // chosen over half-float for robust QA readback (see ADR).
        type: THREE.FloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
    this.rawFlow = flow();
    this.smoothFlow = flow();
    this.hasPrev = false;
    this.lastFrameKey = null;
  }

  /** Signed RG flow texture (uv units per source frame), or null pre-prime. */
  texture(): THREE.Texture | null {
    return this.smoothFlow?.texture ?? null;
  }

  get resolution(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /**
   * Advance the analysis. `frameKey` is the source frame identity — same
   * key returns immediately (the shared-service cache, §30-31). A null
   * source or a first frame primes with zero flow (§13-14).
   */
  update(
    renderer: THREE.WebGLRenderer,
    source: THREE.Texture | null,
    srcW: number,
    srcH: number,
    frameKey: string,
  ): void {
    if (!source || srcW < 2 || srcH < 2) return;
    this.allocate(srcW, srcH);
    if (frameKey === this.lastFrameKey) return; // same source frame: reuse
    this.lastFrameKey = frameKey;

    const draw = (target: THREE.WebGLRenderTarget, scene: THREE.Scene) => {
      const prev = renderer.getRenderTarget();
      // No manual setViewport: setRenderTarget already applies the RT's
      // full viewport WITHOUT pixelRatio; setViewport would ×2 it and
      // confine every pass to the lower-left quadrant (the CE1D bug).
      renderer.setRenderTarget(target);
      renderer.setScissorTest(false);
      renderer.render(scene, this.camera);
      renderer.setRenderTarget(prev);
    };

    // 1. packed luma: R = luma(source), G = previous packed R (ping-pong)
    const packedNew = this.lumaFlip ? this.lumaA! : this.lumaB!;
    const packedOld = this.lumaFlip ? this.lumaB! : this.lumaA!;
    this.lumaMat.uniforms.uTex!.value = source;
    this.lumaMat.uniforms.uPrevPacked!.value = packedOld.texture;
    (this.lumaMat.uniforms.uTexel!.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
    draw(packedNew, this.lumaScene);

    if (!this.hasPrev) {
      // First frame: run once more so G carries the same frame → it = 0,
      // and clear the flow targets. No garbage first field (§14).
      this.lumaMat.uniforms.uPrevPacked!.value = packedNew.texture;
      draw(packedOld, this.lumaScene);
      const prev = renderer.getRenderTarget();
      for (const t of [this.rawFlow!, this.smoothFlow!]) {
        renderer.setRenderTarget(t);
        renderer.setClearColor(0x000000, 1);
        renderer.clear();
      }
      renderer.setRenderTarget(prev);
      this.hasPrev = true;
      this.updates++;
      return;
    }

    // 2. Lucas–Kanade over the single packed texture (R = now, G = before)
    this.lkMat.uniforms.uPacked!.value = packedNew.texture;
    (this.lkMat.uniforms.uTexel!.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
    draw(this.rawFlow!, this.lkScene);

    // 3. smooth
    this.blurMat.uniforms.uTex!.value = this.rawFlow!.texture;
    (this.blurMat.uniforms.uTexel!.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
    draw(this.smoothFlow!, this.blurScene);

    this.lumaFlip = !this.lumaFlip; // curr becomes prev for the next frame
    this.updates++;
    this.solves++;
  }

  /**
   * True once the field is measuring the CURRENT source at its normal cadence.
   *
   * Two solves, not one. The priming update clears the targets, so its zero is
   * not a measurement — that much was known. But the first real solve is not
   * one either: it compares the two frames that straddle the discontinuity,
   * which at a source switch, a seek, or a slow first frame can be arbitrarily
   * far apart. Measured on a generator switch: the first solve read 9.435
   * analysis texels/frame against a steady-state median of 0.363, and because
   * it SEEDED the motion calibrator's envelope, the knob sat at zero for
   * several seconds afterwards while the range decayed back.
   *
   * From the second solve on, both frames come from the same source at the
   * loop's own cadence.
   */
  get ready(): boolean {
    return this.solves > 1;
  }

  /** Discontinuity (seek, loop, source switch, context restore): next
   * update primes fresh — no giant vectors from unrelated frames (§15). */
  reset(): void {
    this.hasPrev = false;
    this.lastFrameKey = null;
    this.solves = 0;
  }

  get bytes(): number {
    // 2×luma RGBA8 (4 B/px) + 2×flow RGBA32F (16 B/px) at analysis resolution.
    // The old comment claimed RGBA16F and under-reported by ~40%; the targets
    // are created with THREE.FloatType above.
    return this.width * this.height * (4 * 2 + 16 * 2);
  }

  private disposeTargets(): void {
    this.lumaA?.dispose();
    this.lumaB?.dispose();
    this.rawFlow?.dispose();
    this.smoothFlow?.dispose();
    this.lumaA = this.lumaB = this.rawFlow = this.smoothFlow = null;
  }

  dispose(): void {
    this.disposeTargets();
    this.lumaMat.dispose();
    this.lkMat.dispose();
    this.blurMat.dispose();
    disposeSceneGeometry(this.lumaScene);
    disposeSceneGeometry(this.lkScene);
    disposeSceneGeometry(this.blurScene);
  }
}

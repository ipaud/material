import * as THREE from 'three';
import type { ParamRecord } from '@shared/schemas/project';
import type { TechniqueContext, TechniqueRenderer } from '../types';
import { FeedbackClock, FeedbackSurface } from '@/rendering/feedback/FeedbackSurface';
import { FeedbackStep, type FeedbackVariant } from '@/rendering/feedback/feedbackStep';

/**
 * CE1B — one TechniqueRenderer for the whole feedback family.
 *
 * The visible object is a composition-sized quad showing the surface's READ
 * texture, mixed against the dry source by `Mix`. All evolution happens in
 * the prepass (engine calls `feedbackPrepass` before rendering the scene):
 * N clock-driven ping-pong steps of the shared FeedbackStep shader.
 *
 * Per-variant behavior is uniforms + defines — see feedbackStep.ts. Bloom
 * composes the same step with a threshold+blur+combine tail.
 */

const VIEW_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D uState;
uniform sampler2D uSource;
uniform float uMix;
void main() {
  vec4 dry = texture2D(uSource, vUv);
  vec4 wet = texture2D(uState, vUv);
  gl_FragColor = vec4(mix(dry.rgb, wet.rgb, uMix), 1.0);
}
`;

const VIEW_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
uniform float uThreshold;
uniform int uPassKind; // 0 threshold, 1 blur, 2 combine
uniform sampler2D uBase;
uniform float uGain;
void main() {
  if (uPassKind == 0) {
    vec3 c = texture2D(uTex, vUv).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + 0.12, l), 1.0);
  } else if (uPassKind == 1) {
    vec3 acc = vec3(0.0);
    float w[5];
    w[0] = 0.227; w[1] = 0.194; w[2] = 0.121; w[3] = 0.054; w[4] = 0.016;
    acc += texture2D(uTex, vUv).rgb * w[0];
    for (int i = 1; i < 5; i++) {
      vec2 o = uDir * float(i);
      acc += texture2D(uTex, vUv + o).rgb * w[i];
      acc += texture2D(uTex, vUv - o).rgb * w[i];
    }
    gl_FragColor = vec4(acc, 1.0);
  } else {
    vec3 base = texture2D(uBase, vUv).rgb;
    vec3 glow = texture2D(uTex, vUv).rgb;
    gl_FragColor = vec4(base + glow * uGain, 1.0);
  }
}
`;

export class FeedbackRenderer implements TechniqueRenderer {
  readonly object3d: THREE.Object3D;
  /** Engine marker: keeps the render loop alive while this technique runs. */
  readonly feedback = true as const;
  /** CE1D: flow-driven variants consume the shared optical-flow service. */
  readonly usesFlow: boolean;

  private surface: FeedbackSurface | null = null;
  private step: FeedbackStep;
  private clock = new FeedbackClock();
  private stepIndex = 0;
  private viewMaterial: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  private params: ParamRecord = {};
  private ctx: TechniqueContext | null = null;
  private needsReset = true;

  // Bloom tail (allocated only for the bloom variant, half resolution).
  private bloomA: THREE.WebGLRenderTarget | null = null;
  private bloomB: THREE.WebGLRenderTarget | null = null;
  private bloomOut: THREE.WebGLRenderTarget | null = null;
  private bloomMaterial: THREE.ShaderMaterial | null = null;
  private bloomScene: THREE.Scene | null = null;
  private bloomCamera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);

  constructor(
    private variant: FeedbackVariant,
    private bloom = false,
  ) {
    this.usesFlow = variant === 'flow' || variant === 'mosh' || variant === 'trails';
    this.step = new FeedbackStep(variant);
    this.viewMaterial = new THREE.ShaderMaterial({
      vertexShader: VIEW_VERT,
      fragmentShader: VIEW_FRAG,
      uniforms: {
        uState: { value: null },
        uSource: { value: null },
        uMix: { value: 1 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.viewMaterial);
    this.object3d = this.mesh;
    if (bloom) {
      this.bloomMaterial = new THREE.ShaderMaterial({
        vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }`,
        fragmentShader: BLUR_FRAG,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          uTex: { value: null },
          uDir: { value: new THREE.Vector2(0, 0) },
          uThreshold: { value: 0.6 },
          uPassKind: { value: 0 },
          uBase: { value: null },
          uGain: { value: 1 },
        },
      });
      this.bloomScene = new THREE.Scene();
      this.bloomScene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.bloomMaterial));
    }
  }

  /** External reset — source identity change, project switch, context loss,
   * Candidate release. Next prepass primes from the current frame. */
  resetFeedback(): void {
    this.needsReset = true;
  }

  update(params: ParamRecord, ctx: TechniqueContext): void {
    this.params = params;
    this.ctx = ctx;
    this.mesh.scale.set(ctx.compWidth, ctx.compHeight, 1);
    const u = this.viewMaterial.uniforms;
    u.uSource!.value = ctx.sourceTexture;
    u.uMix!.value = num(params.mix, 1);
  }

  /** One prepass per rendered frame; the engine passes the preview clock
   * (wall time) or drives export stepping through exportAdvance below. */
  feedbackPrepass(renderer: THREE.WebGLRenderer, clockSec: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.ensureSurface(ctx.compWidth, ctx.compHeight);
    const steps = this.clock.advance(clockSec);
    this.runSteps(renderer, steps);
  }

  /** Deterministic export stepping between two composition times. */
  exportAdvance(renderer: THREE.WebGLRenderer, fromSec: number, toSec: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.ensureSurface(ctx.compWidth, ctx.compHeight);
    const steps =
      fromSec < 0
        ? FeedbackClock.stepsBetween(0, toSec) // preroll from timeline origin
        : FeedbackClock.stepsBetween(fromSec, toSec);
    this.runSteps(renderer, steps, /* uncapped */ true);
  }

  /** Export initialization: clean state, then preroll 0 → startSec. */
  exportBegin(renderer: THREE.WebGLRenderer, startSec: number): void {
    this.needsReset = true;
    this.clock.reset();
    this.stepIndex = 0;
    this.exportAdvance(renderer, -1, startSec);
  }

  private ensureSurface(w: number, h: number): void {
    if (!this.surface) {
      this.surface = new FeedbackSurface(w, h);
      this.needsReset = true;
    } else if (this.surface.width !== w || this.surface.height !== h) {
      this.surface.resize(w, h);
      this.needsReset = true;
    }
  }

  private runSteps(renderer: THREE.WebGLRenderer, steps: number, uncapped = false): void {
    const surface = this.surface;
    const ctx = this.ctx;
    if (!surface || !ctx) return;
    const p = this.params;

    if (this.needsReset || !surface.primed) {
      surface.reset();
      this.step.prime(renderer, surface, ctx.sourceTexture);
      this.stepIndex = 0;
      this.needsReset = false;
    }

    const u = this.step.material.uniforms;
    u.uPersistence!.value = num(p.persistence, 0.95);
    u.uInjection!.value = num(p.injection, 0.5);
    u.uAspect!.value = ctx.compWidth / Math.max(ctx.compHeight, 1);
    u.uCenter!.value.set(num(p.centerX, 0), num(p.centerY, 0));
    u.uZoom!.value = num(p.zoom, 1);
    // Rotation param is degrees/step in UI; shader wants radians.
    u.uRotate!.value = (num(p.rotation, 0) * Math.PI) / 180;
    u.uDrift!.value.set(num(p.driftX, 0) / 100, num(p.driftY, 0) / 100);
    u.uDispAmount!.value = num(p.amount, 0) / 10;
    u.uDispScale!.value = num(p.scale, 6);
    u.uDispSpeed!.value = num(p.speed, 1);
    u.uSegments!.value = num(p.segments, 6);
    const shift = (deg: number, len: number) =>
      new THREE.Vector2(Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)).multiplyScalar(len / 1000);
    u.uFlowTex!.value = ctx.flow;
    u.uFlowAmt!.value = num(p.flow, 1) * 8;
    u.uMotionThreshold!.value = num(p.threshold, 0.15);
    u.uBlockiness!.value = num(p.blockiness, 0);
    u.uChromaDrift!.value = num(p.chromaDrift, 0);
    u.uShiftR!.value.copy(shift(num(p.redAngle, 0), num(p.redShift, 0)));
    u.uShiftG!.value.copy(shift(num(p.greenAngle, 120), num(p.greenShift, 0)));
    u.uShiftB!.value.copy(shift(num(p.blueAngle, 240), num(p.blueShift, 0)));

    const n = uncapped ? steps : Math.min(steps, 4);
    for (let i = 0; i < n; i++) {
      u.uStep!.value = this.stepIndex++;
      this.step.run(renderer, surface, ctx.sourceTexture);
    }

    let stateTexture: THREE.Texture = surface.read.texture;
    if (this.bloom && n >= 0) stateTexture = this.runBloom(renderer, stateTexture);
    this.viewMaterial.uniforms.uState!.value = stateTexture;
  }

  /** threshold → blur H → blur V → combine (half-res tail, 4 small passes). */
  private runBloom(renderer: THREE.WebGLRenderer, base: THREE.Texture): THREE.Texture {
    const surface = this.surface!;
    const w = Math.max(surface.width >> 1, 8);
    const h = Math.max(surface.height >> 1, 8);
    const make = () =>
      new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, colorSpace: THREE.SRGBColorSpace });
    if (!this.bloomA || this.bloomA.width !== w || this.bloomA.height !== h) {
      this.bloomA?.dispose();
      this.bloomB?.dispose();
      this.bloomOut?.dispose();
      this.bloomA = make();
      this.bloomB = make();
      this.bloomOut = new THREE.WebGLRenderTarget(surface.width, surface.height, {
        depthBuffer: false,
        colorSpace: THREE.SRGBColorSpace,
      });
    }
    const m = this.bloomMaterial!.uniforms;
    const draw = (target: THREE.WebGLRenderTarget, _vw: number, _vh: number) => {
      const prev = renderer.getRenderTarget();
      // No setPixelRatio: render-target viewports are raw pixels in Three.
      renderer.setRenderTarget(target); // full-RT viewport, no ratio (CE1D-2)
      renderer.setScissorTest(false);
      renderer.render(this.bloomScene!, this.bloomCamera);
      renderer.setRenderTarget(prev);
    };
    m.uThreshold!.value = num(this.params.threshold, 0.6);
    m.uGain!.value = num(this.params.gain, 1.2);
    m.uPassKind!.value = 0;
    m.uTex!.value = base;
    draw(this.bloomA!, w, h);
    m.uPassKind!.value = 1;
    m.uTex!.value = this.bloomA!.texture;
    m.uDir!.value.set(num(this.params.radius, 2) / w, 0);
    draw(this.bloomB!, w, h);
    m.uTex!.value = this.bloomB!.texture;
    m.uDir!.value.set(0, num(this.params.radius, 2) / h);
    draw(this.bloomA!, w, h);
    m.uPassKind!.value = 2;
    m.uBase!.value = base;
    m.uTex!.value = this.bloomA!.texture;
    draw(this.bloomOut!, surface.width, surface.height);
    return this.bloomOut!.texture;
  }

  dispose(): void {
    this.surface?.dispose();
    this.surface = null;
    this.step.dispose();
    this.viewMaterial.dispose();
    this.mesh.geometry.dispose();
    this.bloomA?.dispose();
    this.bloomB?.dispose();
    this.bloomOut?.dispose();
    this.bloomMaterial?.dispose();
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

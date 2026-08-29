import * as THREE from 'three';
import { FeedbackSurface } from './FeedbackSurface';

/**
 * The shared feedback STEP: one fullscreen pass that samples the previous
 * state (READ), applies the variant's transform, injects the current source
 * frame, and renders the new state into WRITE. All seven CE1B techniques
 * are this one shader with different uniforms/defines — no per-technique
 * copies (§78).
 *
 * Uniform conventions (§42-43, one meaning everywhere):
 *   uPersistence  0..1   how much of the transformed past survives a step
 *   uInjection    0..1   how much fresh source enters the state
 * The visible technique quad then mixes state against the dry frame with
 * its own `Mix` parameter — persistence/injection shape the STATE, mix
 * shapes the VIEW.
 */

export type FeedbackVariant = 'affine' | 'displace' | 'kaleido' | 'rgb' | 'flow' | 'mosh' | 'trails';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uPrev;
uniform sampler2D uSource;
uniform float uPersistence;
uniform float uInjection;
uniform vec2 uCenter;      // -0.5..0.5 composition space
uniform float uZoom;       // per-step scale of the past
uniform float uRotate;     // radians per step
uniform vec2 uDrift;       // uv per step
uniform float uAspect;     // comp aspect for isotropic transforms
uniform float uStep;       // step index since prime (deterministic anim)
// displace
uniform float uDispAmount;
uniform float uDispScale;
uniform float uDispSpeed;
// kaleido
uniform float uSegments;
// rgb
uniform vec2 uShiftR;
uniform vec2 uShiftG;
uniform vec2 uShiftB;
// CE1D flow-driven variants
uniform sampler2D uFlowTex;
uniform float uFlowAmt;
uniform float uMotionThreshold;
uniform float uBlockiness;
uniform float uChromaDrift;

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
// Cheap value noise — original implementation, animated by step index so
// export stepping reproduces it exactly.
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

vec2 toCentered(vec2 uv) { return (uv - 0.5 - uCenter) * vec2(uAspect, 1.0); }
vec2 fromCentered(vec2 p) { return p / vec2(uAspect, 1.0) + 0.5 + uCenter; }

vec2 affineUv(vec2 uv) {
  vec2 p = toCentered(uv);
  float c = cos(-uRotate);
  float s = sin(-uRotate);
  p = mat2(c, -s, s, c) * p;
  p /= uZoom;
  return fromCentered(p) - uDrift;
}

#ifdef VARIANT_KALEIDO
vec2 kaleidoUv(vec2 uv) {
  vec2 p = toCentered(uv);
  float ang = atan(p.y, p.x);
  float rad = length(p);
  float seg = 6.2831853 / max(uSegments, 2.0);
  ang = mod(ang, seg);
  ang = abs(ang - seg * 0.5);
  return fromCentered(vec2(cos(ang), sin(ang)) * rad);
}
#endif

#if defined(VARIANT_FLOW) || defined(VARIANT_MOSH) || defined(VARIANT_TRAILS)
vec2 flowAt(vec2 uv) {
#ifdef VARIANT_MOSH
  // Blockiness quantizes WHERE flow is read — evokes macroblocks without
  // touching any codec (§44, honest naming).
  float b = max(uBlockiness, 0.0);
  if (b > 0.5) {
    vec2 cells = vec2(mix(160.0, 12.0, clamp(b / 10.0, 0.0, 1.0)));
    uv = (floor(uv * cells) + 0.5) / cells;
  }
#endif
  return texture2D(uFlowTex, uv).rg;
}
#endif

void main() {
  vec2 uv = vUv;
#ifdef VARIANT_KALEIDO
  uv = kaleidoUv(uv);
#endif
#ifdef VARIANT_DISPLACE
  float t = uStep * uDispSpeed * 0.01;
  vec2 np = uv * uDispScale + vec2(t, -t * 0.7);
  vec2 disp = vec2(vnoise(np) - 0.5, vnoise(np + 17.31) - 0.5) * uDispAmount;
  uv += disp;
#endif
  vec2 prevUv = affineUv(uv);
#if defined(VARIANT_FLOW) || defined(VARIANT_MOSH) || defined(VARIANT_TRAILS)
  vec2 fl = flowAt(uv);
  // Advect the past ALONG its own motion: state flows with the image.
  prevUv -= fl * uFlowAmt;
#endif

#ifdef VARIANT_RGB
  float pr = texture2D(uPrev, prevUv + uShiftR).r;
  float pg = texture2D(uPrev, prevUv + uShiftG).g;
  float pb = texture2D(uPrev, prevUv + uShiftB).b;
  vec4 prev = vec4(pr, pg, pb, 1.0);
#else
  vec4 prev = texture2D(uPrev, prevUv);
#endif
  // Outside the surface the past is gone — fade instead of smearing edges.
  vec2 inb = step(vec2(0.0), prevUv) * step(prevUv, vec2(1.0));
  prev *= inb.x * inb.y;

#ifdef VARIANT_MOSH
  // Chroma drift: R and B ride slightly different advections.
  if (uChromaDrift > 0.001) {
    vec2 d = fl * uFlowAmt * uChromaDrift;
    prev.r = texture2D(uPrev, prevUv - d).r;
    prev.b = texture2D(uPrev, prevUv + d).b;
  }
#endif

  vec4 src = texture2D(uSource, vUv);
#ifdef VARIANT_MOSH
  // Datamosh grammar: MOVING regions keep dragging old pixels; fresh frame
  // re-enters only where the scene is still (below the motion threshold).
  float magM = length(fl) * 60.0;
  float still = 1.0 - smoothstep(uMotionThreshold, uMotionThreshold + 0.15, magM);
  vec3 state = prev.rgb * uPersistence;
  state = mix(state, src.rgb, uInjection * still);
  gl_FragColor = vec4(state, 1.0);
#elif defined(VARIANT_TRAILS)
  // Trails: MOVING regions persist (leave wake), still regions stay clean.
  float magT = length(fl) * 60.0;
  float moving = smoothstep(uMotionThreshold, uMotionThreshold + 0.2, magT);
  float persistLocal = mix(0.15, uPersistence, moving);
  vec3 state = prev.rgb * persistLocal;
  state = mix(state, max(state, src.rgb), uInjection);
  gl_FragColor = vec4(state, 1.0);
#else
  vec3 state = prev.rgb * uPersistence;
  state = mix(state, max(state, src.rgb), uInjection);
  gl_FragColor = vec4(state, 1.0);
#endif
}
`;

export class FeedbackStep {
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  readonly material: THREE.ShaderMaterial;

  constructor(variant: FeedbackVariant) {
    const defines: Record<string, string> = {};
    if (variant === 'displace') defines.VARIANT_DISPLACE = '1';
    if (variant === 'kaleido') defines.VARIANT_KALEIDO = '1';
    if (variant === 'rgb') defines.VARIANT_RGB = '1';
    if (variant === 'flow') defines.VARIANT_FLOW = '1';
    if (variant === 'mosh') defines.VARIANT_MOSH = '1';
    if (variant === 'trails') defines.VARIANT_TRAILS = '1';
    this.material = new THREE.ShaderMaterial({
      defines,
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uPrev: { value: null },
        uSource: { value: null },
        uPersistence: { value: 0.95 },
        uInjection: { value: 0.5 },
        uCenter: { value: new THREE.Vector2(0, 0) },
        uZoom: { value: 1.0 },
        uRotate: { value: 0.0 },
        uDrift: { value: new THREE.Vector2(0, 0) },
        uAspect: { value: 16 / 9 },
        uStep: { value: 0 },
        uDispAmount: { value: 0 },
        uDispScale: { value: 6 },
        uDispSpeed: { value: 1 },
        uSegments: { value: 6 },
        uShiftR: { value: new THREE.Vector2(0, 0) },
        uShiftG: { value: new THREE.Vector2(0, 0) },
        uShiftB: { value: new THREE.Vector2(0, 0) },
        uFlowTex: { value: null },
        uFlowAmt: { value: 1 },
        uMotionThreshold: { value: 0.15 },
        uBlockiness: { value: 0 },
        uChromaDrift: { value: 0 },
      },
    });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material));
  }

  /** Run one ping-pong step: READ+source → WRITE, then swap. */
  run(renderer: THREE.WebGLRenderer, surface: FeedbackSurface, source: THREE.Texture | null): void {
    const u = this.material.uniforms;
    u.uPrev!.value = surface.read.texture;
    u.uSource!.value = source;
    const prevTarget = renderer.getRenderTarget();
    // NOTE: no setPixelRatio here — with a non-null render target Three
    // applies viewport pixels directly, and setPixelRatio() forces an
    // internal canvas resize (measured: 5 calls/frame → 77 ms stalls).
    // setRenderTarget applies the RT's full viewport WITHOUT pixelRatio; a
    // manual setViewport would ×ratio it and confine the pass to the
    // lower-left quadrant (the CE1D-2 root-cause bug).
    renderer.setRenderTarget(surface.write);
    renderer.setScissorTest(false);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prevTarget);
    surface.swap();
  }

  /** Prime: copy the current source into READ so the first step has state. */
  prime(renderer: THREE.WebGLRenderer, surface: FeedbackSurface, source: THREE.Texture | null): void {
    const u = this.material.uniforms;
    const keep = { p: u.uPersistence!.value as number, i: u.uInjection!.value as number };
    u.uPersistence!.value = 0;
    u.uInjection!.value = 1;
    this.run(renderer, surface, source);
    u.uPersistence!.value = keep.p;
    u.uInjection!.value = keep.i;
    surface.primed = true;
  }

  dispose(): void {
    this.material.dispose();
  }
}

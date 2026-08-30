import * as THREE from 'three';

/**
 * CE1G — the pixel TRANSITION compositor.
 *
 * Morph already does the valuable thing: it interpolates creative state.
 * What it cannot interpolate is the moment a morph SWITCHES technique
 * identity — today that is a hard cut at progress 0.5 (`committedSide` in
 * morphRuntime). That cut is precisely where a pixel transition belongs,
 * and using it there avoids the "double morph" trap by construction: the
 * two images being blended are the pre-switch and post-switch renders,
 * which the state morph does NOT interpolate between.
 *
 * Model (the CE1G spike answer — see ADR):
 *   SNAPSHOT A at the switch instant  +  live evolving B  →  transition
 * Not dual-render: a parallel A universe would need a second feedback
 * surface, a second simulation and a second flow field. Snapshot costs one
 * RGBA8 target for the duration of the reveal, disposes after, and freezes
 * A at exactly the frame the user was looking at — which is what a
 * transition means.
 *
 * Endpoint law (§2, §22): progress ≤ 0 → pixel-identical A; progress ≥ 1 →
 * pixel-identical B. Every style honours it; the goldens assert it.
 */

export const TRANSITION_STYLES = [
  'smooth',
  'cut',
  'directional',
  'noise',
  'pixel',
  'radial',
  'zoom',
  'displace',
  'glitch',
  'luma',
] as const;

export type TransitionStyle = (typeof TRANSITION_STYLES)[number];

export const STYLE_INDEX: Record<TransitionStyle, number> = {
  smooth: 0,
  cut: 1,
  directional: 2,
  noise: 3,
  pixel: 4,
  radial: 5,
  zoom: 6,
  displace: 7,
  glitch: 8,
  luma: 9,
};

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uFrom;   // snapshot A
uniform sampler2D uTo;     // live B
uniform float uProgress;   // already eased by the morph curve
uniform int uStyle;
uniform float uSoftness;
uniform float uAmount;
uniform float uScale;
uniform vec2 uCenter;
uniform float uAngle;      // directional, degrees
uniform float uAspect;
uniform float uSeed;

float tHash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345) + uSeed * 0.0013);
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float tNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(tHash21(i), tHash21(i + vec2(1.0, 0.0)), u.x),
             mix(tHash21(i + vec2(0.0, 1.0)), tHash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float tLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// A reveal MASK in 0..1: 0 keeps A, 1 shows B. Every style builds its mask
// so that progress 0 → mask 0 everywhere and progress 1 → mask 1 everywhere.
float orderedMask(float order, float p, float soft) {
  float sweep = p * (1.0 + 2.0 * soft) - soft;
  return smoothstep(order - soft, order + soft, sweep);
}

float revealMask(vec2 uv, float p) {
  float soft = max(uSoftness, 0.0005);
  if (uStyle == 1) {                                  // CUT
    return p < 0.5 ? 0.0 : 1.0;
  }
  if (uStyle == 2) {                                  // DIRECTIONAL
    float a = radians(uAngle);
    vec2 dir = vec2(cos(a), sin(a));
    // projection in 0..1 across the image along the direction
    vec2 c = (uv - 0.5) * vec2(uAspect, 1.0);
    float proj = clamp(dot(c, dir) / (0.5 * (abs(dir.x) * uAspect + abs(dir.y))) * 0.5 + 0.5, 0.0, 1.0);
    return orderedMask(proj, p, soft);
  }
  if (uStyle == 3) {                                  // NOISE
    return orderedMask(clamp(tNoise(uv * max(uScale, 0.001) * 8.0), 0.0, 1.0), p, soft);
  }
  if (uStyle == 4) {                                  // PIXEL
    float cells = mix(80.0, 6.0, clamp(uScale, 0.0, 1.0));
    vec2 cell = floor(uv * vec2(cells * uAspect, cells));
    return orderedMask(tHash21(cell), p, 0.0005);
  }
  if (uStyle == 5) {                                  // RADIAL
    vec2 c = (uv - 0.5 - uCenter) * vec2(uAspect, 1.0);
    float d = clamp(length(c) / (0.5 * sqrt(uAspect * uAspect + 1.0)), 0.0, 1.0);
    return orderedMask(d, p, soft);
  }
  if (uStyle == 9) {                                  // LUMA (of B)
    // Bright regions of B arrive FIRST (documented semantic). Raw luma is
    // gamma-lifted: a dark scene has all its luma bunched near 0, which
    // would push the whole reveal into the last 10% of the transition and
    // degenerate the style into a late hard cut.
    float l = clamp(pow(tLuma(texture2D(uTo, uv).rgb), 0.45), 0.0, 1.0);
    return orderedMask(1.0 - l, p, soft);
  }
  return p;                                           // SMOOTH / others
}

void main() {
  float p = clamp(uProgress, 0.0, 1.0);
  // Endpoint law, enforced before any style math can add residue.
  if (p <= 0.0) { gl_FragColor = texture2D(uFrom, vUv); return; }
  if (p >= 1.0) { gl_FragColor = texture2D(uTo, vUv); return; }

  vec2 uvA = vUv;
  vec2 uvB = vUv;

  if (uStyle == 6) {                                  // ZOOM
    // 0.6, not 0.35: below roughly half the frame the push is invisible
    // against the crossfade and the style is indistinguishable from Smooth
    // (their goldens are identical by construction — only the eye separates
    // them, so the default has to be legible).
    float k = uAmount * 0.6;
    vec2 c = 0.5 + uCenter;
    uvA = c + (vUv - c) * (1.0 + k * p);              // A pushes away
    uvB = c + (vUv - c) * (1.0 - k * (1.0 - p));      // B arrives
  } else if (uStyle == 7) {                           // DISPLACE
    float n = tNoise(vUv * max(uScale, 0.001) * 6.0);
    float wave = sin(p * 3.14159265);                 // 0 at both endpoints
    vec2 d = (vec2(n, tNoise(vUv.yx * max(uScale, 0.001) * 6.0)) - 0.5)
             * uAmount * 0.25 * wave;
    uvA = vUv + d;
    uvB = vUv - d;
  } else if (uStyle == 8) {                           // GLITCH
    float blocks = mix(60.0, 8.0, clamp(uScale, 0.0, 1.0));
    float row = floor(vUv.y * blocks);
    float shift = (tHash21(vec2(row, floor(p * 12.0))) - 0.5) * uAmount * 0.3
                  * sin(p * 3.14159265);
    uvA = vec2(vUv.x + shift, vUv.y);
    uvB = vec2(vUv.x - shift * 0.6, vUv.y);
  }

  vec4 a = texture2D(uFrom, clamp(uvA, 0.0, 1.0));
  vec4 b = texture2D(uTo, clamp(uvB, 0.0, 1.0));

  float m = uStyle == 8
    ? smoothstep(0.35, 0.65, p)                       // glitch reveals hard
    : clamp(revealMask(vUv, p), 0.0, 1.0);
  gl_FragColor = vec4(mix(a.rgb, b.rgb, m), 1.0);
}
`;

export interface TransitionParams {
  style: TransitionStyle;
  softness: number;
  amount: number;
  scale: number;
  centerX: number;
  centerY: number;
  angle: number;
  seed: number;
}

export const DEFAULT_TRANSITION: TransitionParams = {
  style: 'smooth',
  softness: 0.15,
  amount: 1,
  scale: 0.5,
  centerX: 0,
  centerY: 0,
  angle: 0,
  seed: 1,
};

/**
 * Owns the A snapshot and the composite pass. Allocation is bounded: one
 * RGBA8 target while a transition is live, disposed the moment it ends.
 */
export class TransitionCompositor {
  private snapshot: THREE.WebGLRenderTarget | null = null;
  private material: THREE.ShaderMaterial;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  /** Dev diagnostics (§100): must return to zero after every morph. */
  allocations = 0;
  disposals = 0;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uFrom: { value: null },
        uTo: { value: null },
        uProgress: { value: 0 },
        uStyle: { value: 0 },
        uSoftness: { value: 0.15 },
        uAmount: { value: 1 },
        uScale: { value: 0.5 },
        uCenter: { value: new THREE.Vector2(0, 0) },
        uAngle: { value: 0 },
        uAspect: { value: 16 / 9 },
        uSeed: { value: 1 },
      },
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  get hasSnapshot(): boolean {
    return this.snapshot !== null;
  }

  get snapshotBytes(): number {
    return this.snapshot ? this.snapshot.width * this.snapshot.height * 4 : 0;
  }

  /** Grab the CURRENT canvas as the A side. Same format as the pipeline
   * (RGBA8 sRGB) so a Smooth midpoint blends without a colour-space shift. */
  capture(renderer: THREE.WebGLRenderer, width: number, height: number, drawA: () => void): void {
    if (!this.snapshot || this.snapshot.width !== width || this.snapshot.height !== height) {
      this.snapshot?.dispose();
      if (this.snapshot) this.disposals++;
      this.snapshot = new THREE.WebGLRenderTarget(width, height, {
        depthBuffer: false,
        colorSpace: THREE.SRGBColorSpace,
      });
      this.allocations++;
    }
    const prev = renderer.getRenderTarget();
    // No manual setViewport after setRenderTarget (CE1D-2 regression).
    renderer.setRenderTarget(this.snapshot);
    renderer.setScissorTest(false);
    drawA();
    renderer.setRenderTarget(prev);
  }

  /** Composite snapshot A over the live B texture into the current target. */
  composite(
    renderer: THREE.WebGLRenderer,
    liveTexture: THREE.Texture,
    progress: number,
    params: TransitionParams,
    aspect: number,
  ): void {
    if (!this.snapshot) return;
    const u = this.material.uniforms;
    u.uFrom!.value = this.snapshot.texture;
    u.uTo!.value = liveTexture;
    u.uProgress!.value = progress;
    u.uStyle!.value = STYLE_INDEX[params.style] ?? 0;
    u.uSoftness!.value = params.softness;
    u.uAmount!.value = params.amount;
    u.uScale!.value = params.scale;
    (u.uCenter!.value as THREE.Vector2).set(params.centerX, params.centerY);
    u.uAngle!.value = params.angle;
    u.uAspect!.value = aspect;
    u.uSeed!.value = params.seed;
    renderer.render(this.scene, this.camera);
  }

  release(): void {
    if (this.snapshot) {
      this.snapshot.dispose();
      this.snapshot = null;
      this.disposals++;
    }
  }

  dispose(): void {
    this.release();
    this.material.dispose();
  }
}

import * as THREE from 'three';
import type { ParamRecord } from '@shared/schemas/project';
import type { TechniqueContext, TechniqueRenderer } from '../types';
import { GLSL_HASH, GLSL_LUMINANCE } from '@/rendering/shaders/chunks';
import { GLSL_TEMPORAL_SAMPLE } from '@/rendering/shaders/temporal';

const MAX_COPIES = 64;

const VERTEX = /* glsl */ `
${GLSL_HASH}

uniform float uCompW;
uniform float uCompH;
uniform float uCopies;
uniform float uDelaySec;
uniform vec2 uOffset;
uniform float uCopyScale;
uniform float uCopyRotation;
uniform int uDistribution; // 0 linear, 1 radial, 2 random
uniform float uSeed;

out vec2 vUv;
out float vCopy;
out float vOffsetSeconds;

const float PI = 3.141592653589793;

void main() {
  float copy = float(gl_InstanceID);
  vCopy = copy;
  vUv = uv;
  // Copy 0 is the present frame; each further copy steps back by the delay.
  vOffsetSeconds = copy * uDelaySec;

  float t = uCopies > 1.0 ? copy / (uCopies - 1.0) : 0.0;
  vec2 translate;
  if (uDistribution == 1) {
    float ang = t * PI * 2.0 + uSeed * 0.001;
    translate = vec2(cos(ang), sin(ang)) * length(uOffset) * t;
  } else if (uDistribution == 2) {
    vec2 r = hash21(copy * 7.13 + uSeed) - 0.5;
    translate = r * 2.0 * uOffset * t * float(copy > 0.0);
  } else {
    translate = uOffset * copy;
  }

  float scale = pow(uCopyScale, copy);
  float rot = radians(uCopyRotation) * copy;

  vec2 p = position.xy * vec2(uCompW, uCompH) * scale;
  vec2 rp = vec2(p.x * cos(rot) - p.y * sin(rot), p.x * sin(rot) + p.y * cos(rot));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(rp + translate, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
${GLSL_LUMINANCE}
${GLSL_TEMPORAL_SAMPLE}

uniform float uDecay;
uniform float uOpacity;
uniform int uBlend; // 0 normal, 1 add, 2 screen

in vec2 vUv;
in float vCopy;
in float vOffsetSeconds;

out vec4 fragColor;

void main() {
  vec4 frame = sampleTemporal(vUv, vOffsetSeconds);
  float fade = pow(clamp(uDecay, 0.0, 1.0), vCopy);
  float alpha = uOpacity * fade;
  if (alpha <= 0.003) discard;
  vec3 color = frame.rgb;
  // Additive/screen blends are premultiplied here; the blend equation on the
  // material handles the compositing itself.
  if (uBlend != 0) color *= alpha;
  fragColor = vec4(color, alpha);
}
`;

function num(params: ParamRecord, id: string, fallback: number): number {
  const v = params[id];
  return typeof v === 'number' ? v : fallback;
}

const DISTRIBUTIONS: Record<string, number> = { linear: 0, radial: 1, random: 2 };

export class EchoRenderer implements TechniqueRenderer {
  readonly object3d: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly shader: THREE.ShaderMaterial;

  constructor() {
    const plane = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = plane.index;
    this.geometry.setAttribute('position', plane.getAttribute('position'));
    this.geometry.setAttribute('uv', plane.getAttribute('uv'));
    this.geometry.instanceCount = 0;

    this.shader = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uCompW: { value: 1920 },
        uCompH: { value: 1080 },
        uCopies: { value: 6 },
        uDelaySec: { value: 0.12 },
        uOffset: { value: new THREE.Vector2(0, 0) },
        uCopyScale: { value: 1 },
        uCopyRotation: { value: 0 },
        uDistribution: { value: 0 },
        uSeed: { value: 1 },
        uDecay: { value: 0.75 },
        uOpacity: { value: 1 },
        uBlend: { value: 0 },
        uTemporalTex: { value: null },
        uTemporalCols: { value: 1 },
        uTemporalRows: { value: 1 },
        uTemporalCount: { value: 1 },
        uTemporalHead: { value: 0 },
        uTemporalFilled: { value: 0 },
        uTemporalSpacing: { value: 1 / 24 },
      },
    });

    this.object3d = new THREE.Mesh(this.geometry, this.shader);
    this.object3d.frustumCulled = false;
    // Farthest (oldest) copies draw first so the present frame lands on top.
    this.object3d.renderOrder = 1;
  }

  get instanceCount(): number {
    return this.geometry.instanceCount;
  }

  update(params: ParamRecord, ctx: TechniqueContext): void {
    const copies = Math.min(Math.max(Math.round(num(params, 'copies', 6)), 1), MAX_COPIES);
    this.geometry.instanceCount = ctx.temporal ? copies : 0;

    const u = this.shader.uniforms;
    const set = (name: string, value: number) => {
      const uniform = u[name];
      if (uniform) uniform.value = value;
    };
    set('uCompW', ctx.compWidth);
    set('uCompH', ctx.compHeight);
    set('uCopies', copies);
    set('uDelaySec', num(params, 'delaySec', 0.12));
    (u.uOffset?.value as THREE.Vector2).set(
      num(params, 'offsetX', 0) * ctx.compWidth * 0.01,
      num(params, 'offsetY', 0) * ctx.compHeight * 0.01,
    );
    set('uCopyScale', num(params, 'copyScale', 1));
    set('uCopyRotation', num(params, 'copyRotation', 0));
    set('uDistribution', DISTRIBUTIONS[String(params.distribution ?? 'linear')] ?? 0);
    set('uSeed', ctx.seed);
    set('uDecay', num(params, 'decay', 0.75));
    set('uOpacity', num(params, 'opacity', 1));

    const blendMode = String(params.blend ?? 'normal');
    set('uBlend', blendMode === 'add' ? 1 : blendMode === 'screen' ? 2 : 0);
    if (blendMode === 'add' || blendMode === 'screen') {
      this.shader.blending = THREE.CustomBlending;
      this.shader.blendEquation = THREE.AddEquation;
      this.shader.blendSrc = THREE.OneFactor;
      this.shader.blendDst = blendMode === 'add' ? THREE.OneFactor : THREE.OneMinusSrcColorFactor;
    } else {
      this.shader.blending = THREE.NormalBlending;
    }

    if (ctx.temporal) {
      if (u.uTemporalTex) u.uTemporalTex.value = ctx.temporal.texture;
      set('uTemporalCols', ctx.temporal.cols);
      set('uTemporalRows', ctx.temporal.rows);
      set('uTemporalCount', ctx.temporal.count);
      set('uTemporalHead', ctx.temporal.head);
      set('uTemporalFilled', ctx.temporal.filled);
      set('uTemporalSpacing', ctx.temporal.spacingSec);
    } else {
      if (u.uTemporalTex) u.uTemporalTex.value = null;
      set('uTemporalFilled', 0);
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.shader.dispose();
  }
}

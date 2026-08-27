import * as THREE from 'three';
import type { ParamRecord } from '@shared/schemas/project';
import type { TechniqueContext, TechniqueRenderer } from '../types';
import { GLSL_HASH } from '@/rendering/shaders/chunks';
import { GLSL_TEMPORAL_SAMPLE } from '@/rendering/shaders/temporal';

const MAX_COPIES = 32;

const VERTEX = /* glsl */ `
${GLSL_HASH}

uniform float uCompW;
uniform float uCompH;
uniform vec2 uOffset;
uniform float uStepSec;
uniform float uHold;
uniform float uAnchorTime;
uniform int uMode;   // 0 accumulate, 1 replace, 2 ping-pong, 3 random
uniform float uSeed;
uniform float uCopiesMinusOne;

out vec2 vUv;
out float vCopy;
out float vOffsetSeconds;

void main() {
  float copy = float(gl_InstanceID);
  vCopy = copy;
  vUv = uv;

  // Step printing quantizes time: each copy holds a stepped frame.
  float step = max(uStepSec, 1e-4);
  float hold = max(uHold, 1.0);
  // Quantize the anchor itself so the result stutters instead of sliding.
  float heldAnchor = floor(uAnchorTime / (step * hold)) * (step * hold);
  float base = uAnchorTime - heldAnchor;

  float k = copy;
  if (uMode == 2) {
    // Ping pong: fold the copy index back and forth.
    float period = max(uCopiesMinusOne, 1.0);
    float f = mod(copy, period * 2.0);
    k = f <= period ? f : period * 2.0 - f;
  } else if (uMode == 3) {
    k = floor(hash11(copy * 5.7 + uSeed) * uCopiesMinusOne + 0.5);
  }
  vOffsetSeconds = base + k * step;

  vec2 translate = uMode == 1 ? vec2(0.0) : uOffset * copy;
  vec2 p = position.xy * vec2(uCompW, uCompH);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p + translate, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
${GLSL_TEMPORAL_SAMPLE}

uniform float uDecay;
uniform int uBlend;

in vec2 vUv;
in float vCopy;
in float vOffsetSeconds;

out vec4 fragColor;

void main() {
  vec4 frame = sampleTemporal(vUv, vOffsetSeconds);
  float alpha = pow(clamp(uDecay, 0.0, 1.0), vCopy);
  if (alpha <= 0.003) discard;
  vec3 color = frame.rgb;
  if (uBlend != 0) color *= alpha;
  fragColor = vec4(color, alpha);
}
`;

function num(params: ParamRecord, id: string, fallback: number): number {
  const v = params[id];
  return typeof v === 'number' ? v : fallback;
}

const MODES: Record<string, number> = { accumulate: 0, replace: 1, pingpong: 2, random: 3 };

export class StepPrintRenderer implements TechniqueRenderer {
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
        uOffset: { value: new THREE.Vector2(0, 0) },
        uStepSec: { value: 1 / 8 },
        uHold: { value: 1 },
        uAnchorTime: { value: 0 },
        uMode: { value: 0 },
        uSeed: { value: 1 },
        uCopiesMinusOne: { value: 1 },
        uDecay: { value: 0.8 },
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
  }

  get instanceCount(): number {
    return this.geometry.instanceCount;
  }

  update(params: ParamRecord, ctx: TechniqueContext): void {
    const copies = Math.min(Math.max(Math.round(num(params, 'copies', 4)), 1), MAX_COPIES);
    this.geometry.instanceCount = ctx.temporal ? copies : 0;

    const u = this.shader.uniforms;
    const set = (name: string, value: number) => {
      const uniform = u[name];
      if (uniform) uniform.value = value;
    };
    set('uCompW', ctx.compWidth);
    set('uCompH', ctx.compHeight);
    (u.uOffset?.value as THREE.Vector2).set(
      num(params, 'offsetX', 0) * ctx.compWidth * 0.01,
      num(params, 'offsetY', 0) * ctx.compHeight * 0.01,
    );
    set('uStepSec', num(params, 'stepSec', 1 / 8));
    set('uHold', Math.round(num(params, 'hold', 1)));
    set('uAnchorTime', ctx.timeSec);
    set('uMode', MODES[String(params.mode ?? 'accumulate')] ?? 0);
    set('uSeed', ctx.seed);
    set('uCopiesMinusOne', Math.max(copies - 1, 1));
    set('uDecay', num(params, 'decay', 0.8));
    const blend = String(params.blend ?? 'normal');
    set('uBlend', blend === 'add' ? 1 : 0);
    this.shader.blending = blend === 'add' ? THREE.AdditiveBlending : THREE.NormalBlending;

    if (ctx.temporal) {
      if (u.uTemporalTex) u.uTemporalTex.value = ctx.temporal.texture;
      set('uTemporalCols', ctx.temporal.cols);
      set('uTemporalRows', ctx.temporal.rows);
      set('uTemporalCount', ctx.temporal.count);
      set('uTemporalHead', ctx.temporal.head);
      set('uTemporalFilled', ctx.temporal.filled);
      set('uTemporalSpacing', ctx.temporal.spacingSec);
    } else {
      set('uTemporalFilled', 0);
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.shader.dispose();
  }
}

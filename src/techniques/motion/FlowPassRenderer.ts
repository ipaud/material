import * as THREE from 'three';
import type { ParamRecord } from '@shared/schemas/project';
import type { TechniqueContext, TechniqueRenderer } from '../types';

/**
 * CE1D — one single-pass renderer for the stateless motion techniques:
 * Flow Displace, Motion RGB, Directional Smear. All consume the SHARED
 * optical-flow service via ctx.flow (never their own analysis), and all
 * carry the dev-only Vector Field View (uDebugFlow: direction→hue,
 * magnitude→brightness) used by the synthetic-motion QA.
 */

const VERTEX = /* glsl */ `
uniform float uCompW;
uniform float uCompH;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix
    * vec4(position.xy * vec2(uCompW, uCompH), 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uSource;
uniform sampler2D uFlowTex;
uniform float uAmount;
uniform float uDirection;   // +1 with motion, -1 against
uniform float uThreshold;
uniform float uSamples;     // smear taps
uniform float uDebugFlow;
in vec2 vUv;
out vec4 fragColor;

vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

void main() {
  vec2 fl = texture(uFlowTex, vUv).rg;
  float mag = length(fl) * 60.0;
  if (uDebugFlow > 0.5) {
    float hue = atan(fl.y, fl.x) / 6.2831853 + 0.5;
    fragColor = vec4(hsv2rgb(vec3(hue, 1.0, clamp(mag * 4.0, 0.0, 1.0))), 1.0);
    return;
  }
  float gate = smoothstep(uThreshold, uThreshold + 0.1, mag);
  vec2 v = fl * uAmount * uDirection * gate * 8.0;

#ifdef VARIANT_DISPLACE
  fragColor = texture(uSource, vUv - v);
#endif
#ifdef VARIANT_RGB
  float r = texture(uSource, vUv - v).r;
  float g = texture(uSource, vUv).g;
  float b = texture(uSource, vUv + v).b;
  fragColor = vec4(r, g, b, 1.0);
#endif
#ifdef VARIANT_SMEAR
  vec3 acc = vec3(0.0);
  float n = clamp(uSamples, 2.0, 16.0);
  for (float i = 0.0; i < 16.0; i++) {
    if (i >= n) break;
    acc += texture(uSource, vUv - v * (i / (n - 1.0))).rgb;
  }
  fragColor = vec4(acc / n, 1.0);
#endif
}
`;

export class FlowPassRenderer implements TechniqueRenderer {
  readonly object3d: THREE.Mesh;
  readonly usesFlow = true as const;
  private readonly shader: THREE.ShaderMaterial;

  constructor(variant: 'displace' | 'rgb' | 'smear') {
    const defines: Record<string, string> = {};
    if (variant === 'displace') defines.VARIANT_DISPLACE = '1';
    if (variant === 'rgb') defines.VARIANT_RGB = '1';
    if (variant === 'smear') defines.VARIANT_SMEAR = '1';
    this.shader = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      defines,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      depthWrite: false,
      uniforms: {
        uCompW: { value: 1920 },
        uCompH: { value: 1080 },
        uSource: { value: null },
        uFlowTex: { value: null },
        uAmount: { value: 1 },
        uDirection: { value: 1 },
        uThreshold: { value: 0.05 },
        uSamples: { value: 8 },
        uDebugFlow: { value: 0 },
      },
    });
    this.object3d = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.shader);
  }

  update(params: ParamRecord, ctx: TechniqueContext): void {
    const u = this.shader.uniforms;
    u.uCompW!.value = ctx.compWidth;
    u.uCompH!.value = ctx.compHeight;
    u.uSource!.value = ctx.sourceTexture;
    u.uFlowTex!.value = ctx.flow;
    u.uAmount!.value = typeof params.amount === 'number' ? params.amount : 1;
    u.uDirection!.value = params.against === true ? -1 : 1;
    u.uThreshold!.value = typeof params.threshold === 'number' ? params.threshold : 0.05;
    u.uSamples!.value = typeof params.samples === 'number' ? params.samples : 8;
    this.object3d.visible = ctx.sourceTexture !== null;
  }

  dispose(): void {
    this.shader.dispose();
    this.object3d.geometry.dispose();
  }
}

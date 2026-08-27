import * as THREE from 'three';
import type { ParamRecord } from '@shared/schemas/project';
import type { TechniqueContext, TechniqueRenderer } from '../types';
import { GLSL_TEMPORAL_SAMPLE } from '@/rendering/shaders/temporal';

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
${GLSL_TEMPORAL_SAMPLE}

uniform int uAxis;          // 0 horizontal strips, 1 vertical strips
uniform float uStripCount;  // strips across the scan axis
uniform float uSpanSec;     // total time mapped across the image
uniform float uDirection;   // +1 / -1
uniform float uOffsetSec;   // constant lead-in
uniform float uInterpolate; // 0 stepped strips, 1 smooth

in vec2 vUv;
out vec4 fragColor;

void main() {
  // Position along the scan axis maps to a moment in time (§ "maps image
  // position to different moments in time").
  float pos = uAxis == 0 ? vUv.y : vUv.x;
  float quantized = uStripCount > 0.0
    ? (floor(pos * uStripCount) + 0.5) / uStripCount
    : pos;
  float p = mix(quantized, pos, clamp(uInterpolate, 0.0, 1.0));
  float t = uDirection < 0.0 ? 1.0 - p : p;
  float offsetSeconds = uOffsetSec + t * uSpanSec;
  fragColor = sampleTemporal(vUv, offsetSeconds);
}
`;

function num(params: ParamRecord, id: string, fallback: number): number {
  const v = params[id];
  return typeof v === 'number' ? v : fallback;
}

export class SlitScanRenderer implements TechniqueRenderer {
  readonly object3d: THREE.Mesh;
  private readonly shader: THREE.ShaderMaterial;

  constructor() {
    this.shader = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uCompW: { value: 1920 },
        uCompH: { value: 1080 },
        uAxis: { value: 0 },
        uStripCount: { value: 64 },
        uSpanSec: { value: 1 },
        uDirection: { value: 1 },
        uOffsetSec: { value: 0 },
        uInterpolate: { value: 0 },
        uTemporalTex: { value: null },
        uTemporalCols: { value: 1 },
        uTemporalRows: { value: 1 },
        uTemporalCount: { value: 1 },
        uTemporalHead: { value: 0 },
        uTemporalFilled: { value: 0 },
        uTemporalSpacing: { value: 1 / 24 },
      },
    });
    this.object3d = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.shader);
    this.object3d.frustumCulled = false;
  }

  get instanceCount(): number {
    return 1;
  }

  update(params: ParamRecord, ctx: TechniqueContext): void {
    this.object3d.visible = ctx.temporal !== null;
    const u = this.shader.uniforms;
    const set = (name: string, value: number) => {
      const uniform = u[name];
      if (uniform) uniform.value = value;
    };
    set('uCompW', ctx.compWidth);
    set('uCompH', ctx.compHeight);
    set('uAxis', params.axis === 'vertical' ? 1 : 0);
    set('uStripCount', Math.round(num(params, 'strips', 64)));
    set('uSpanSec', num(params, 'spanSec', 1));
    set('uDirection', params.direction === 'reverse' ? -1 : 1);
    set('uOffsetSec', num(params, 'offsetSec', 0));
    set('uInterpolate', num(params, 'interpolate', 0));
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
    this.object3d.geometry.dispose();
    this.shader.dispose();
  }
}

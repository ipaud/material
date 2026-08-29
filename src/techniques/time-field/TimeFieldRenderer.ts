import * as THREE from 'three';
import type { ParamRecord } from '@shared/schemas/project';
import type { TechniqueContext, TechniqueRenderer } from '../types';
import { GLSL_TEMPORAL_SAMPLE } from '@/rendering/shaders/temporal';
import { GLSL_FIELDS, FIELD_IDS, type FieldKind } from '@/rendering/shaders/fields';

/**
 * CE1C flagship — TIME FIELD.
 *
 * Every pixel reads a different moment of the temporal atlas, chosen by a
 * FIELD over image space:
 *
 *   offsetSeconds = fieldValue(uv) * depth + offset
 *
 * One fullscreen pass, the existing atlas, zero new persistent state — the
 * generalized slit scan. Luminance mode is the conceptual core: the image
 * content decides which moment each pixel is made of. History is
 * present→past only (no future sampling — live and file share semantics).
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
${GLSL_TEMPORAL_SAMPLE}
${GLSL_FIELDS}

uniform sampler2D uSource;
uniform int uField;
uniform float uDepthSec;
uniform float uOffsetSec;
uniform float uInvert;
uniform vec2 uFieldCenter;
uniform float uAspect;
uniform float uFieldScale;
uniform float uFieldPhase;
uniform float uDebugField; // dev-only: 1 shows the raw field as grayscale
uniform sampler2D uFlowTex; // CE1D: motion field source


in vec2 vUv;
out vec4 fragColor;

void main() {
  float f;
  if (uField == 7) {
    // Motion: magnitude of the shared flow, shaped by Scale as gain.
    f = clamp(length(texture(uFlowTex, vUv).rg) * 60.0 * uFieldScale, 0.0, 1.0);
  } else {
    f = evaluateField(uField, vUv, uSource, uFieldCenter, uAspect, uFieldScale, uFieldPhase);
  }
  f = clamp(mix(f, 1.0 - f, uInvert), 0.0, 1.0);
  if (uDebugField > 0.5) {
    fragColor = vec4(vec3(f), 1.0);
    return;
  }
  float offsetSeconds = uOffsetSec + f * uDepthSec;
  fragColor = sampleTemporal(vUv, offsetSeconds);
}
`;

function num(params: ParamRecord, id: string, fallback: number): number {
  const v = params[id];
  return typeof v === 'number' ? v : fallback;
}

export class TimeFieldRenderer implements TechniqueRenderer {
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
        uSource: { value: null },
        uField: { value: FIELD_IDS.horizontal },
        uDepthSec: { value: 1.2 },
        uOffsetSec: { value: 0 },
        uInvert: { value: 0 },
        uFieldCenter: { value: new THREE.Vector2(0, 0) },
        uAspect: { value: 16 / 9 },
        uFieldScale: { value: 1 },
        uFieldPhase: { value: 0 },
        uDebugField: { value: 0 },
        uFlowTex: { value: null },
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
  }

  /** CE1D: only the motion mode consumes the shared flow service. */
  wantsFlow(params: ParamRecord): boolean {
    return params.field === 'motion';
  }

  update(params: ParamRecord, ctx: TechniqueContext): void {
    const u = this.shader.uniforms;
    u.uFlowTex!.value = ctx.flow;
    u.uCompW!.value = ctx.compWidth;
    u.uCompH!.value = ctx.compHeight;
    u.uAspect!.value = ctx.compWidth / Math.max(ctx.compHeight, 1);
    u.uSource!.value = ctx.sourceTexture;
    const kind = String(params.field ?? 'horizontal') as FieldKind;
    u.uField!.value = FIELD_IDS[kind] ?? FIELD_IDS.horizontal;
    u.uDepthSec!.value = num(params, 'depth', 1.2);
    u.uOffsetSec!.value = num(params, 'offset', 0);
    u.uInvert!.value = params.invert === true ? 1 : 0;
    u.uFieldCenter!.value.set(num(params, 'centerX', 0), num(params, 'centerY', 0));
    u.uFieldScale!.value = num(params, 'scale', 1);
    // Noise phase follows COMPOSITION time — deterministic in export, and
    // parameter-time stays authority-driven even over live pixels (§13).
    u.uFieldPhase!.value = ctx.timeSec * num(params, 'speed', 0.4);
    this.object3d.visible = ctx.temporal !== null;
    if (ctx.temporal) {
      if (u.uTemporalTex) u.uTemporalTex.value = ctx.temporal.texture;
      u.uTemporalCols!.value = ctx.temporal.cols;
      u.uTemporalRows!.value = ctx.temporal.rows;
      u.uTemporalCount!.value = ctx.temporal.count;
      u.uTemporalHead!.value = ctx.temporal.head;
      u.uTemporalFilled!.value = ctx.temporal.filled;
      u.uTemporalSpacing!.value = ctx.temporal.spacingSec;
    }
  }

  dispose(): void {
    this.shader.dispose();
    this.object3d.geometry.dispose();
  }
}

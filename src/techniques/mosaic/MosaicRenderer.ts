import * as THREE from 'three';
import type { ParamRecord } from '@shared/schemas/project';
import type { TechniqueContext, TechniqueRenderer } from '../types';
import { GLSL_ADJUST, GLSL_HASH, GLSL_LUMINANCE, GLSL_SHAPES } from '@/rendering/shaders/chunks';
import {
  GLSL_TEMPORAL_DISTRIBUTION,
  GLSL_TEMPORAL_SAMPLE,
  temporalModeIndex,
} from '@/rendering/shaders/temporal';
import { shapeIndexForMaterial } from '@/materials/builtins';
import { MAX_MOSAIC_INSTANCES } from '@shared/constants/app';

const VERTEX = /* glsl */ `
${GLSL_LUMINANCE}
${GLSL_HASH}
${GLSL_ADJUST}
${GLSL_TEMPORAL_DISTRIBUTION}

uniform sampler2D uSource;
uniform float uCols;
uniform float uRows;
uniform float uCompW;
uniform float uCompH;
uniform float uScale;
uniform float uMinScale;
uniform float uMaxScale;
uniform float uSpacing;
uniform float uRotation;
uniform float uRandomRotation;
uniform float uOpacity;
uniform float uThreshold;
uniform float uContrast;
uniform float uGamma;
uniform float uInvert;
uniform float uLumScale;
uniform float uLumRot;
uniform float uLumOpacity;
uniform float uLumDepth;
uniform float uDepth;
uniform vec2 uJitter;
uniform float uSeed;
uniform float uSquareElement;
uniform int uOffsetMode;
uniform float uMaxOffsetSec;
uniform float uFalloff;
uniform vec2 uTemporalCenter;
uniform float uTemporalDirection;

out vec2 vLocal;
out vec3 vCellColor;
out float vOpacity;
out float vOffsetSeconds;

const float PI = 3.141592653589793;

// Signed mapping: positive amount drives by sample, negative by inverted sample.
float mapAmount(float sample01, float amount) {
  float m = amount < 0.0 ? 1.0 - sample01 : sample01;
  return 1.0 - abs(amount) + abs(amount) * m;
}

void main() {
  float id = float(gl_InstanceID);
  float col = mod(id, uCols);
  float row = floor(id / uCols);

  vec2 cellUV = vec2((col + 0.5) / uCols, 1.0 - (row + 0.5) / uRows);
  vec3 src = texture(uSource, cellUV).rgb;
  float lum = matLuminance(src);
  float s = adjustSample(lum, uContrast, uGamma, uInvert);

  float alive = step(uThreshold, s);

  float cellW = uCompW / uCols;
  float cellH = uCompH / uRows;

  float scaleF = clamp(uScale * mapAmount(s, uLumScale), uMinScale, uMaxScale);
  // Texture/video materials keep a square element footprint; SDF shapes fill the cell.
  vec2 footprint = uSquareElement > 0.5 ? vec2(min(cellW, cellH)) : vec2(cellW, cellH);
  vec2 size = footprint * (1.0 - uSpacing) * scaleF * alive;

  vec2 rnd = hash21(id * 0.6180339887 + uSeed);
  vec2 jitterOff = (rnd - 0.5) * 2.0 * uJitter * vec2(cellW, cellH);

  float rot = radians(uRotation)
    + (hash11(id * 1.7 + uSeed * 1.3) - 0.5) * 2.0 * PI * uRandomRotation
    + uLumRot * (s - 0.5) * 2.0 * PI;

  float z = uDepth * (s - 0.5) * 2.0 * uLumDepth;

  vOpacity = uOpacity * mapAmount(s, uLumOpacity) * alive;
  vCellColor = src;
  vLocal = position.xy;

  // Per-cell temporal offset, in SECONDS of composition time.
  vec2 cn = vec2((col + 0.5) / uCols - 0.5, 0.5 - (row + 0.5) / uRows);
  float w = temporalWeight(uOffsetMode, cn, id, uSeed, s, uTemporalCenter);
  w = applyFalloff(w, uFalloff);
  // Direction -1 inverts the distribution (center becomes oldest).
  w = uTemporalDirection < 0.0 ? 1.0 - w : w;
  vOffsetSeconds = w * uMaxOffsetSec;

  vec2 center = vec2(
    (col + 0.5) * cellW - uCompW * 0.5,
    uCompH * 0.5 - (row + 0.5) * cellH
  ) + jitterOff;

  vec2 p = position.xy * size;
  vec2 r = vec2(p.x * cos(rot) - p.y * sin(rot), p.x * sin(rot) + p.y * cos(rot));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(center + r, z, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
${GLSL_SHAPES}
${GLSL_TEMPORAL_SAMPLE}

uniform int uShape;
uniform float uAspect;
uniform int uColorMode; // 0 source-fill, 1 mono, 2 original, 3 source-tint
uniform vec3 uMonoColor;
uniform sampler2D uMatTex;
uniform int uUseTex;
uniform int uTileMode; // 0 off, 1 video tile

in vec2 vLocal;
in vec3 vCellColor;
in float vOpacity;
in float vOffsetSeconds;

out vec4 fragColor;

void main() {
  float alpha;
  vec3 color;
  if (uTileMode == 1) {
    // Each cell shows the source frame at (anchorTime - vOffsetSeconds).
    vec2 tuv = vec2(vLocal.x / max(uAspect, 0.0001), vLocal.y) + 0.5;
    if (tuv.x < 0.0 || tuv.x > 1.0 || tuv.y < 0.0 || tuv.y > 1.0) discard;
    vec3 frame = sampleTemporal(tuv, vOffsetSeconds).rgb;
    alpha = vOpacity;
    if (uColorMode == 1) color = uMonoColor * dot(frame, vec3(0.2126, 0.7152, 0.0722));
    else if (uColorMode == 3) color = frame * vCellColor;
    else color = frame;
  } else if (uUseTex == 1) {
    vec2 tuv = vec2(vLocal.x / max(uAspect, 0.0001), vLocal.y) + 0.5;
    if (tuv.x < 0.0 || tuv.x > 1.0 || tuv.y < 0.0 || tuv.y > 1.0) discard;
    vec4 t = texture(uMatTex, tuv);
    alpha = t.a * vOpacity;
    if (uColorMode == 2) color = t.rgb;
    else if (uColorMode == 1) color = uMonoColor;
    else if (uColorMode == 3) color = t.rgb * vCellColor;
    else color = vCellColor;
  } else {
    float d = sdShape(uShape, vLocal, uAspect);
    float aa = fwidth(d) * 1.2 + 0.0001;
    alpha = (1.0 - smoothstep(-aa, aa, d)) * vOpacity;
    color = uColorMode == 1 ? uMonoColor : vCellColor;
  }
  if (alpha <= 0.003) discard;
  fragColor = vec4(color, alpha);
}
`;

function num(params: ParamRecord, id: string, fallback: number): number {
  const v = params[id];
  return typeof v === 'number' ? v : fallback;
}

export class MosaicRenderer implements TechniqueRenderer {
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
        uSource: { value: null },
        uCols: { value: 1 },
        uRows: { value: 1 },
        uCompW: { value: 1920 },
        uCompH: { value: 1080 },
        uScale: { value: 1 },
        uMinScale: { value: 0 },
        uMaxScale: { value: 2 },
        uSpacing: { value: 0.1 },
        uRotation: { value: 0 },
        uRandomRotation: { value: 0 },
        uOpacity: { value: 1 },
        uThreshold: { value: 0 },
        uContrast: { value: 1 },
        uGamma: { value: 1 },
        uInvert: { value: 0 },
        uLumScale: { value: 0.85 },
        uLumRot: { value: 0 },
        uLumOpacity: { value: 0 },
        uLumDepth: { value: 0 },
        uDepth: { value: 0 },
        uJitter: { value: new THREE.Vector2(0, 0) },
        uSeed: { value: 1 },
        uShape: { value: 0 },
        uAspect: { value: 1 },
        uColorMode: { value: 0 },
        uMonoColor: { value: new THREE.Color('#ffffff') },
        uMatTex: { value: null },
        uUseTex: { value: 0 },
        uSquareElement: { value: 0 },
        uTileMode: { value: 0 },
        uOffsetMode: { value: 0 },
        uMaxOffsetSec: { value: 0 },
        uFalloff: { value: 1 },
        uTemporalCenter: { value: new THREE.Vector2(0, 0) },
        uTemporalDirection: { value: 1 },
        // Temporal buffer (see rendering/shaders/temporal.ts).
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

  /** Current instance count (for the debug overlay). */
  get instanceCount(): number {
    return this.geometry.instanceCount;
  }

  update(params: ParamRecord, ctx: TechniqueContext): void {
    const cols = Math.round(num(params, 'columns', 48));
    const rows = Math.round(num(params, 'rows', 27));
    let count = cols * rows;
    if (count > MAX_MOSAIC_INSTANCES) count = MAX_MOSAIC_INSTANCES;
    this.geometry.instanceCount = ctx.sourceTexture ? count : 0;

    const u = this.shader.uniforms;
    const set = (name: string, value: number) => {
      const uniform = u[name];
      if (uniform) uniform.value = value;
    };
    if (u.uSource) u.uSource.value = ctx.sourceTexture;
    set('uCols', cols);
    set('uRows', rows);
    set('uCompW', ctx.compWidth);
    set('uCompH', ctx.compHeight);
    set('uScale', num(params, 'scale', 1));
    set('uMinScale', num(params, 'minScale', 0));
    set('uMaxScale', num(params, 'maxScale', 2));
    set('uSpacing', num(params, 'spacing', 0.1));
    set('uRotation', num(params, 'rotation', 0));
    set('uRandomRotation', num(params, 'randomRotation', 0));
    set('uOpacity', num(params, 'opacity', 1));
    set('uThreshold', num(params, 'threshold', 0));
    set('uContrast', num(params, 'contrast', 1));
    set('uGamma', num(params, 'gamma', 1));
    set('uInvert', params.invert === true ? 1 : 0);
    set('uLumScale', num(params, 'lumToScale', 0));
    set('uLumRot', num(params, 'lumToRotation', 0));
    set('uLumOpacity', num(params, 'lumToOpacity', 0));
    set('uLumDepth', num(params, 'lumToDepth', 0));
    set('uDepth', num(params, 'depth', 0));
    (u.uJitter?.value as THREE.Vector2).set(num(params, 'jitterX', 0), num(params, 'jitterY', 0));
    set('uSeed', ctx.seed);
    set('uShape', shapeIndexForMaterial(ctx.material.materialId));
    set('uAspect', typeof ctx.material.params.aspect === 'number' ? ctx.material.params.aspect : 1);
    const useTex = ctx.material.materialId === 'custom' && ctx.materialTexture !== null;
    if (u.uMatTex) u.uMatTex.value = useTex ? ctx.materialTexture : null;
    set('uUseTex', useTex ? 1 : 0);
    const COLOR_MODES: Record<string, number> = { source: 0, mono: 1, original: 2, sourceColor: 3 };
    set('uColorMode', COLOR_MODES[ctx.material.colorMode] ?? 0);

    // ---- temporal ----
    const tileOn = params.tileMode === 'tile' && ctx.temporal !== null;
    set('uTileMode', tileOn ? 1 : 0);
    set('uSquareElement', tileOn || useTex ? 1 : 0);
    set('uOffsetMode', temporalModeIndex(String(params.offsetMode ?? 'uniform')));
    set('uMaxOffsetSec', num(params, 'maxOffsetSec', 0));
    set('uFalloff', num(params, 'falloff', 1));
    set('uTemporalDirection', params.temporalDirection === 'inward' ? -1 : 1);
    (u.uTemporalCenter?.value as THREE.Vector2).set(
      num(params, 'centerX', 0),
      num(params, 'centerY', 0),
    );
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

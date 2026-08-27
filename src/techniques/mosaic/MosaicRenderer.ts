import * as THREE from 'three';
import type { ParamRecord } from '@shared/schemas/project';
import type { TechniqueContext, TechniqueRenderer } from '../types';
import { GLSL_ADJUST, GLSL_HASH, GLSL_LUMINANCE, GLSL_SHAPES } from '@/rendering/shaders/chunks';
import { shapeIndexForMaterial } from '@/materials/builtins';
import { MAX_MOSAIC_INSTANCES } from '@shared/constants/app';

const VERTEX = /* glsl */ `
${GLSL_LUMINANCE}
${GLSL_HASH}
${GLSL_ADJUST}

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

out vec2 vLocal;
out vec3 vCellColor;
out float vOpacity;

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
  float lum = luminance(src);
  float s = adjustSample(lum, uContrast, uGamma, uInvert);

  float alive = step(uThreshold, s);

  float cellW = uCompW / uCols;
  float cellH = uCompH / uRows;

  float scaleF = clamp(uScale * mapAmount(s, uLumScale), uMinScale, uMaxScale);
  vec2 size = vec2(cellW, cellH) * (1.0 - uSpacing) * scaleF * alive;

  vec2 rnd = hash21(id * 0.6180339887 + uSeed);
  vec2 jitterOff = (rnd - 0.5) * 2.0 * uJitter * vec2(cellW, cellH);

  float rot = radians(uRotation)
    + (hash11(id * 1.7 + uSeed * 1.3) - 0.5) * 2.0 * PI * uRandomRotation
    + uLumRot * (s - 0.5) * 2.0 * PI;

  float z = uDepth * (s - 0.5) * 2.0 * uLumDepth;

  vOpacity = uOpacity * mapAmount(s, uLumOpacity) * alive;
  vCellColor = src;
  vLocal = position.xy;

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

uniform int uShape;
uniform float uAspect;
uniform int uColorMode;
uniform vec3 uMonoColor;

in vec2 vLocal;
in vec3 vCellColor;
in float vOpacity;

out vec4 fragColor;

void main() {
  float d = sdShape(uShape, vLocal, uAspect);
  float aa = fwidth(d) * 1.2 + 0.0001;
  float alpha = (1.0 - smoothstep(-aa, aa, d)) * vOpacity;
  if (alpha <= 0.003) discard;
  vec3 color = uColorMode == 1 ? uMonoColor : vCellColor;
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
    (u.uJitter?.value as THREE.Vector2).set(
      num(params, 'jitterX', 0),
      num(params, 'jitterY', 0),
    );
    set('uSeed', ctx.seed);
    set('uShape', shapeIndexForMaterial(ctx.material.materialId));
    set('uAspect', typeof ctx.material.params.aspect === 'number' ? ctx.material.params.aspect : 1);
    set('uColorMode', ctx.material.colorMode === 'mono' ? 1 : 0);
  }

  dispose(): void {
    this.geometry.dispose();
    this.shader.dispose();
  }
}

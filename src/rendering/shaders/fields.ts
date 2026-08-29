/**
 * CE1C — the FIELD primitive.
 *
 * A field is a scalar function over normalized image space:
 *
 *   field(uv) → 0..1
 *
 * It is a SEMANTIC CONTRACT, not a texture: mathematical fields evaluate
 * inline in the consuming shader (zero extra passes, zero VRAM), and
 * image-derived fields (luminance, edges) sample the already-bound source
 * texture in the same pass. A future motion field (CE1D) enters as one
 * more FIELD_* id whose value comes from a flow texture — the contract
 * does not change.
 *
 * The TS mirror below implements the identical math for unit tests and any
 * future CPU-side consumer; GLSL and TS are kept in lockstep by the tests.
 */

export const FIELD_IDS = {
  horizontal: 0,
  vertical: 1,
  radial: 2,
  spiral: 3,
  noise: 4,
  luminance: 5,
  edges: 6,
} as const;

export type FieldKind = keyof typeof FIELD_IDS;

export const GLSL_FIELDS = /* glsl */ `
// ---- FIELD primitive (CE1C). field(uv) -> 0..1. Keep in lockstep with
// evaluateFieldJs in fields.ts — the unit tests compare sample points.

float fieldHash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float fieldNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = fieldHash21(i);
  float b = fieldHash21(i + vec2(1.0, 0.0));
  float c = fieldHash21(i + vec2(0.0, 1.0));
  float d = fieldHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fieldLuma(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

// uv: [0,1]^2, y up (Three convention: v=0 bottom). VERTICAL is defined
// top->0 bottom->1 in USER space, so it uses (1 - uv.y).
// aspect: compWidth / compHeight — radial/spiral distances are isotropic.
float evaluateField(
  int kind,
  vec2 uv,
  sampler2D source,
  vec2 center,      // -0.5..0.5 offsets from image center
  float aspect,
  float scale,      // noise frequency / spiral turns
  float phase       // noise time phase (composition-time driven)
) {
  if (kind == 0) return uv.x;
  if (kind == 1) return 1.0 - uv.y;
  vec2 p = (uv - 0.5 - center) * vec2(aspect, 1.0);
  if (kind == 2) {
    // Aspect-correct radial: 0 at center, 1 at the nearest image edge
    // distance (half the height), clamped beyond.
    return clamp(length(p) * 2.0, 0.0, 1.0);
  }
  if (kind == 3) {
    float theta = atan(p.y, p.x) / 6.2831853 + 0.5; // 0..1 around
    float rad = length(p) * 2.0;
    return fract(theta + rad * max(scale, 0.0));
  }
  if (kind == 4) {
    return fieldNoise(uv * max(scale, 0.001) * 8.0 + vec2(phase, -phase * 0.7));
  }
  if (kind == 5) {
    return fieldLuma(texture(source, uv).rgb);
  }
  // 6 — edges: cheap 4-tap gradient magnitude on luminance.
  vec2 e = vec2(0.004, 0.0);
  float gx = fieldLuma(texture(source, uv + e.xy).rgb) - fieldLuma(texture(source, uv - e.xy).rgb);
  float gy = fieldLuma(texture(source, uv + e.yx).rgb) - fieldLuma(texture(source, uv - e.yx).rgb);
  return clamp(length(vec2(gx, gy)) * 4.0, 0.0, 1.0);
}
`;

/** TS mirror of the GLSL — for tests and CPU-side consumers. Image-derived
 * kinds take a sampler callback returning [r,g,b] in 0..1. */
export function evaluateFieldJs(
  kind: FieldKind,
  u: number,
  v: number,
  options: {
    center?: [number, number];
    aspect?: number;
    scale?: number;
    phase?: number;
    sample?: (u: number, v: number) => [number, number, number];
  } = {},
): number {
  const { center = [0, 0], aspect = 16 / 9, scale = 1, phase = 0, sample } = options;
  const luma = (c: [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  switch (kind) {
    case 'horizontal':
      return u;
    case 'vertical':
      return 1 - v;
    case 'radial': {
      const px = (u - 0.5 - center[0]) * aspect;
      const py = v - 0.5 - center[1];
      return Math.min(Math.max(Math.hypot(px, py) * 2, 0), 1);
    }
    case 'spiral': {
      const px = (u - 0.5 - center[0]) * aspect;
      const py = v - 0.5 - center[1];
      const theta = Math.atan2(py, px) / (Math.PI * 2) + 0.5;
      const rad = Math.hypot(px, py) * 2;
      const t = theta + rad * Math.max(scale, 0);
      return t - Math.floor(t);
    }
    case 'noise': {
      const s = Math.max(scale, 0.001) * 8;
      return valueNoise(u * s + phase, v * s - phase * 0.7);
    }
    case 'luminance':
      return sample ? luma(sample(u, v)) : 0;
    case 'edges': {
      if (!sample) return 0;
      const e = 0.004;
      const gx = luma(sample(u + e, v)) - luma(sample(u - e, v));
      const gy = luma(sample(u, v + e)) - luma(sample(u, v - e));
      return Math.min(Math.max(Math.hypot(gx, gy) * 4, 0), 1);
    }
  }
}

function hash21(x: number, y: number): number {
  let px = fract(x * 234.34);
  let py = fract(y * 435.345);
  const d = px * px + py * py + 34.23 * (px + py) + px * py * 2 - px * px; // mirror of p += dot(p, p+34.23)
  // Faithful mirror of the GLSL: p += dot(p, p + 34.23); fract(p.x * p.y)
  const dot = px * (px + 34.23) + py * (py + 34.23);
  px = px + dot;
  py = py + dot;
  void d;
  return fract(px * py);
}

function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash21(ix, iy);
  const b = hash21(ix + 1, iy);
  const c = hash21(ix, iy + 1);
  const d = hash21(ix + 1, iy + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const fract = (x: number) => x - Math.floor(x);

/**
 * Reusable GLSL chunks shared across technique shaders.
 * Keep in sync with the TypeScript mirrors in src/rendering/sampling.ts
 * (the TS versions exist for CPU-side evaluation and tests).
 */

/**
 * Rec. 709 luma.
 * Named `matLuminance`, not `luminance`: three.js declares its own `luminance`
 * in the fragment common chunk, and redefining it fails to compile.
 */
export const GLSL_LUMINANCE = /* glsl */ `
float matLuminance(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}
`;

/** Deterministic hash from an id + seed. Matches no CPU code — GPU-only jitter. */
export const GLSL_HASH = /* glsl */ `
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
vec2 hash21(float p) {
  vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
`;

/** Contrast / gamma / invert / adjustment applied to a 0..1 sample value. */
export const GLSL_ADJUST = /* glsl */ `
float adjustSample(float v, float contrast, float gamma, float invert) {
  v = clamp((v - 0.5) * contrast + 0.5, 0.0, 1.0);
  v = pow(v, 1.0 / max(gamma, 0.001));
  v = mix(v, 1.0 - v, invert);
  return v;
}
`;

/**
 * Signed-distance shape functions evaluated in local cell space (p in -0.5..0.5).
 * Negative inside. Shape ids must match SHAPE_INDEX in src/materials/builtins.ts.
 */
export const GLSL_SHAPES = /* glsl */ `
float sdShape(int shapeId, vec2 p, float aspect) {
  p.x /= max(aspect, 0.0001);
  if (shapeId == 0) { // square
    vec2 d = abs(p) - vec2(0.5);
    return max(d.x, d.y);
  }
  if (shapeId == 1) { // circle
    return length(p) - 0.5;
  }
  if (shapeId == 2) { // line (horizontal bar)
    vec2 d = abs(p) - vec2(0.5, 0.06);
    return max(d.x, d.y);
  }
  if (shapeId == 3) { // dot (small centered circle)
    return length(p) - 0.18;
  }
  if (shapeId == 4) { // rectangle (wide)
    vec2 d = abs(p) - vec2(0.5, 0.3);
    return max(d.x, d.y);
  }
  // triangle (equilateral, pointing up)
  const float k = 1.7320508;
  vec2 q = vec2(abs(p.x) - 0.5, p.y + 0.5 / k + 0.12);
  if (q.x + k * q.y > 0.0) q = vec2(q.x - k * q.y, -k * q.x - q.y) / 2.0;
  q.x -= clamp(q.x, -0.5, 0.0);
  return -length(q) * sign(q.y);
}
`;

/**
 * sRGB transfer (IEC 61966-2-1 OETF), linear → encoded. The canvas is the one
 * destination in the pipeline that is not an SRGB8 target, so the last write
 * before the screen applies this by hand; every render target encodes in
 * hardware. Named to avoid three's own `LinearTosRGB`.
 */
export const GLSL_SRGB_OETF = /* glsl */ `
vec3 srgbOetf(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}
`;

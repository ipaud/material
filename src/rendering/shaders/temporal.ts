/**
 * Shared temporal-sampling GLSL.
 *
 * Addressing mirrors TemporalFrameProvider exactly:
 *   logical k = round(offsetSeconds / spacing)
 *   physical  = mod(head - k + count, count)
 * so preview and export resolve identical slots for identical times.
 */

export const GLSL_TEMPORAL_SAMPLE = /* glsl */ `
uniform sampler2D uTemporalTex;
uniform float uTemporalCols;
uniform float uTemporalRows;
uniform float uTemporalCount;
uniform float uTemporalHead;
uniform float uTemporalFilled;
uniform float uTemporalSpacing;

// Sample the history buffer offsetSeconds before the anchor.
//
// The half-texel inset is load-bearing, not cosmetic. Slots are tiles in one
// atlas, so a bilinear tap at a tile's edge blends in the NEIGHBOURING tile —
// a different moment in time. Which tile is adjacent depends on head, and
// head depends on how the history was built: a subrange export primes with
// head 0 while a full export arrives at the same instant with head N. Same
// history, same anchor, different bleed — that was the CE1C full-vs-subrange
// divergence (0/12). Clamping each tap inside its own tile makes sampling
// head-invariant, and also stops history frames leaking into each other at
// the frame border during normal preview.
vec4 sampleTemporal(vec2 uv, float offsetSeconds) {
  float maxK = max(uTemporalFilled - 1.0, 0.0);
  float k = clamp(floor(offsetSeconds / max(uTemporalSpacing, 1e-6) + 0.5), 0.0, maxK);
  float physical = mod(uTemporalHead - k + uTemporalCount * 2.0, uTemporalCount);
  vec2 base = vec2(mod(physical, uTemporalCols), floor(physical / uTemporalCols));
  vec2 grid = vec2(uTemporalCols, uTemporalRows);
  vec2 cell = clamp(uv, vec2(0.0), vec2(1.0));
  vec2 halfTexel = 0.5 / vec2(textureSize(uTemporalTex, 0));
  vec2 lo = base / grid + halfTexel;
  vec2 hi = (base + 1.0) / grid - halfTexel;
  return texture(uTemporalTex, clamp((base + cell) / grid, lo, hi));
}
`;

/**
 * Per-cell temporal offset distributions (§5).
 * cn is the cell's normalized position in -0.5..0.5, id its instance id.
 * Returns a 0..1 weight; callers scale it by max offset and falloff.
 */
export const GLSL_TEMPORAL_DISTRIBUTION = /* glsl */ `
// 0 uniform, 1 radial, 2 linearX, 3 linearY, 4 distanceCenter,
// 5 random(seeded), 6 luminance, 7 noise field
float temporalWeight(int mode, vec2 cn, float id, float seed, float luminance, vec2 center) {
  vec2 d = cn - center;
  if (mode == 0) return 1.0;
  if (mode == 1) return clamp(length(d) / 0.7071, 0.0, 1.0);
  if (mode == 2) return clamp(cn.x + 0.5, 0.0, 1.0);
  if (mode == 3) return clamp(0.5 - cn.y, 0.0, 1.0);
  if (mode == 4) return clamp(max(abs(d.x), abs(d.y)) / 0.5, 0.0, 1.0);
  if (mode == 5) return hash11(id * 3.1 + seed * 2.7);
  if (mode == 6) return clamp(luminance, 0.0, 1.0);
  // Noise field: smooth seeded value noise over cell position.
  vec2 p = cn * 6.0 + seed * 0.37;
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash11(dot(i, vec2(1.0, 57.0)) + seed);
  float b = hash11(dot(i + vec2(1.0, 0.0), vec2(1.0, 57.0)) + seed);
  float c = hash11(dot(i + vec2(0.0, 1.0), vec2(1.0, 57.0)) + seed);
  float dd = hash11(dot(i + vec2(1.0, 1.0), vec2(1.0, 57.0)) + seed);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, dd, u.x), u.y);
}

/** Apply falloff shaping: <1 eases in, >1 pushes offsets to the extremes. */
float applyFalloff(float w, float falloff) {
  return pow(clamp(w, 0.0, 1.0), max(falloff, 0.01));
}
`;

/** Distribution ids shared between TS and GLSL. */
export const TEMPORAL_MODES = {
  uniform: 0,
  radial: 1,
  linearX: 2,
  linearY: 3,
  distanceCenter: 4,
  random: 5,
  luminance: 6,
  noise: 7,
} as const;

export type TemporalModeId = keyof typeof TEMPORAL_MODES;

export const TEMPORAL_MODE_OPTIONS: { value: TemporalModeId; label: string }[] = [
  { value: 'uniform', label: 'Uniform' },
  { value: 'radial', label: 'Radial' },
  { value: 'linearX', label: 'Linear X' },
  { value: 'linearY', label: 'Linear Y' },
  { value: 'distanceCenter', label: 'Distance from Center' },
  { value: 'random', label: 'Random (seeded)' },
  { value: 'luminance', label: 'Luminance' },
  { value: 'noise', label: 'Noise Field' },
];

export function temporalModeIndex(mode: string): number {
  return TEMPORAL_MODES[mode as TemporalModeId] ?? 0;
}

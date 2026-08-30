/**
 * CE1F — stateless generator GLSL. Every field is a PURE function of
 * (uv, timeSec, params, seed): the same composition time always produces
 * the same pixels, at any resolution and any export FPS. No wall clock,
 * no Math.random, no mutable point arrays. Original implementations of
 * standard constructions (value noise, Worley cells, Chladni plate modes).
 */

export const GENERATOR_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }
`;

const COMMON = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uSeed;
uniform float uAspect;
uniform float p0, p1, p2, p3, p4, p5;

float gHash11(float n) { return fract(sin(n * 127.1 + uSeed * 0.017) * 43758.5453); }
vec2 gHash22(vec2 p) {
  float n = dot(p, vec2(127.1, 311.7)) + uSeed * 0.013;
  return fract(vec2(sin(n) * 43758.5453, sin(n * 1.7) * 22578.1459));
}
float gHash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed * 0.013) * 43758.5453);
}
float gNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = gHash21(i), b = gHash21(i + vec2(1.0, 0.0));
  float c = gHash21(i + vec2(0.0, 1.0)), d = gHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// Aspect-correct coordinates: a circle is a circle on any composition.
vec2 gCoord() { return vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5); }
float gShape(float v, float contrast) {
  return clamp((v - 0.5) * contrast + 0.5, 0.0, 1.0);
}
`;

export const NOISE_FRAG = /* glsl */ `
${COMMON}
// p0 scale, p1 speed, p2 detail, p3 warp, p4 contrast
void main() {
  vec2 uv = gCoord() * p0;
  float t = uTime * p1;
  if (p3 > 0.001) {
    vec2 w = vec2(gNoise(uv + t), gNoise(uv.yx - t * 0.7));
    uv += (w - 0.5) * p3 * 2.0;
  }
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 6; i++) {
    if (float(i) >= p2) break;
    sum += gNoise(uv + vec2(t * 0.3, -t * 0.2)) * amp;
    norm += amp;
    uv *= 2.03;
    amp *= 0.5;
  }
  float v = norm > 0.0 ? sum / norm : 0.0;
  gl_FragColor = vec4(vec3(gShape(v, p4)), 1.0);
}
`;

export const WAVES_FRAG = /* glsl */ `
${COMMON}
// p0 frequency, p1 count, p2 speed, p3 spread, p4 contrast
void main() {
  vec2 uv = gCoord();
  float acc = 0.0;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= p1) break;
    float fi = float(i);
    // Emitters on a deterministic ring; phase advances with composition time.
    float ang = 6.2831853 * (gHash11(fi * 3.1) + fi / max(p1, 1.0));
    vec2 c = vec2(cos(ang), sin(ang)) * p3;
    acc += sin(distance(uv, c) * p0 - uTime * p2 * 6.2831853);
  }
  float v = acc / max(p1, 1.0) * 0.5 + 0.5;
  gl_FragColor = vec4(vec3(gShape(v, p4)), 1.0);
}
`;

export const VORONOI_FRAG = /* glsl */ `
${COMMON}
// p0 scale, p1 jitter, p2 speed, p3 edge, p4 contrast
void main() {
  vec2 uv = gCoord() * p0;
  vec2 g = floor(uv), f = fract(uv);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 h = gHash22(g + o);
      // Points orbit deterministically with composition time.
      vec2 p = o + 0.5 + (sin(uTime * p2 * 6.2831853 + h * 6.2831853) * 0.5) * p1;
      float d = length(p - f);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  float v = p3 > 0.001 ? mix(1.0 - d1, clamp((d2 - d1) * 2.0, 0.0, 1.0), p3) : 1.0 - d1;
  gl_FragColor = vec4(vec3(gShape(v, p4)), 1.0);
}
`;

export const GRID_FRAG = /* glsl */ `
${COMMON}
// p0 scale, p1 width, p2 rotation(deg), p3 offsetX, p4 offsetY, p5 mode
void main() {
  vec2 uv = gCoord();
  float a = radians(p2);
  uv = mat2(cos(a), -sin(a), sin(a), cos(a)) * uv;
  uv = uv * p0 + vec2(p3, p4) * p0;
  vec2 c = fract(uv) - 0.5;
  float v;
  int mode = int(p5 + 0.5);
  if (mode == 1) {
    v = 1.0 - smoothstep(p1 * 0.5, p1 * 0.5 + 0.02, length(c));       // dots
  } else if (mode == 2) {
    float h = 1.0 - smoothstep(p1 * 0.5, p1 * 0.5 + 0.01, abs(c.y));
    float w = 1.0 - smoothstep(p1 * 0.5, p1 * 0.5 + 0.01, abs(c.x));
    v = max(h * step(abs(c.x), 0.25), w * step(abs(c.y), 0.25));       // cross
  } else if (mode == 3) {
    vec2 q = floor(uv);
    v = mod(q.x + q.y, 2.0) < 0.5 ? 1.0 : 0.0;                          // checker
  } else {
    float h = 1.0 - smoothstep(p1 * 0.5, p1 * 0.5 + 0.01, abs(c.y));
    float w = 1.0 - smoothstep(p1 * 0.5, p1 * 0.5 + 0.01, abs(c.x));
    v = max(h, w);                                                      // lines
  }
  gl_FragColor = vec4(vec3(v), 1.0);
}
`;

export const CHLADNI_FRAG = /* glsl */ `
${COMMON}
// p0 modeX, p1 modeY, p2 threshold, p3 softness, p4 phase
// Chladni plate figure: nodal lines of a square-plate standing wave.
// Mathematically inspired, not a physical simulation (docs are honest).
void main() {
  vec2 uv = vUv;
  float n = floor(p0 + 0.5), m = floor(p1 + 0.5);
  float ph = uTime * p4 * 3.14159265;
  float s = sin(n * 3.14159265 * uv.x + ph) * sin(m * 3.14159265 * uv.y)
          - sin(m * 3.14159265 * uv.x) * sin(n * 3.14159265 * uv.y + ph);
  float d = abs(s);
  float soft = mix(0.002, 0.15, p3);
  float v = 1.0 - smoothstep(p2, p2 + soft, d);
  gl_FragColor = vec4(vec3(v), 1.0);
}
`;

export const GENERATOR_FRAGMENTS: Record<string, string> = {
  noise: NOISE_FRAG,
  waves: WAVES_FRAG,
  voronoi: VORONOI_FRAG,
  grid: GRID_FRAG,
  chladni: CHLADNI_FRAG,
};

/** Ordered param ids per generator → shader p0..p5 slots. */
export const GENERATOR_PARAM_ORDER: Record<string, string[]> = {
  noise: ['scale', 'speed', 'detail', 'warp', 'contrast'],
  waves: ['frequency', 'count', 'speed', 'spread', 'contrast'],
  voronoi: ['scale', 'jitter', 'speed', 'edge', 'contrast'],
  grid: ['scale', 'width', 'rotation', 'offsetX', 'offsetY', 'mode'],
  chladni: ['modeX', 'modeY', 'threshold', 'softness', 'phase'],
};

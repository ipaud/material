import * as THREE from 'three';
import { SIM_FORMAT_CONTINUOUS, SIM_FORMAT_DISCRETE } from './SimulationSurface';
import type { SimulationKernel } from './SimulationRunner';

/**
 * CE1E kernels. Both are original implementations of published rules:
 * Gray-Scott reaction–diffusion (Pearson 1993) and life-like cellular
 * automata (Conway/Gardner 1970). No external shader code.
 */

const HASH = /* glsl */ `
float simHash(vec2 p, float seed) {
  vec3 q = fract(vec3(p.xyx) * 0.1031 + seed * 0.0007);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
`;

// ---------------------------------------------------------------------------
// REACTION DIFFUSION — R = chemical A, G = chemical B (§24)
// ---------------------------------------------------------------------------

const RD_SEED = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec2 uTexel;
uniform float uSeed;
uniform float uDensity;
${HASH}
void main() {
  // Canonical initial condition: A = 1, B = 0, with a handful of seeded
  // BLOBS (deterministic, GPU-derived — §44-45). Blobs must be several
  // cells wide or diffusion erases them before any structure forms.
  float b = 0.0;
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    vec2 c = vec2(simHash(vec2(fi, 3.1), uSeed), simHash(vec2(fi, 7.7), uSeed + 11.0));
    float r = 0.02 + uDensity * 0.25;
    if (distance(vUv, c) < r) b = 1.0;
  }
  gl_FragColor = vec4(1.0, b, 0.0, 1.0);
}
`;

const RD_STEP = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uState;
uniform vec2 uTexel;
uniform float uFeed;
uniform float uKill;
uniform float uIterations;
uniform sampler2D uSource;
uniform float uSourceInfluence;

vec2 lap(vec2 uv) {
  // 9-point Laplacian, standard Gray-Scott weights.
  vec2 s = texture2D(uState, uv).rg * -1.0;
  s += texture2D(uState, uv + vec2(uTexel.x, 0.0)).rg * 0.2;
  s += texture2D(uState, uv - vec2(uTexel.x, 0.0)).rg * 0.2;
  s += texture2D(uState, uv + vec2(0.0, uTexel.y)).rg * 0.2;
  s += texture2D(uState, uv - vec2(0.0, uTexel.y)).rg * 0.2;
  s += texture2D(uState, uv + uTexel).rg * 0.05;
  s += texture2D(uState, uv - uTexel).rg * 0.05;
  s += texture2D(uState, uv + vec2(uTexel.x, -uTexel.y)).rg * 0.05;
  s += texture2D(uState, uv + vec2(-uTexel.x, uTexel.y)).rg * 0.05;
  return s;
}

void main() {
  vec2 st = texture2D(uState, vUv).rg;
  float feed = uFeed;
  float kill = uKill;
  if (uSourceInfluence > 0.0) {
    // Optional: image luminance perturbs the feed rate (§47).
    float l = dot(texture2D(uSource, vUv).rgb, vec3(0.2126, 0.7152, 0.0722));
    feed += (l - 0.5) * 0.012 * uSourceInfluence;
  }
  // Gray-Scott with dA=0.2, dB=0.1 and dt=1 on this unit-weight Laplacian —
  // inside the stability limit (dA·dt ≤ 0.25 for an explicit scheme). The
  // 1.0/0.5 pair overshoots and degenerates into a checkerboard (measured).
  // "Speed" is an ITERATION COUNT, never a dt multiplier (§42).
  for (int i = 0; i < 8; i++) {
    if (float(i) >= uIterations) break;
    vec2 l = lap(vUv);
    float a = st.r, b = st.g;
    float abb = a * b * b;
    float na = a + (0.2 * l.r - abb + feed * (1.0 - a));
    float nb = b + (0.1 * l.g + abb - (kill + feed) * b);
    st = clamp(vec2(na, nb), 0.0, 1.0); // hard bound: no NaN/Inf escape (§51)
  }
  gl_FragColor = vec4(st, 0.0, 1.0);
}
`;

export function reactionDiffusionKernel(): SimulationKernel {
  return {
    seedFragment: RD_SEED,
    stepFragment: RD_STEP,
    format: SIM_FORMAT_CONTINUOUS,
    uniforms: {
      uFeed: { value: 0.055 },
      uKill: { value: 0.062 },
      uIterations: { value: 4 },
      uDensity: { value: 0.06 },
      uSource: { value: null },
      uSourceInfluence: { value: 0 },
    },
  };
}

// ---------------------------------------------------------------------------
// CELLULAR AUTOMATA — R = cell state (0/1), nearest, wrap (§54-62)
// ---------------------------------------------------------------------------

const CA_SEED = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec2 uTexel;
uniform float uSeed;
uniform float uDensity;
uniform float uPreset;   // >0.5 = load a canonical test pattern instead
uniform float uPattern;  // 0 block, 1 blinker, 2 glider
${HASH}
void main() {
  if (uPreset > 0.5) {
    // Deterministic known patterns for the golden tests (§60). Cell coords
    // from the bottom-left of the grid.
    vec2 c = floor(vUv / uTexel);
    float on = 0.0;
    if (uPattern < 0.5) {
      // BLOCK at (4,4)-(5,5) — must remain forever.
      if ((c.x == 4.0 || c.x == 5.0) && (c.y == 4.0 || c.y == 5.0)) on = 1.0;
    } else if (uPattern < 1.5) {
      // BLINKER horizontal at y=8, x=6..8 — period 2.
      if (c.y == 8.0 && c.x >= 6.0 && c.x <= 8.0) on = 1.0;
    } else {
      // GLIDER — canonical cells; travels (+1,-1) every 4 generations.
      if ((c.x == 1.0 && c.y == 3.0) || (c.x == 2.0 && c.y == 2.0) ||
          (c.x == 0.0 && c.y == 1.0) || (c.x == 1.0 && c.y == 1.0) ||
          (c.x == 2.0 && c.y == 1.0)) on = 1.0;
    }
    gl_FragColor = vec4(on, 0.0, 0.0, 1.0);
    return;
  }
  float h = simHash(floor(vUv / uTexel), uSeed);
  gl_FragColor = vec4(h < uDensity ? 1.0 : 0.0, 0.0, 0.0, 1.0);
}
`;

const CA_STEP = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uState;
uniform vec2 uTexel;
uniform float uBirth;    // bitmask: bit n set = birth on n neighbours
uniform float uSurvive;  // bitmask: bit n set = survive with n neighbours
uniform float uWrap;

float cellAt(vec2 uv) {
  if (uWrap < 0.5 && (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)) return 0.0;
  return texture2D(uState, fract(uv + 1.0)).r > 0.5 ? 1.0 : 0.0;
}

bool bitSet(float mask, int n) {
  // mask is an integer-valued float; extract bit n without bitwise ops
  // (WebGL1-safe formulation, exact for masks < 2^9).
  float m = floor(mask / pow(2.0, float(n)));
  return mod(m, 2.0) >= 1.0;
}

void main() {
  float n = 0.0;
  n += cellAt(vUv + vec2(-uTexel.x, -uTexel.y));
  n += cellAt(vUv + vec2(0.0, -uTexel.y));
  n += cellAt(vUv + vec2(uTexel.x, -uTexel.y));
  n += cellAt(vUv + vec2(-uTexel.x, 0.0));
  n += cellAt(vUv + vec2(uTexel.x, 0.0));
  n += cellAt(vUv + vec2(-uTexel.x, uTexel.y));
  n += cellAt(vUv + vec2(0.0, uTexel.y));
  n += cellAt(vUv + vec2(uTexel.x, uTexel.y));
  float alive = cellAt(vUv);
  int count = int(n + 0.5);
  bool next = alive > 0.5 ? bitSet(uSurvive, count) : bitSet(uBirth, count);
  gl_FragColor = vec4(next ? 1.0 : 0.0, 0.0, 0.0, 1.0);
}
`;

/** Life-like rules as birth/survive bitmasks (§57 — curated, not raw B/S). */
export const CA_RULES: Record<string, { birth: number; survive: number }> = {
  // Life B3/S23
  life: { birth: 1 << 3, survive: (1 << 2) | (1 << 3) },
  // HighLife B36/S23
  highlife: { birth: (1 << 3) | (1 << 6), survive: (1 << 2) | (1 << 3) },
  // Seeds B2/S(none)
  seeds: { birth: 1 << 2, survive: 0 },
  // Maze B3/S12345
  maze: { birth: 1 << 3, survive: (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) },
  // Day & Night B3678/S34678
  daynight: {
    birth: (1 << 3) | (1 << 6) | (1 << 7) | (1 << 8),
    survive: (1 << 3) | (1 << 4) | (1 << 6) | (1 << 7) | (1 << 8),
  },
};

export function cellularKernel(): SimulationKernel {
  return {
    seedFragment: CA_SEED,
    stepFragment: CA_STEP,
    format: SIM_FORMAT_DISCRETE,
    uniforms: {
      uBirth: { value: CA_RULES.life!.birth },
      uSurvive: { value: CA_RULES.life!.survive },
      uWrap: { value: 1 },
      uDensity: { value: 0.28 },
      uPreset: { value: 0 },
      uPattern: { value: 0 },
    },
  };
}

export const SIM_UNUSED = THREE.NoColorSpace; // keep three import meaningful

// Soft Warp — Shader Contract v1
// The host provides uMaterial_source, uMaterial_time, uMaterial_resolution,
// uMaterial_seed, uMaterial_aspect, vUv and fragColor. Do not redeclare them.

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

void main() {
  vec2 p = vUv * uParam_scale;
  p.x *= uMaterial_aspect;
  float t = uMaterial_time * uParam_speed;
  vec2 warp = vec2(
    noise(p + vec2(t, 0.0)) - 0.5,
    noise(p + vec2(0.0, t) + 17.3) - 0.5
  );
  fragColor = texture(uMaterial_source, clamp(vUv + warp * uParam_amount, 0.0, 1.0));
}

// Grain Field — Shader Contract v1
// Deterministic: the only inputs are position, composition time and the
// project's seed, so the same frame renders the same grain every time.

float hash3(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

void main() {
  vec4 c = texture(uMaterial_source, vUv);
  vec2 cell = floor(vUv * uMaterial_resolution / max(uParam_size, 0.5));
  float frame = floor(uMaterial_time * uParam_speed);
  float g = hash3(vec3(cell, frame + uMaterial_seed)) - 0.5;
  float luma = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  float weight = uParam_shadows ? (1.0 - luma) : 1.0;
  fragColor = vec4(clamp(c.rgb + g * uParam_amount * weight, 0.0, 1.0), c.a);
}

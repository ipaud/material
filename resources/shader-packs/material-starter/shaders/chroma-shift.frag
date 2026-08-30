// Chromatic Shift — Shader Contract v1

void main() {
  vec2 axis = vec2(cos(uParam_angle), sin(uParam_angle));
  // Falloff pushes the split toward the edges, so the centre stays readable.
  float edge = mix(1.0, length(vUv - 0.5) * 2.0, uParam_falloff);
  vec2 off = axis * uParam_amount * edge;
  float r = texture(uMaterial_source, clamp(vUv + off, 0.0, 1.0)).r;
  float g = texture(uMaterial_source, vUv).g;
  float b = texture(uMaterial_source, clamp(vUv - off, 0.0, 1.0)).b;
  fragColor = vec4(r, g, b, 1.0);
}

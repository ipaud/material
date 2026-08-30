// Posterise — Shader Contract v1

void main() {
  vec4 c = texture(uMaterial_source, vUv);
  vec3 rgb = pow(max(c.rgb, 0.0), vec3(uParam_gamma));
  if (uParam_mono) {
    float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    rgb = vec3(l);
  }
  float steps = float(max(uParam_steps, 2));
  rgb = floor(rgb * steps) / (steps - 1.0);
  fragColor = vec4(clamp(rgb, 0.0, 1.0), c.a);
}

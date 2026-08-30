// Ripple — Shader Contract v1

void main() {
  vec2 centre = vec2(uParam_centerX, uParam_centerY);
  vec2 d = vUv - centre;
  d.x *= uMaterial_aspect;
  float r = length(d);
  float wave = sin(r * uParam_frequency - uMaterial_time * uParam_speed);
  vec2 dir = r > 1e-5 ? d / r : vec2(0.0);
  dir.x /= uMaterial_aspect;
  fragColor = texture(uMaterial_source, clamp(vUv + dir * wave * uParam_amount, 0.0, 1.0));
}

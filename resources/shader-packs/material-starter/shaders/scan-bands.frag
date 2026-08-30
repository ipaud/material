// Scan Bands — Shader Contract v1

void main() {
  float band = floor(vUv.y * uParam_bands);
  float dir = (uParam_mode == 0 && mod(band, 2.0) < 0.5) ? -1.0 : 1.0;
  float phase = sin(band * 1.7 + uMaterial_time * uParam_speed);
  float dx = dir * phase * uParam_shift;
  vec2 uv = vec2(fract(vUv.x + dx), vUv.y);
  fragColor = texture(uMaterial_source, uv);
}

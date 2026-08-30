/*{
  "DESCRIPTION": "Brightness follows TIME; RENDERSIZE scales the vignette.",
  "ISFVSN": "2",
  "INPUTS": [
    { "NAME": "inputImage", "TYPE": "image" },
    { "NAME": "rate", "TYPE": "float", "MIN": 0.0, "MAX": 8.0, "DEFAULT": 2.0 }
  ]
}*/

void main() {
  vec4 c = IMG_THIS_NORM_PIXEL(inputImage);
  float pulse = 0.5 + 0.5 * sin(TIME * rate);
  vec2 px = isf_FragNormCoord * RENDERSIZE;
  float vign = 1.0 - length(px / RENDERSIZE - 0.5);
  gl_FragColor = vec4(c.rgb * pulse * vign, c.a);
}

/*{
  "DESCRIPTION": "Exercises every supported ISF input type.",
  "CREDIT": "MATERIAL test fixture",
  "ISFVSN": "2",
  "INPUTS": [
    { "NAME": "inputImage", "TYPE": "image" },
    { "NAME": "level", "TYPE": "float", "MIN": 0.0, "MAX": 2.0, "DEFAULT": 0.75, "LABEL": "Level" },
    { "NAME": "invert", "TYPE": "bool", "DEFAULT": false },
    { "NAME": "mode", "TYPE": "long", "VALUES": [0, 3, 7], "LABELS": ["Off", "Soft", "Hard"], "DEFAULT": 3 }
  ]
}*/

void main() {
  vec4 c = IMG_NORM_PIXEL(inputImage, isf_FragNormCoord);
  vec3 rgb = c.rgb * level;
  if (invert) rgb = 1.0 - rgb;
  if (mode == 7) rgb = step(vec3(0.5), rgb);
  gl_FragColor = vec4(rgb, c.a);
}

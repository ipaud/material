/*{
  "DESCRIPTION": "No image input — a generator, deliberately unsupported in v0.5.",
  "ISFVSN": "2",
  "INPUTS": [ { "NAME": "hue", "TYPE": "float", "MIN": 0.0, "MAX": 1.0, "DEFAULT": 0.5 } ]
}*/

void main() { gl_FragColor = vec4(hue, 0.0, 1.0 - hue, 1.0); }

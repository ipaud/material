/*{
  "DESCRIPTION": "Audio input — deliberately unsupported.",
  "ISFVSN": "2",
  "INPUTS": [
    { "NAME": "inputImage", "TYPE": "image" },
    { "NAME": "levels", "TYPE": "audioFFT" }
  ]
}*/

void main() { gl_FragColor = IMG_THIS_PIXEL(inputImage); }

/*{
  "DESCRIPTION": "Two image inputs — deliberately unsupported.",
  "ISFVSN": "2",
  "INPUTS": [
    { "NAME": "inputImage", "TYPE": "image" },
    { "NAME": "otherImage", "TYPE": "image" }
  ]
}*/

void main() { gl_FragColor = IMG_THIS_PIXEL(inputImage); }

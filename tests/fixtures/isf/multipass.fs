/*{
  "DESCRIPTION": "Two passes — deliberately unsupported.",
  "ISFVSN": "2",
  "INPUTS": [ { "NAME": "inputImage", "TYPE": "image" } ],
  "PASSES": [ { "TARGET": "bufferA" }, {} ]
}*/

void main() { gl_FragColor = IMG_THIS_PIXEL(inputImage); }

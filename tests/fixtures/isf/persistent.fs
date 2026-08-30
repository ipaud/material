/*{
  "DESCRIPTION": "Persistent buffer — deliberately unsupported.",
  "ISFVSN": "2",
  "INPUTS": [ { "NAME": "inputImage", "TYPE": "image" } ],
  "PASSES": [ { "TARGET": "feedback", "PERSISTENT": true } ]
}*/

void main() { gl_FragColor = IMG_THIS_PIXEL(inputImage); }

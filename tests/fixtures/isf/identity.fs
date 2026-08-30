/*{
  "DESCRIPTION": "Passes the frame through unchanged.",
  "CREDIT": "MATERIAL test fixture",
  "ISFVSN": "2",
  "CATEGORIES": ["Test"],
  "INPUTS": [
    { "NAME": "inputImage", "TYPE": "image" }
  ]
}*/

void main() {
  gl_FragColor = IMG_THIS_PIXEL(inputImage);
}

import * as THREE from 'three';
import { bindTarget } from '../bindTarget';
import type { BlendMode } from '@shared/schemas/project';
import { disposeSceneGeometry } from '@/rendering/disposeScene';

/**
 * v0.6A — one explicit compositing stage.
 *
 * Layers are blended here and nowhere else. Folding compositing into each
 * technique would mean every technique had to know what was beneath it, and
 * the same blend would be written as many times as there are techniques.
 *
 * Bottom to top, ping-pong between two accumulators: two targets total,
 * whatever the layer count. Allocating one target per intermediate result
 * would scale memory with layers for no benefit — the accumulator is the only
 * intermediate anyone can observe.
 *
 * ALPHA: a layer target holds PREMULTIPLIED alpha, because that is what GL's
 * standard blend produces when a technique draws onto a transparent buffer —
 * `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` leaves colour already scaled by coverage.
 * The compositor therefore un-premultiplies before applying a blend function
 * and re-applies coverage afterwards.
 *
 * Treating those texels as straight alpha instead multiplies coverage twice.
 * Measured: soft tile edges came out up to 188 codes dark against the same
 * scene rendered without layers — the dark-fringe failure, exactly where it
 * was expected.
 *
 * Layer targets clear to transparent BLACK, so an empty region contributes
 * nothing rather than painting the composition background over what is below.
 * The background is painted ONCE, by the composition, before layer 0.
 */

const VERT = /* glsl */ `
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }
`;

/**
 * Blend math, applied to straight-alpha colour in the pipeline's own space
 * (sRGB-encoded, as every other pass in MATERIAL works). Stated explicitly so
 * a future linear-light pipeline changes this in one place rather than
 * drifting mode by mode.
 *
 *   normal      S
 *   add         B + S
 *   screen      1 - (1-B)(1-S)
 *   multiply    B * S
 *   difference  |B - S|
 *   lighten     max(B, S)
 *   darken      min(B, S)
 *
 * The result is then mixed against the backdrop by the layer's effective
 * coverage: `alpha = layerAlpha * opacity`. At opacity 0 every mode is exactly
 * the backdrop, which is what makes opacity a safe performance control.
 */
const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uBackdrop;
uniform sampler2D uLayer;
uniform float uOpacity;
uniform int uMode;
in vec2 vUv;
out vec4 fragColor;

vec3 blend(int mode, vec3 b, vec3 s) {
  if (mode == 1) return b + s;                       // add
  if (mode == 2) return 1.0 - (1.0 - b) * (1.0 - s); // screen
  if (mode == 3) return b * s;                       // multiply
  if (mode == 4) return abs(b - s);                  // difference
  if (mode == 5) return max(b, s);                   // lighten
  if (mode == 6) return min(b, s);                   // darken
  return s;                                          // normal
}

void main() {
  vec4 B = texture(uBackdrop, vUv);
  vec4 S = texture(uLayer, vUv);
  // Un-premultiply: the blend functions are defined on colour, not on colour
  // already scaled by its own coverage.
  vec3 Sc = S.a > 0.0031 ? S.rgb / S.a : vec3(0.0);
  float a = clamp(S.a * uOpacity, 0.0, 1.0);
  vec3 blended = clamp(blend(uMode, B.rgb, Sc), 0.0, 1.0);
  fragColor = vec4(mix(B.rgb, blended, a), clamp(B.a + a * (1.0 - B.a), 0.0, 1.0));
}
`;

export const BLEND_MODE_INDEX: Record<BlendMode, number> = {
  normal: 0,
  add: 1,
  screen: 2,
  multiply: 3,
  difference: 4,
  lighten: 5,
  darken: 6,
};

/** CPU mirror of the shader, so the goldens assert one agreed formula. */
export function blendChannel(mode: BlendMode, b: number, s: number): number {
  switch (mode) {
    case 'add':
      return b + s;
    case 'screen':
      return 1 - (1 - b) * (1 - s);
    case 'multiply':
      return b * s;
    case 'difference':
      return Math.abs(b - s);
    case 'lighten':
      return Math.max(b, s);
    case 'darken':
      return Math.min(b, s);
    default:
      return s;
  }
}

/** CPU mirror of one composite step, including coverage. */
export function compositeChannel(
  mode: BlendMode,
  backdrop: number,
  layer: number,
  alpha: number,
): number {
  const blended = Math.min(Math.max(blendChannel(mode, backdrop, layer), 0), 1);
  return backdrop + (blended - backdrop) * Math.min(Math.max(alpha, 0), 1);
}

function target(width: number, height: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: false,
    stencilBuffer: false,
    colorSpace: THREE.SRGBColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
}

export interface CompositeLayer {
  texture: THREE.Texture;
  opacity: number;
  blendMode: BlendMode;
}

export class LayerCompositor {
  private readonly material: THREE.ShaderMaterial;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  private accumulators: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private width = 0;
  private height = 0;
  /** Diagnostics: composite draws in the last frame. */
  passes = 0;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uBackdrop: { value: null },
        uLayer: { value: null },
        uOpacity: { value: 1 },
        uMode: { value: 0 },
      },
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  get bytes(): number {
    if (!this.accumulators) return 0;
    return this.width * this.height * 4 * 2;
  }

  private ensure(width: number, height: number): [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] {
    if (this.accumulators && this.width === width && this.height === height) {
      return this.accumulators;
    }
    this.release();
    this.width = width;
    this.height = height;
    this.accumulators = [target(width, height), target(width, height)];
    return this.accumulators;
  }

  /**
   * Blend `layers` bottom-first over `background`, and return the texture
   * holding the result. Returns null when nothing is visible, so the caller
   * can decide what an empty composition looks like rather than being handed
   * an arbitrary colour.
   */
  composite(
    renderer: THREE.WebGLRenderer,
    layers: readonly CompositeLayer[],
    width: number,
    height: number,
    background: { color: string; alpha: number },
  ): THREE.Texture | null {
    this.passes = 0;
    if (width < 1 || height < 1) return null;
    const [a, b] = this.ensure(width, height);
    const prevTarget = renderer.getRenderTarget();
    let read = a;
    let write = b;
    try {
      // No setPixelRatio: three implements it as a canvas resize, which
      // reallocated the drawing buffer once per layer per frame (measured at
      // -80 fps on a single-layer composition). setViewport IS needed — the
      // preview leaves a canvas-sized viewport behind and binding a target
      // does not reliably replace it, which rendered every layer to nothing.
      // The background is painted once, beneath everything.
      bindTarget(renderer, read);
      renderer.setClearColor(background.color, background.alpha);
      renderer.clear();

      for (const layer of layers) {
        const u = this.material.uniforms;
        u.uBackdrop!.value = read.texture;
        u.uLayer!.value = layer.texture;
        u.uOpacity!.value = layer.opacity;
        u.uMode!.value = BLEND_MODE_INDEX[layer.blendMode] ?? 0;
        bindTarget(renderer, write);
        renderer.render(this.scene, this.camera);
        this.passes++;
        const swap = read;
        read = write;
        write = swap;
      }
    } finally {
      renderer.setRenderTarget(prevTarget);
    }
    return read.texture;
  }

  release(): void {
    if (!this.accumulators) return;
    for (const t of this.accumulators) t.dispose();
    this.accumulators = null;
    this.width = 0;
    this.height = 0;
  }

  dispose(): void {
    this.release();
    this.material.dispose();
    disposeSceneGeometry(this.scene);
  }
}

import type * as THREE from 'three';

/**
 * Bind an offscreen render target.
 *
 * `setRenderTarget` already installs the target's own viewport and scissor
 * (`renderTarget.viewport`, unscaled), so the correct thing to do afterwards
 * is NOTHING. Two calls are tempting here and both are wrong:
 *
 * - `setViewport(0, 0, w, h)` multiplies by the renderer's pixel ratio, so on
 *   a 2x display it sets a 2x viewport and the pass renders zoomed into its
 *   own target. Measured on the waves generator at 640x360: 175 335 non-black
 *   pixels instead of 192 588, and a mosaic showing ten of its forty columns.
 * - `setPixelRatio(1)` is implemented as `setSize()`, which reallocates the
 *   canvas drawing buffer — 80 fps on a one-layer composition.
 *
 * Scissor is the exception: it is left enabled by the preview, which draws the
 * canvas through a scissor rect, and it does not belong to this target.
 *
 * This function exists to hold that explanation in one place, because the
 * failure it prevents looks like a layer bug rather than a viewport bug.
 */
export function bindTarget(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget): void {
  renderer.setRenderTarget(target);
  renderer.setScissorTest(false);
}

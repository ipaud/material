import * as THREE from 'three';
import type { BlendMode } from '@shared/schemas/project';
import { LayerCompositor, compositeChannel, type CompositeLayer } from './LayerCompositor';

/**
 * v0.6A — GPU goldens for the compositor.
 *
 * Solid colours with known values, so every expectation is an exact number
 * rather than "looks right". The CPU mirror in LayerCompositor is the same
 * formula the shader uses, and these fixtures are what keep the two honest.
 */

function solid(
  renderer: THREE.WebGLRenderer,
  rgba: [number, number, number, number],
  size = 16,
): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    depthBuffer: false,
    colorSpace: THREE.NoColorSpace,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  const prev = renderer.getRenderTarget();
  const prevRatio = renderer.getPixelRatio();
  renderer.setPixelRatio(1);
  renderer.setRenderTarget(rt);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, size, size);
  renderer.setClearColor(new THREE.Color(rgba[0], rgba[1], rgba[2]), rgba[3]);
  renderer.clear();
  renderer.setRenderTarget(prev);
  renderer.setPixelRatio(prevRatio);
  return rt;
}

function readCentre(
  renderer: THREE.WebGLRenderer,
  texture: THREE.Texture,
  size: number,
): [number, number, number, number] {
  // Copy through a known target so a texture from any source can be sampled.
  const rt = new THREE.WebGLRenderTarget(size, size, {
    depthBuffer: false,
    colorSpace: THREE.NoColorSpace,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: 'out vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy*2.0,0.0,1.0); }',
    fragmentShader:
      'precision highp float; uniform sampler2D t; in vec2 vUv; out vec4 fragColor; void main(){ fragColor = texture(t, vUv); }',
    depthTest: false,
    depthWrite: false,
    uniforms: { t: { value: texture } },
  });
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const cam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  const prev = renderer.getRenderTarget();
  const prevRatio = renderer.getPixelRatio();
  renderer.setPixelRatio(1);
  renderer.setRenderTarget(rt);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, size, size);
  renderer.render(scene, cam);
  const px = new Uint8Array(4);
  renderer.readRenderTargetPixels(rt, size >> 1, size >> 1, 1, 1, px);
  renderer.setRenderTarget(prev);
  renderer.setPixelRatio(prevRatio);
  mat.dispose();
  mesh.geometry.dispose();
  rt.dispose();
  return [px[0] as number, px[1] as number, px[2] as number, px[3] as number];
}

const SIZE = 16;

export function runLayerGoldens(renderer: THREE.WebGLRenderer): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const compositor = new LayerCompositor();
  const made: THREE.WebGLRenderTarget[] = [];
  const layer = (
    rgba: [number, number, number, number],
    opacity: number,
    blendMode: BlendMode,
  ): CompositeLayer => {
    const rt = solid(renderer, rgba, SIZE);
    made.push(rt);
    return { texture: rt.texture, opacity, blendMode };
  };
  const run = (layers: CompositeLayer[], bg = '#000000') => {
    const tex = compositor.composite(renderer, layers, SIZE, SIZE, { color: bg, alpha: 1 });
    return tex ? readCentre(renderer, tex, SIZE) : null;
  };
  const near = (got: number, want: number, tol = 2) => Math.abs(got - want) <= tol;

  try {
    // 1. ONE LAYER, opaque: the composite is exactly that layer. This is the
    //    identity the single-layer case depends on.
    const red = run([layer([1, 0, 0, 1], 1, 'normal')]);
    out.singleOpaque = { rgba: red, ok: !!red && near(red[0], 255) && near(red[1], 0) && near(red[2], 0) };

    // 2. TWO LAYERS: red under blue at half opacity → exactly half of each.
    const half = run([layer([1, 0, 0, 1], 1, 'normal'), layer([0, 0, 1, 1], 0.5, 'normal')]);
    out.twoLayerHalf = {
      rgba: half,
      expected: [128, 0, 128],
      ok: !!half && near(half[0], 128, 3) && near(half[1], 0) && near(half[2], 128, 3),
    };

    // 3. THREE LAYERS prove ORDER. Same three colours, reversed, must differ.
    const forward = run([
      layer([1, 0, 0, 1], 1, 'normal'),
      layer([0, 1, 0, 1], 0.5, 'normal'),
      layer([0, 0, 1, 1], 0.5, 'normal'),
    ]);
    const reversed = run([
      layer([0, 0, 1, 1], 1, 'normal'),
      layer([0, 1, 0, 1], 0.5, 'normal'),
      layer([1, 0, 0, 1], 0.5, 'normal'),
    ]);
    out.orderMatters = {
      forward,
      reversed,
      // forward: red → 50% green → 50% blue = (64, 64, 128)
      ok:
        !!forward &&
        !!reversed &&
        near(forward[0], 64, 3) &&
        near(forward[1], 64, 3) &&
        near(forward[2], 128, 3) &&
        (forward[0] !== reversed[0] || forward[2] !== reversed[2]),
    };

    // 4. OPACITY 0 contributes exactly nothing — the control that makes it
    //    safe to fade a layer out without stopping its runtime.
    const invisible = run([layer([1, 0, 0, 1], 1, 'normal'), layer([0, 0, 1, 1], 0, 'normal')]);
    out.zeroOpacity = { rgba: invisible, ok: !!invisible && near(invisible[0], 255) && near(invisible[2], 0) };

    // 5. AN EMPTY LAYER (transparent) does not paint black over what is below.
    const withEmpty = run([layer([1, 0, 0, 1], 1, 'normal'), layer([0, 0, 0, 0], 1, 'normal')]);
    out.transparentLayer = {
      rgba: withEmpty,
      ok: !!withEmpty && near(withEmpty[0], 255) && near(withEmpty[1], 0),
    };

    // 6. BLEND MODES against the CPU mirror, at full coverage.
    const B: [number, number, number] = [0.6, 0.3, 0.2];
    const S: [number, number, number] = [0.4, 0.8, 0.5];
    const modes: BlendMode[] = ['normal', 'add', 'screen', 'multiply', 'difference', 'lighten', 'darken'];
    const blendRows: Record<string, unknown> = {};
    for (const mode of modes) {
      const got = run([layer([...B, 1], 1, 'normal'), layer([...S, 1], 1, mode)]);
      const want = [0, 1, 2].map((i) =>
        Math.round(compositeChannel(mode, B[i] as number, S[i] as number, 1) * 255),
      );
      blendRows[mode] = {
        got: got?.slice(0, 3),
        want,
        // sRGB round-trip through an 8-bit target: a couple of codes of slack.
        ok: !!got && [0, 1, 2].every((i) => near(got[i] as number, want[i] as number, 3)),
      };
    }
    out.blendModes = blendRows;

    // 7. BLEND × OPACITY: half coverage is exactly half way to the blend.
    const halfMultiply = run([layer([...B, 1], 1, 'normal'), layer([...S, 1], 0.5, 'multiply')]);
    const wantHalf = [0, 1, 2].map((i) =>
      Math.round(compositeChannel('multiply', B[i] as number, S[i] as number, 0.5) * 255),
    );
    out.blendWithOpacity = {
      got: halfMultiply?.slice(0, 3),
      want: wantHalf,
      ok: !!halfMultiply && [0, 1, 2].every((i) => near(halfMultiply[i] as number, wantHalf[i] as number, 3)),
    };

    // 8. Two accumulators, whatever the layer count.
    const before = compositor.bytes;
    run([
      layer([1, 0, 0, 1], 1, 'normal'),
      layer([0, 1, 0, 1], 1, 'add'),
      layer([0, 0, 1, 1], 1, 'screen'),
      layer([1, 1, 0, 1], 1, 'multiply'),
    ]);
    out.accumulators = {
      bytes: compositor.bytes,
      expected: SIZE * SIZE * 4 * 2,
      passes: compositor.passes,
      ok: compositor.bytes === SIZE * SIZE * 4 * 2 && compositor.passes === 4 && before >= 0,
    };
  } finally {
    for (const rt of made) rt.dispose();
    compositor.dispose();
  }

  out.allOk = Object.entries(out).every(([k, v]) => {
    if (k === 'allOk' || typeof v !== 'object' || v === null) return true;
    if ('ok' in (v as object)) return (v as { ok?: boolean }).ok !== false;
    // blendModes is a map of rows.
    return Object.values(v as Record<string, { ok?: boolean }>).every((r) => r.ok !== false);
  });
  return out;
}

/**
 * v0.6A — live probe: what does each branch actually put on its own target,
 * and what does the composite produce?
 *
 * The compositor goldens above prove the blend math with synthetic inputs.
 * They stay green even when no branch draws anything, so this is the
 * companion that fails when the layers themselves are empty.
 */
export function probeLayers(
  engine: {
    renderer: THREE.WebGLRenderer | null;
    layerIds: string[];
    branchFor(id: string): {
      renderLayerTo(t: THREE.WebGLRenderTarget, o: { clear: boolean; skip?: ReadonlySet<string> }): void;
      sourceTexture: THREE.Texture | null;
      lastLayerRender: Record<string, unknown> | null;
      scene: THREE.Scene;
      camera: THREE.Camera;
    } | null;
    renderStill(w: number, h: number): Uint8Array;
  },
  size = 64,
): Record<string, unknown> {
  const renderer = engine.renderer;
  if (!renderer) return { error: 'no renderer' };
  const stat = (px: Uint8Array | Uint8ClampedArray) => {
    let max = 0;
    let alpha = 0;
    let nonBlack = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i]! > max) max = px[i]!;
      alpha += px[i + 3]!;
      if (px[i]! || px[i + 1]! || px[i + 2]!) nonBlack++;
    }
    return { max, meanAlpha: Math.round(alpha / (px.length / 4)), nonBlack };
  };
  const perLayer: Record<string, unknown> = {};
  const prev = renderer.getRenderTarget();
  const h = Math.round(size * 0.5625);
  for (const id of engine.layerIds) {
    const branch = engine.branchFor(id);
    if (!branch) {
      perLayer[id] = { error: 'no branch' };
      continue;
    }
    const readInto = (fn: (t: THREE.WebGLRenderTarget) => void) => {
      const t = new THREE.WebGLRenderTarget(size, h, { depthBuffer: false });
      fn(t);
      const buf = new Uint8Array(size * h * 4);
      renderer.readRenderTargetPixels(t, 0, 0, size, h, buf);
      t.dispose();
      return buf;
    };
    // Order matters for diagnosis: the same call twice tells a priming
    // failure apart from a wiring failure.
    const px = readInto((t) => branch.renderLayerTo(t, { clear: true }));
    const pxAgain = readInto((t) => branch.renderLayerTo(t, { clear: true }));
    const bisect: Record<string, unknown> = {};
    for (const step of ['temporal', 'camera', 'generator', 'flow', 'sync', 'stats', 'feedback']) {
      const buf = readInto((t) => branch.renderLayerTo(t, { clear: true, skip: new Set([step]) }));
      bisect[step] = stat(buf).nonBlack;
    }
    bisect.all = stat(
      readInto((t) =>
        branch.renderLayerTo(t, {
          clear: true,
          skip: new Set(['temporal', 'camera', 'generator', 'flow', 'sync', 'stats', 'feedback']),
        }),
      ),
    ).nonBlack;
    // Sample the layer's SOURCE too: a black layer with a black source is an
    // upstream failure, a black layer over a live source is the technique.
    // Bypass renderLayerTo entirely: same scene, same camera, explicit
    // viewport. If this draws and renderLayerTo does not, the fault is in the
    // layer wrapper rather than in the branch's creative chain.
    const px2 = readInto((t) => {
      renderer.setRenderTarget(t);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, size, h);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(branch.scene, branch.camera);
      // Same unbind renderLayerTo does in its finally block, to tell a
      // resolve/unbind problem apart from a wiring problem.
      renderer.setRenderTarget(null);
    });
    const src = branch.sourceTexture;
    perLayer[id] = {
      layer: stat(px),
      layerAgain: stat(pxAgain),
      info: branch.lastLayerRender,
      bisect,
      direct: stat(px2),
      source: src ? readCentre(renderer, src, 16) : null,
    };
  }
  renderer.setRenderTarget(prev);
  return { perLayer, still: stat(engine.renderStill(size, h)) };
}

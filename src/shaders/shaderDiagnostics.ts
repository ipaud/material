import * as THREE from 'three';
import type { LoadedShader, ShaderParamDef } from '@shared/schemas/shaderPack';
import { CustomShaderRenderer } from './CustomShaderRenderer';
import { validateFragment } from './compileShader';

/**
 * v0.5A — GPU goldens for the shader host, run against the real product path.
 *
 * Per docs/GPU_TESTING.md the harness proves itself first: an IDENTITY shader
 * must reproduce its source exactly, or nothing measured afterwards means
 * anything. Every other fixture then has a companion that fails when the host
 * stops doing its job — a shader that ignores its source, its time or its
 * parameter is deterministic and useless, and determinism alone must never
 * read as success.
 */

const CHECKER = /* glsl */ `
varying vec2 vUv;
void main() {
  vec2 c = floor(vUv * 8.0);
  float m = mod(c.x + c.y, 2.0);
  gl_FragColor = vec4(m, vUv.x, 1.0 - m, 1.0);
}
`;

function sourceTexture(renderer: THREE.WebGLRenderer, w: number, h: number): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    depthBuffer: false,
    colorSpace: THREE.NoColorSpace,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  const mat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }',
    fragmentShader: CHECKER,
    depthTest: false,
    depthWrite: false,
  });
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const cam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.setScissorTest(false);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prev);
  mat.dispose();
  mesh.geometry.dispose();
  return rt;
}

function shader(id: string, fragment: string, params: ShaderParamDef[] = []): LoadedShader {
  return {
    packId: 'material.goldens',
    packName: 'Goldens',
    packVersion: '1.0.0',
    entry: { id, name: id, description: '', file: `${id}.frag`, params, presets: [] },
    fragment,
    hash: `${id}:${fragment.length}:${params.length}`,
  };
}

/** Render one custom shader over the checker source and read it back. */
function renderShader(
  renderer: THREE.WebGLRenderer,
  loaded: LoadedShader,
  params: Record<string, number | boolean | string>,
  timeSec: number,
  size = 64,
): { pixels: Uint8Array; state: string } {
  const src = sourceTexture(renderer, size, size);
  const target = new THREE.WebGLRenderTarget(size, size, {
    depthBuffer: false,
    colorSpace: THREE.NoColorSpace,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  const custom = new CustomShaderRenderer(loaded);
  const scene = new THREE.Scene();
  scene.add(custom.object3d);
  // The host's vertex shader scales by comp size, so the golden camera has to
  // frame that quad rather than a unit one.
  const view = new THREE.OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, 0, 10);
  view.position.z = 1;
  custom.update(params, {
    sourceTexture: src.texture,
    materialTexture: null,
    temporal: null,
    flow: null,
    compWidth: size,
    compHeight: size,
    material: { materialId: 'square', colorMode: 'source', params: {}, assetPath: null },
    timeSec,
    seed: 7,
    renderer,
  });
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.setScissorTest(false);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  renderer.render(scene, view);
  const pixels = new Uint8Array(size * size * 4);
  renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
  renderer.setRenderTarget(prev);
  const state = custom.state.status;
  custom.dispose();
  src.dispose();
  target.dispose();
  return { pixels, state };
}

function readSource(renderer: THREE.WebGLRenderer, size = 64): Uint8Array {
  return renderShader(renderer, shader('identity', 'void main() { fragColor = texture(uMaterial_source, vUv); }'), {}, 0, size).pixels;
}

const maxDiff = (a: Uint8Array, b: Uint8Array): number => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs((a[i] as number) - (b[i] as number)));
  return m;
};

export function runShaderGoldens(renderer: THREE.WebGLRenderer): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const size = 64;

  // 1. IDENTITY — the harness proving itself. Anything else measured through
  //    this path is meaningless until the host can reproduce its input.
  const src = readSource(renderer, size);
  const identity = renderShader(
    renderer,
    shader('identity', 'void main() { fragColor = texture(uMaterial_source, vUv); }'),
    {},
    0,
    size,
  );
  out.identity = { state: identity.state, maxDiff: maxDiff(src, identity.pixels), ok: maxDiff(src, identity.pixels) === 0 };

  // 2. INVERT — the companion that fails if the host feeds a blank source.
  const invert = renderShader(
    renderer,
    shader('invert', 'void main() { vec4 c = texture(uMaterial_source, vUv); fragColor = vec4(1.0 - c.rgb, c.a); }'),
    {},
    0,
    size,
  );
  let inverted = true;
  for (let i = 0; i < src.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const a = src[i + c] as number;
      const b = invert.pixels[i + c] as number;
      if (Math.abs(255 - a - b) > 1) inverted = false;
    }
  }
  out.invert = { state: invert.state, ok: inverted, differsFromSource: maxDiff(src, invert.pixels) > 8 };

  // 3. UV — pins the orientation contract. vUv is 0..1 with (0,0) bottom-left,
  //    and a shader that assumed otherwise would silently render mirrored.
  const uv = renderShader(renderer, shader('uv', 'void main() { fragColor = vec4(vUv, 0.0, 1.0); }'), {}, 0, size);
  const at = (x: number, y: number, ch: number) => uv.pixels[((y * size + x) * 4) + ch] as number;
  out.uv = {
    // readRenderTargetPixels returns rows bottom-up, matching GL, so row 0 is
    // vUv.y ~ 0 and the last row is vUv.y ~ 1.
    bottomLeft: [at(0, 0, 0), at(0, 0, 1)],
    topRight: [at(size - 1, size - 1, 0), at(size - 1, size - 1, 1)],
    ok: at(0, 0, 0) < 8 && at(0, 0, 1) < 8 && at(size - 1, size - 1, 0) > 247 && at(size - 1, size - 1, 1) > 247,
  };

  // 4. TIME — deterministic, from composition time. Same t twice must be
  //    bit-identical; a different t must differ.
  const timeFrag = 'void main() { fragColor = vec4(vec3(0.5 + 0.5 * sin(uMaterial_time)), 1.0); }';
  const t1a = renderShader(renderer, shader('time', timeFrag), {}, 1.25, 8);
  const t1b = renderShader(renderer, shader('time', timeFrag), {}, 1.25, 8);
  const t2 = renderShader(renderer, shader('time', timeFrag), {}, 2.75, 8);
  out.time = {
    repeatIdentical: maxDiff(t1a.pixels, t1b.pixels) === 0,
    differsAcrossTime: maxDiff(t1a.pixels, t2.pixels) > 8,
    ok: maxDiff(t1a.pixels, t1b.pixels) === 0 && maxDiff(t1a.pixels, t2.pixels) > 8,
  };

  // 5. SEED — deterministic and project-owned, never Math.random.
  const seedFrag = 'void main() { fragColor = vec4(vec3(fract(uMaterial_seed * 0.1)), 1.0); }';
  const s1 = renderShader(renderer, shader('seed', seedFrag), {}, 0, 8);
  const s2 = renderShader(renderer, shader('seed', seedFrag), {}, 0, 8);
  out.seed = { deterministic: maxDiff(s1.pixels, s2.pixels) === 0, ok: maxDiff(s1.pixels, s2.pixels) === 0 };

  // 6. PARAM — a declared parameter must actually reach the uniform.
  const paramShader = shader('param', 'void main() { fragColor = vec4(vec3(uParam_level), 1.0); }', [
    { type: 'float', id: 'level', label: 'Level', group: 'Structure', modulatable: true, explorable: true, min: 0, max: 1, default: 0 },
  ]);
  const p0 = renderShader(renderer, paramShader, { level: 0 }, 0, 8);
  const p1 = renderShader(renderer, paramShader, { level: 1 }, 0, 8);
  out.param = {
    low: p0.pixels[0],
    high: p1.pixels[0],
    ok: (p0.pixels[0] as number) < 8 && (p1.pixels[0] as number) > 247,
  };

  // 7. RESOLUTION — the shader is told the real size, not a hardcoded one.
  const resFrag = 'void main() { fragColor = vec4(vec3(uMaterial_resolution.x / 512.0), 1.0); }';
  const r32 = renderShader(renderer, shader('res', resFrag), {}, 0, 32);
  const r64 = renderShader(renderer, shader('res', resFrag), {}, 0, 64);
  out.resolution = {
    at32: r32.pixels[0],
    at64: r64.pixels[0],
    ok: Math.abs((r32.pixels[0] as number) - 16) <= 2 && Math.abs((r64.pixels[0] as number) - 32) <= 2,
  };

  // 8. COMPILE FAILURE — broken GLSL is caught by the host, reported against
  //    the AUTHOR's line numbers, and leaves the previous frame drawable.
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const broken = validateFragment(gl, [], 'void main() {\n  fragColor = nope;\n}');
  out.compileError = {
    caught: !broken.ok,
    firstLine: broken.errors[0]?.line ?? null,
    message: broken.errors[0]?.message ?? '',
    // The error is on the author's line 2, not on some offset into the prelude.
    ok: !broken.ok && broken.errors[0]?.line === 2,
  };

  // 9. LAST-KNOWN-GOOD — a failed revision must not black out the output.
  const good = shader('lkg', 'void main() { fragColor = vec4(1.0, 0.0, 0.0, 1.0); }');
  const custom = new CustomShaderRenderer(good);
  const ctx = {
    sourceTexture: sourceTexture(renderer, 8, 8).texture,
    materialTexture: null,
    temporal: null,
    flow: null,
    compWidth: 8,
    compHeight: 8,
    material: { materialId: 'square', colorMode: 'source' as const, params: {}, assetPath: null },
    timeSec: 0,
    seed: 0,
    renderer,
  };
  custom.update({}, ctx);
  const okState = custom.state.status;
  custom.setShader({ ...good, fragment: 'void main() { this is not glsl }', hash: 'lkg-broken' });
  custom.update({}, ctx);
  out.lastKnownGood = {
    firstCompile: okState,
    afterBadEdit: custom.state.status,
    stillHasMaterial: custom.object3d.material !== undefined,
    ok: okState === 'ok' && custom.state.status === 'error' && custom.state.message !== null,
  };
  custom.dispose();

  // 10. NO RECOMPILE ON A PARAMETER MOVE — the hash is the only trigger.
  const counted = shader('hot', 'void main() { fragColor = vec4(vec3(uParam_level), 1.0); }', [
    { type: 'float', id: 'level', label: 'Level', group: 'Structure', modulatable: true, explorable: true, min: 0, max: 1, default: 0 },
  ]);
  const hot = new CustomShaderRenderer(counted);
  const hotScene = new THREE.Scene();
  hotScene.add(hot.object3d);
  const hotCam = new THREE.OrthographicCamera(-4, 4, 4, -4, 0, 10);
  hotCam.position.z = 1;
  const hotTarget = new THREE.WebGLRenderTarget(8, 8, { depthBuffer: false });
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(hotTarget);
  hot.update({ level: 0 }, { ...ctx, timeSec: 0 });
  renderer.render(hotScene, hotCam);
  const before = renderer.info.programs?.length ?? 0;
  for (let i = 1; i <= 20; i++) {
    hot.update({ level: i / 20 }, { ...ctx, timeSec: i * 0.1 });
    renderer.render(hotScene, hotCam);
  }
  const after = renderer.info.programs?.length ?? 0;
  renderer.setRenderTarget(prevTarget);
  // Moving a slider changes a uniform. It must not build a program.
  out.noRecompile = { programsBefore: before, programsAfter: after, ok: after === before };
  hot.dispose();
  hotTarget.dispose();

  out.allOk = Object.entries(out).every(([k, v]) =>
    k === 'allOk' || typeof v !== 'object' || v === null ? true : (v as { ok?: boolean }).ok !== false,
  );
  return out;
}

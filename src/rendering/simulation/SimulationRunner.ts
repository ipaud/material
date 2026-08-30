import * as THREE from 'three';
import { disposeSceneGeometry } from '../disposeScene';
import {
  SimulationClock,
  SimulationSurface,
  type SimulationFormat,
} from './SimulationSurface';

/**
 * CE1E — the shared lifecycle every simulation gets: surfaces, seeding,
 * fixed stepping (preview accumulator / export integer index), reset,
 * disposal. Each system supplies only its own kernel: a seed shader, a
 * step shader, a state format and a grid — nothing more (§65-66). No DSL,
 * no graph.
 */

export interface SimulationKernel {
  /** GLSL for the seed pass: writes canonical initial state from uSeed. */
  seedFragment: string;
  /** GLSL for one update step: samples uState, writes the next state. */
  stepFragment: string;
  format: SimulationFormat;
  /** Extra uniforms the system needs (shared by both passes when named). */
  uniforms: Record<string, THREE.IUniform>;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }
`;

function fsqScene(material: THREE.ShaderMaterial): THREE.Scene {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return scene;
}

export class SimulationRunner {
  private surface: SimulationSurface;
  private clock = new SimulationClock();
  private seedMat: THREE.ShaderMaterial;
  private stepMat: THREE.ShaderMaterial;
  private seedScene: THREE.Scene;
  private stepScene: THREE.Scene;
  private camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  /** Diagnostics: total steps run since construction. */
  totalSteps = 0;

  constructor(
    private kernel: SimulationKernel,
    width: number,
    height: number,
  ) {
    this.surface = new SimulationSurface(width, height, kernel.format);
    const common = () => ({
      uState: { value: null as THREE.Texture | null },
      uTexel: { value: new THREE.Vector2(1 / width, 1 / height) },
      uSeed: { value: 1 },
      uStep: { value: 0 },
      ...kernel.uniforms,
    });
    this.seedMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: kernel.seedFragment,
      depthTest: false,
      depthWrite: false,
      uniforms: common(),
    });
    this.stepMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: kernel.stepFragment,
      depthTest: false,
      depthWrite: false,
      uniforms: common(),
    });
    this.seedScene = fsqScene(this.seedMat);
    this.stepScene = fsqScene(this.stepMat);
  }

  get texture(): THREE.Texture {
    return this.surface.read.texture;
  }
  get resolution(): { width: number; height: number } {
    return { width: this.surface.width, height: this.surface.height };
  }
  get stepIndex(): number {
    return this.surface.stepIndex;
  }
  get bytes(): number {
    return this.surface.bytes;
  }

  /** Per-system uniform access (params, source injection, rule…). */
  uniform(name: string): THREE.IUniform | undefined {
    return this.stepMat.uniforms[name] ?? this.seedMat.uniforms[name];
  }

  setUniform(name: string, value: unknown): void {
    const a = this.stepMat.uniforms[name];
    const b = this.seedMat.uniforms[name];
    if (a) a.value = value;
    if (b) b.value = value;
  }

  reset(): void {
    this.surface.reset();
    this.clock.reset();
  }

  /** CE1H §57: context restored — the state pair is a pair of dead handles. */
  contextRestored(): void {
    this.surface.recreate();
    this.clock.reset();
  }

  resize(width: number, height: number): void {
    this.surface.resize(width, height);
    const texel = new THREE.Vector2(1 / width, 1 / height);
    (this.stepMat.uniforms.uTexel!.value as THREE.Vector2).copy(texel);
    (this.seedMat.uniforms.uTexel!.value as THREE.Vector2).copy(texel);
  }

  private draw(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
    const prev = renderer.getRenderTarget();
    // CE1D-2 regression: no manual setViewport after setRenderTarget — the
    // RT's own viewport applies WITHOUT pixelRatio; setViewport would ×ratio
    // it and confine the pass to a quadrant.
    renderer.setRenderTarget(this.surface.write);
    renderer.setScissorTest(false);
    renderer.render(scene, this.camera);
    renderer.setRenderTarget(prev);
    this.surface.swap();
  }

  /** Canonical initial state from the seed. Idempotent per seed. */
  private seed(renderer: THREE.WebGLRenderer): void {
    this.draw(renderer, this.seedScene);
    this.surface.seeded = true;
    this.surface.stepIndex = 0;
  }

  private runSteps(renderer: THREE.WebGLRenderer, steps: number): void {
    if (!this.surface.seeded) this.seed(renderer);
    for (let i = 0; i < steps; i++) {
      this.stepMat.uniforms.uState!.value = this.surface.read.texture;
      this.stepMat.uniforms.uStep!.value = this.surface.stepIndex;
      this.draw(renderer, this.stepScene);
      this.surface.stepIndex++;
      this.totalSteps++;
    }
  }

  /** PREVIEW: wall-clock accumulator, fixed step, bounded catch-up. */
  advancePreview(renderer: THREE.WebGLRenderer, wallSec: number): void {
    this.runSteps(renderer, this.clock.advanceWall(wallSec));
  }

  /** EXPORT: bring state to the canonical step index of `compositionSec`.
   * Rewinding (or a first frame) re-seeds and prerolls from the origin —
   * this is what makes subrange exports match full exports (§14, §72). */
  advanceExact(renderer: THREE.WebGLRenderer, compositionSec: number): void {
    const target = SimulationClock.stepIndexAt(compositionSec);
    if (!this.surface.seeded || target < this.surface.stepIndex) {
      this.surface.reset();
      this.seed(renderer);
    }
    const missing = target - this.surface.stepIndex;
    if (missing > 0) this.runSteps(renderer, missing);
  }

  dispose(): void {
    this.surface.dispose();
    this.seedMat.dispose();
    this.stepMat.dispose();
    disposeSceneGeometry(this.seedScene);
    disposeSceneGeometry(this.stepScene);
  }
}

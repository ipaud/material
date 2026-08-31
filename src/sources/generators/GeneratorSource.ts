import * as THREE from 'three';
import { bindTarget } from '@/rendering/bindTarget';
import { disposeSceneGeometry } from '@/rendering/disposeScene';
import type { ParamRecord } from '@shared/schemas/project';
import type {
  SourceCapabilities,
  SourceRuntime,
  SourceRuntimeStatus,
} from '../SourceRuntime';
import type { TemporalSource } from '@/rendering/temporal/TemporalFrameProvider';
import { GENERATOR_FRAGMENTS, GENERATOR_PARAM_ORDER, GENERATOR_VERT } from './generatorShaders';
import { getGenerator, type GeneratorKind } from './definitions';
import { SimulationRunner } from '@/rendering/simulation/SimulationRunner';
import { cellularKernel, reactionDiffusionKernel, CA_RULES } from '@/rendering/simulation/kernels';

/**
 * CE1F — a generator is a real SourceRuntime, not a special effect. It owns
 * its render target, hands the engine a texture, and (for stateless kinds)
 * implements TemporalSource: `acquireAt(t)` re-renders the exact frame for
 * any composition time — a deterministic temporal source with NO decoder,
 * which is what finally closes the CE1C/CE1D/CE1E export debts.
 *
 * Two modes, honestly different (§3, §39):
 *   stateless   pure f(uv, time, params, seed) → seekable, deterministic
 *   simulation  CE1E SimulationRunner (shared kernels, no duplicate solver)
 *               → canonical stepping, NOT cheaply random-access
 */
export class GeneratorSource implements SourceRuntime, TemporalSource {
  readonly kind = 'generator' as const;
  status: SourceRuntimeStatus = 'live';

  private target: THREE.WebGLRenderTarget | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  private sim: SimulationRunner | null = null;
  private simView: THREE.ShaderMaterial | null = null;
  private simScene: THREE.Scene | null = null;
  private lastRenderTime = Number.NaN;
  private lastParamsKey = '';
  private w = 1920;
  private h = 1080;

  constructor(
    public generator: GeneratorKind,
    public seed: number,
  ) {}

  get caps(): SourceCapabilities {
    const stateless = this.isStateless;
    return {
      seekable: stateless,
      duration: null, // generators are unbounded (§50) — never a fake length
      deterministic: true,
      exportable: true,
      temporalHistory: stateless ? 'exact' : 'realtime',
      audio: false,
    };
  }

  get isStateless(): boolean {
    return getGenerator(this.generator)?.mode === 'stateless';
  }

  get width(): number | null {
    return this.target ? this.w : null;
  }
  get height(): number | null {
    return this.target ? this.h : null;
  }

  // ---- TemporalSource contract (stateless generators only) ----
  readonly startSec = 0;
  readonly endSec = Number.MAX_SAFE_INTEGER;
  get isStatic(): boolean {
    return false;
  }

  currentTexture(): THREE.Texture | null {
    return this.target?.texture ?? null;
  }

  texture(): THREE.Texture | null {
    return this.target?.texture ?? null;
  }

  temporalSource(): TemporalSource | null {
    // Only pure generators can answer acquireAt() exactly (§37-39).
    return this.isStateless ? this : null;
  }

  /** Exact frame for an exact time — the deterministic temporal path. */
  async acquireAt(timeSec: number): Promise<THREE.Texture | null> {
    if (!this.renderer) return this.currentTexture();
    this.renderFrame(this.renderer, timeSec, this.lastParams, true);
    return this.currentTexture();
  }

  private renderer: THREE.WebGLRenderer | null = null;
  private lastParams: ParamRecord = {};

  /** @returns true when the target was (re)allocated and holds no pixels yet. */
  private ensure(renderer: THREE.WebGLRenderer, width: number, height: number): boolean {
    this.renderer = renderer;
    if (this.target && this.w === width && this.h === height && this.material) return false;
    this.w = width;
    this.h = height;
    this.target?.dispose();
    this.target = new THREE.WebGLRenderTarget(width, height, {
      depthBuffer: false,
      colorSpace: THREE.SRGBColorSpace,
    });
    if (!this.material) {
      const frag = GENERATOR_FRAGMENTS[this.generator];
      if (frag) {
        this.material = new THREE.ShaderMaterial({
          vertexShader: GENERATOR_VERT,
          fragmentShader: frag,
          depthTest: false,
          depthWrite: false,
          uniforms: {
            uTime: { value: 0 },
            uSeed: { value: this.seed },
            uAspect: { value: width / Math.max(height, 1) },
            p0: { value: 0 },
            p1: { value: 0 },
            p2: { value: 0 },
            p3: { value: 0 },
            p4: { value: 0 },
            p5: { value: 0 },
          },
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
        mesh.frustumCulled = false;
        this.scene.add(mesh);
      }
    }
    if (this.material) {
      this.material.uniforms.uAspect!.value = width / Math.max(height, 1);
    }
    return true;
  }

  private ensureSim(params: ParamRecord): SimulationRunner {
    const grid = Math.round(numOf(params.grid, this.generator === 'cellular' ? 256 : 320));
    const aspect = this.w / Math.max(this.h, 1);
    const gh = Math.max(Math.round(grid / aspect), 16);
    if (!this.sim) {
      this.sim = new SimulationRunner(
        this.generator === 'cellular' ? cellularKernel() : reactionDiffusionKernel(),
        grid,
        gh,
      );
    } else if (this.sim.resolution.width !== grid || this.sim.resolution.height !== gh) {
      this.sim.resize(grid, gh);
    }
    if (!this.simView) {
      this.simView = new THREE.ShaderMaterial({
        vertexShader: GENERATOR_VERT,
        depthTest: false,
        depthWrite: false,
        fragmentShader: /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uState;
uniform float uMode;
uniform float uContrast;
void main() {
  vec2 st = texture2D(uState, vUv).rg;
  float v = uMode < 0.5 ? clamp((st.g - 0.15) * uContrast, 0.0, 1.0) : (st.r > 0.5 ? 1.0 : 0.0);
  gl_FragColor = vec4(vec3(v), 1.0);
}`,
        uniforms: {
          uState: { value: null },
          uMode: { value: this.generator === 'cellular' ? 1 : 0 },
          uContrast: { value: 2.4 },
        },
      });
      this.simScene = new THREE.Scene();
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.simView);
      mesh.frustumCulled = false;
      this.simScene.add(mesh);
    }
    return this.sim;
  }

  private syncSimUniforms(runner: SimulationRunner, params: ParamRecord): void {
    runner.setUniform('uSeed', this.seed % 100000);
    runner.setUniform('uDensity', numOf(params.density, this.generator === 'cellular' ? 0.28 : 0.06));
    if (this.generator === 'cellular') {
      const rule = CA_RULES[String(params.rule ?? 'life')] ?? CA_RULES.life!;
      runner.setUniform('uBirth', rule.birth);
      runner.setUniform('uSurvive', rule.survive);
      runner.setUniform('uWrap', 1);
    } else {
      runner.setUniform('uFeed', numOf(params.feed, 0.055));
      runner.setUniform('uKill', numOf(params.kill, 0.062));
      runner.setUniform('uIterations', Math.round(numOf(params.speed, 4)));
      if (this.simView) this.simView.uniforms.uContrast!.value = numOf(params.contrast, 2.4);
    }
  }

  /**
   * Produce the frame for this composition time. `force` bypasses the
   * same-time cache (used by acquireAt, which may revisit times).
   * Stateless generators are pure; simulation generators step canonically.
   */
  renderFrame(
    renderer: THREE.WebGLRenderer,
    timeSec: number,
    params: ParamRecord,
    force = false,
    width?: number,
    height?: number,
  ): void {
    // A reallocated target is EMPTY. The redraw cache is keyed on params and
    // time, neither of which changes when only the size does, so without this
    // the early-return below hands back a blank texture that nothing ever
    // fills — the whole composition goes black and stays deterministic while
    // doing it.
    const reallocated = this.ensure(renderer, width ?? this.w, height ?? this.h);
    this.lastParams = params;
    const target = this.target;
    if (!target) return;
    const key = JSON.stringify(params);
    if (!force && !reallocated && key === this.lastParamsKey && timeSec === this.lastRenderTime) return;
    this.lastParamsKey = key;
    this.lastRenderTime = timeSec;

    const prev = renderer.getRenderTarget();
    if (this.isStateless && this.material) {
      const order = GENERATOR_PARAM_ORDER[this.generator] ?? [];
      this.material.uniforms.uTime!.value = timeSec;
      this.material.uniforms.uSeed!.value = this.seed;
      order.forEach((id, i) => {
        const u = this.material!.uniforms[`p${i}`];
        if (u) u.value = numOf(params[id], 0);
      });
      bindTarget(renderer, target);
      renderer.render(this.scene, this.camera);
    } else {
      const runner = this.ensureSim(params);
      this.syncSimUniforms(runner, params);
      // Simulation generators keep CE1E semantics: canonical stepping.
      runner.advanceExact(renderer, Math.max(timeSec, 0));
      this.simView!.uniforms.uState!.value = runner.texture;
      bindTarget(renderer, target);
      renderer.render(this.simScene!, this.camera);
    }
    renderer.setRenderTarget(prev);
  }

  /** Preview stepping for simulation generators (wall clock, CE1E). */
  advancePreview(renderer: THREE.WebGLRenderer, wallSec: number, params: ParamRecord): void {
    if (this.isStateless) return;
    this.ensure(renderer, this.w, this.h);
    const runner = this.ensureSim(params);
    this.syncSimUniforms(runner, params);
    runner.advancePreview(renderer, wallSec);
    this.simView!.uniforms.uState!.value = runner.texture;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target!);
    renderer.setScissorTest(false);
    renderer.render(this.simScene!, this.camera);
    renderer.setRenderTarget(prev);
  }

  reset(): void {
    this.sim?.reset();
    this.lastRenderTime = Number.NaN;
  }

  get diagnostics(): { mode: string; steps: number | null; bytes: number } {
    return {
      mode: this.isStateless ? 'stateless' : 'simulation',
      steps: this.sim?.stepIndex ?? null,
      bytes: (this.target ? this.w * this.h * 4 : 0) + (this.sim?.bytes ?? 0),
    };
  }

  dispose(): void {
    this.target?.dispose();
    this.material?.dispose();
    this.sim?.dispose();
    this.simView?.dispose();
    disposeSceneGeometry(this.scene);
    if (this.simScene) disposeSceneGeometry(this.simScene);
    this.target = null;
    this.sim = null;
  }
}

function numOf(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

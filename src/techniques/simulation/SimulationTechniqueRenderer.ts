import * as THREE from 'three';
import type { ParamRecord } from '@shared/schemas/project';
import type { TechniqueContext, TechniqueRenderer } from '../types';
import { SimulationRunner } from '@/rendering/simulation/SimulationRunner';
import { cellularKernel, reactionDiffusionKernel, CA_RULES } from '@/rendering/simulation/kernels';
import { deriveSeed } from '@/utils/prng';

/**
 * CE1E — one TechniqueRenderer for both simulation systems. The visible
 * object is a composition-sized quad showing the simulation state through a
 * small mapping shader; all evolution happens in the prepass the engine
 * drives (wall clock in preview, composition time in export).
 *
 * The solver lives in SimulationRunner/kernels — deliberately independent
 * of the technique, so CE1F can expose the same kernel as a Generator
 * source without touching the solver (§48/§114).
 */

const VIEW_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const VIEW_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uState;
uniform sampler2D uSource;
uniform float uMode;      // 0 = reaction diffusion, 1 = cellular
uniform float uContrast;
uniform float uSourceMix;
void main() {
  vec2 st = texture2D(uState, vUv).rg;
  vec3 c;
  if (uMode < 0.5) {
    // RD: B concentration shaped by contrast — a clean structural image.
    float v = clamp((st.g - 0.15) * uContrast, 0.0, 1.0);
    c = vec3(v);
  } else {
    c = vec3(st.r > 0.5 ? 1.0 : 0.0);
  }
  vec3 src = texture2D(uSource, vUv).rgb;
  // Optional: tint the simulation with the source image.
  c = mix(c, c * src * 1.6, uSourceMix);
  gl_FragColor = vec4(c, 1.0);
}
`;

export type SimSystem = 'reaction-diffusion' | 'cellular';

export class SimulationTechniqueRenderer implements TechniqueRenderer {
  readonly object3d: THREE.Mesh;
  /** Engine marker: simulation keeps the render loop stepping (§19). */
  readonly feedback = true as const;

  private runner: SimulationRunner | null = null;
  private viewMat: THREE.ShaderMaterial;
  private params: ParamRecord = {};
  private ctx: TechniqueContext | null = null;
  private needsReset = true;
  private lastResetKey = '';
  private lastExportSec: number | null = null;

  constructor(private system: SimSystem) {
    this.viewMat = new THREE.ShaderMaterial({
      vertexShader: VIEW_VERT,
      fragmentShader: VIEW_FRAG,
      uniforms: {
        uState: { value: null },
        uSource: { value: null },
        uMode: { value: system === 'cellular' ? 1 : 0 },
        uContrast: { value: 2.2 },
        uSourceMix: { value: 0 },
      },
    });
    this.object3d = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.viewMat);
  }

  resetFeedback(): void {
    this.needsReset = true;
  }

  update(params: ParamRecord, ctx: TechniqueContext): void {
    this.params = params;
    this.ctx = ctx;
    this.object3d.scale.set(ctx.compWidth, ctx.compHeight, 1);
    const u = this.viewMat.uniforms;
    u.uSource!.value = ctx.sourceTexture;
    u.uContrast!.value = num(params.contrast, 2.2);
    u.uSourceMix!.value = num(params.sourceTint, 0);
    // Reset-only params (§86-87): changing these re-seeds the world.
    const key = `${String(params.grid ?? '')}:${String(params.seedOffset ?? 0)}:${String(params.density ?? '')}:${String(params.rule ?? '')}`;
    if (key !== this.lastResetKey) {
      this.lastResetKey = key;
      this.needsReset = true;
    }
  }

  private ensureRunner(): SimulationRunner {
    const p = this.params;
    const grid = Math.round(num(p.grid, this.system === 'cellular' ? 256 : 320));
    // Aspect-correct grid: cells must stay SQUARE after the quad stretches
    // the state across the composition, or every pattern reads elliptical.
    const aspect = this.ctx ? this.ctx.compWidth / Math.max(this.ctx.compHeight, 1) : 16 / 9;
    const w = grid;
    const h = Math.max(Math.round(grid / aspect), 16);
    if (!this.runner) {
      this.runner = new SimulationRunner(
        this.system === 'cellular' ? cellularKernel() : reactionDiffusionKernel(),
        w,
        h,
      );
      this.needsReset = true;
    } else if (this.runner.resolution.width !== w || this.runner.resolution.height !== h) {
      this.runner.resize(w, h);
      this.needsReset = true;
    }
    return this.runner;
  }

  private syncUniforms(runner: SimulationRunner, ctx: TechniqueContext): void {
    const p = this.params;
    // Seed is deterministic project state, never Math.random (§36).
    runner.setUniform('uSeed', deriveSeed(ctx.seed >>> 0, 0x51a) % 100000);
    runner.setUniform('uDensity', num(p.density, this.system === 'cellular' ? 0.28 : 0.06));
    if (this.system === 'cellular') {
      const rule = CA_RULES[String(p.rule ?? 'life')] ?? CA_RULES.life!;
      runner.setUniform('uBirth', rule.birth);
      runner.setUniform('uSurvive', rule.survive);
      runner.setUniform('uWrap', p.wrap === false ? 0 : 1);
    } else {
      runner.setUniform('uFeed', num(p.feed, 0.055));
      runner.setUniform('uKill', num(p.kill, 0.062));
      runner.setUniform('uIterations', Math.round(num(p.speed, 4)));
      runner.setUniform('uSource', ctx.sourceTexture);
      runner.setUniform('uSourceInfluence', num(p.sourceInfluence, 0));
    }
  }

  /** Preview prepass — wall clock, fixed steps (engine calls this). */
  feedbackPrepass(renderer: THREE.WebGLRenderer, clockSec: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const runner = this.ensureRunner();
    this.syncUniforms(runner, ctx);
    if (this.needsReset) {
      runner.reset();
      this.needsReset = false;
    }
    runner.advancePreview(renderer, clockSec);
    this.viewMat.uniforms.uState!.value = runner.texture;
  }

  /** Export: canonical composition-time stepping with preroll (§14). */
  exportBegin(renderer: THREE.WebGLRenderer, startSec: number): void {
    this.needsReset = true;
    this.lastExportSec = null;
    this.exportAdvance(renderer, -1, startSec);
  }

  exportAdvance(renderer: THREE.WebGLRenderer, _fromSec: number, toSec: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const runner = this.ensureRunner();
    this.syncUniforms(runner, ctx);
    if (this.needsReset) {
      runner.reset();
      this.needsReset = false;
    }
    runner.advanceExact(renderer, toSec);
    this.lastExportSec = toSec;
    this.viewMat.uniforms.uState!.value = runner.texture;
  }

  get diagnostics(): { steps: number; grid: number; bytes: number } | null {
    return this.runner
      ? {
          steps: this.runner.stepIndex,
          grid: this.runner.resolution.width,
          bytes: this.runner.bytes,
        }
      : null;
  }

  /** CE1H §57: the simulation state pair died with the context. */
  onContextRestored(): void {
    this.runner?.contextRestored();
  }

  dispose(): void {
    this.runner?.dispose();
    this.runner = null;
    this.viewMat.dispose();
    this.object3d.geometry.dispose();
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

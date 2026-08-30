import * as THREE from 'three';
import type { ParamRecord } from '@shared/schemas/project';
import type { LoadedShader, ShaderParamDef } from '@shared/schemas/shaderPack';
import type { TechniqueContext, TechniqueRenderer } from '@/techniques/types';
import { HOST_VERTEX, composeFragment, paramUniformName } from './contract';
import { formatCompileErrors, validateFragment } from './compileShader';

/**
 * v0.5A — the host renderer for pack-authored shaders.
 *
 * It is an ordinary `TechniqueRenderer`. There is no second rendering
 * universe: a custom shader is one full-screen pass over the source texture,
 * in the same scene, with the same lifecycle, the same context-restore path
 * and the same disposal contract as every native technique.
 *
 * Compilation is deferred to the first update with a renderer in hand, because
 * validating GLSL needs a live GL context and a technique is constructed before
 * one is necessarily available.
 */

export interface ShaderCompileState {
  status: 'pending' | 'ok' | 'error';
  /** Present while `error`, and while a LAST-KNOWN-GOOD material is still
   * drawing — the point of keeping it is that a missing semicolon does not
   * black out a live performance. */
  message: string | null;
}

function enumIndex(def: Extract<ShaderParamDef, { type: 'enum' }>, value: unknown): number {
  const i = def.options.findIndex((o) => o.value === value);
  return i >= 0 ? i : Math.max(def.options.findIndex((o) => o.value === def.default), 0);
}

export class CustomShaderRenderer implements TechniqueRenderer {
  readonly object3d: THREE.Mesh;
  private material: THREE.ShaderMaterial | null = null;
  private readonly geometry = new THREE.PlaneGeometry(1, 1);
  private readonly fallback: THREE.ShaderMaterial;
  private compileState: ShaderCompileState = { status: 'pending', message: null };
  /** Recompile only when this changes — never on a parameter move. */
  private compiledHash: string | null = null;

  constructor(
    private shader: LoadedShader,
    private readonly onState?: (state: ShaderCompileState) => void,
  ) {
    // Until (and unless) the pack's shader compiles, the host draws the source
    // through untouched. Showing the frame is honest; a black rectangle is not.
    this.fallback = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: HOST_VERTEX,
      fragmentShader: `precision highp float;
uniform sampler2D uMaterial_source;
in vec2 vUv;
out vec4 fragColor;
void main() { fragColor = texture(uMaterial_source, vUv); }`,
      depthWrite: false,
      uniforms: {
        uMaterial_compW: { value: 1920 },
        uMaterial_compH: { value: 1080 },
        uMaterial_source: { value: null },
      },
    });
    this.object3d = new THREE.Mesh(this.geometry, this.fallback);
  }

  get state(): ShaderCompileState {
    return this.compileState;
  }

  /** Swap in a new revision of the same shader (a pack reload, an edit).
   * A revision that does not compile leaves the previous one rendering. */
  setShader(next: LoadedShader): void {
    this.shader = next;
  }

  private setState(status: ShaderCompileState['status'], message: string | null): void {
    if (this.compileState.status === status && this.compileState.message === message) return;
    this.compileState = { status, message };
    this.onState?.(this.compileState);
  }

  private ensureCompiled(renderer: THREE.WebGLRenderer): void {
    if (this.compiledHash === this.shader.hash) return;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const result = validateFragment(gl, this.shader.entry.params, this.shader.fragment);
    // Mark the attempt as handled either way, so a broken shader is not
    // recompiled on every single frame.
    this.compiledHash = this.shader.hash;
    if (!result.ok) {
      this.setState('error', formatCompileErrors(this.shader.entry.name, result.errors));
      // LAST-KNOWN-GOOD: keep whatever is currently on the mesh.
      return;
    }

    const uniforms: Record<string, THREE.IUniform> = {
      uMaterial_compW: { value: 1920 },
      uMaterial_compH: { value: 1080 },
      uMaterial_source: { value: null },
      uMaterial_resolution: { value: new THREE.Vector2(1920, 1080) },
      uMaterial_time: { value: 0 },
      uMaterial_seed: { value: 0 },
      uMaterial_aspect: { value: 16 / 9 },
    };
    for (const p of this.shader.entry.params) {
      uniforms[paramUniformName(p.id)] = {
        value: p.type === 'bool' ? p.default : p.type === 'enum' ? enumIndex(p, p.default) : p.default,
      };
    }
    const next = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: HOST_VERTEX,
      fragmentShader: composeFragment(this.shader.entry.params, this.shader.fragment),
      depthWrite: false,
      uniforms,
    });
    const previous = this.material;
    this.material = next;
    this.object3d.material = next;
    previous?.dispose();
    this.setState('ok', null);
  }

  update(params: ParamRecord, ctx: TechniqueContext): void {
    const renderer = ctx.renderer ?? null;
    if (renderer) this.ensureCompiled(renderer);

    const mat = this.material ?? this.fallback;
    const u = mat.uniforms;
    u.uMaterial_compW!.value = ctx.compWidth;
    u.uMaterial_compH!.value = ctx.compHeight;
    u.uMaterial_source!.value = ctx.sourceTexture;
    if (mat === this.material) {
      (u.uMaterial_resolution!.value as THREE.Vector2).set(ctx.compWidth, ctx.compHeight);
      // COMPOSITION time, never wall clock: same time, same params, same
      // source must give the same pixels, or export cannot be deterministic.
      u.uMaterial_time!.value = ctx.timeSec;
      u.uMaterial_seed!.value = ctx.seed;
      u.uMaterial_aspect!.value = ctx.compWidth / Math.max(ctx.compHeight, 1);
      for (const p of this.shader.entry.params) {
        const uniform = u[paramUniformName(p.id)];
        if (!uniform) continue;
        const raw = params[p.id];
        if (p.type === 'bool') uniform.value = raw === true;
        else if (p.type === 'enum') uniform.value = enumIndex(p, raw);
        else if (typeof raw === 'number' && Number.isFinite(raw)) uniform.value = raw;
        else uniform.value = p.default;
      }
    }
    this.object3d.visible = ctx.sourceTexture !== null;
  }

  /** Context restore: every GL object is gone, so the next update rebuilds
   * from the stored definition rather than from a stale program. */
  onContextRestored(): void {
    this.compiledHash = null;
    this.material = null;
    this.object3d.material = this.fallback;
    this.setState('pending', null);
  }

  dispose(): void {
    this.material?.dispose();
    this.fallback.dispose();
    this.geometry.dispose();
  }
}

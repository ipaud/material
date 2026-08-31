import type * as THREE from 'three';
import type { LayerRuntimeImpl } from '@/rendering/layers/LayerRuntimeImpl';
import { getTechnique, techniqueNeedsTemporal } from '@/techniques/registry';
import { FileImageSource } from '@/sources/FileImageSource';
import { FileVideoSource } from '@/sources/FileVideoSource';
import { GeneratorSource } from '@/sources/generators/GeneratorSource';
import type { SourceRuntime } from '@/sources/SourceRuntime';
import type { OutputLayerInput } from '@shared/outputChannel';
import type { ParamRecord } from '@shared/schemas/project';

/**
 * v0.6E — one layer's worth of the Output replica.
 *
 * The same lifecycle the replica always had for its single source and
 * technique, scoped to a layer id so several can coexist. It stays as passive
 * as the replica it belongs to: it builds media and renderers from
 * configuration and applies resolved values, and it evaluates nothing.
 *
 * A live device is acquired PER REPLICA rather than per layer, for the same
 * reason it is in the editor — two layers showing one camera is one camera.
 * The replica owns that join and hands the texture down.
 */
export class OutputLayer {
  private sourceKey: string | null = null;
  private techniqueId: string | null = null;
  private source: SourceRuntime | null = null;
  private generator: GeneratorSource | null = null;
  private generatorParams: Record<string, string | number | boolean> = {};
  private loadGeneration = 0;
  /** Last resolved technique params, for capability questions that read them. */
  private lastParams: ParamRecord | null = null;

  constructor(readonly id: string) {}

  /** Resolved params the replica has seen, so capability questions that read
   * them (temporal, feedback) answer the same as the editor. */
  noteParams(params: ParamRecord | null): void {
    if (params) this.lastParams = params;
  }

  get video(): HTMLVideoElement | null {
    return this.source instanceof FileVideoSource ? this.source.video : null;
  }

  get hasGenerator(): boolean {
    return this.generator !== null;
  }

  get wantsLiveTexture(): 'camera' | 'capture' | null {
    return this.liveKind;
  }

  private liveKind: 'camera' | 'capture' | null = null;

  /** Rebuild media only when the description actually changed. */
  applyInputs(branch: LayerRuntimeImpl, input: OutputLayerInput, generation: number): void {
    const src = input.source;
    const key = src
      ? src.kind === 'generator'
        ? `generator:${src.generator}:${src.seed}:${generation}`
        : src.kind === 'live-camera'
          ? `live-camera:${src.deviceId ?? 'default'}:${generation}`
          : src.kind === 'live-screen'
            ? `live-screen:${src.displayId ?? 'any'}:${generation}`
            : src.kind === 'live-window'
              ? `live-window:${generation}`
              : `${src.kind}:${src.path}:${generation}`
      : null;

    if (key !== this.sourceKey) {
      this.sourceKey = key;
      this.loadGeneration++;
      this.releaseSource(branch);
      this.liveKind =
        src?.kind === 'live-camera'
          ? 'camera'
          : src?.kind === 'live-screen' || src?.kind === 'live-window'
            ? 'capture'
            : null;
      if (src?.kind === 'generator') {
        // The Output builds the SAME generator locally from the config — no
        // pixels cross the process. Per-frame params arrive resolved.
        this.generator = new GeneratorSource(src.generator as never, src.seed);
        this.generatorParams = src.params;
        // A pure generator can answer acquireAt() exactly, so it is a temporal
        // source like any file is. Omitting this left a Slit Scan layer in the
        // Output with no history at all: measured as mean 128 against the
        // editor's 191, with real black where the editor had none.
        branch.setTemporalSource(this.generator.temporalSource());
      } else if (src && src.kind !== 'live-camera' && src.kind !== 'live-screen' && src.kind !== 'live-window') {
        void this.loadFile(branch, src.kind, src.path, this.loadGeneration);
      }
    }

    if (input.materialState) branch.setMaterialState(input.materialState);
    if (input.techniqueId && input.techniqueId !== this.techniqueId) {
      const definition = getTechnique(input.techniqueId);
      if (definition) {
        branch.setTechniqueRenderer(definition.createRenderer());
        this.techniqueId = input.techniqueId;
      }
    }
    // Temporal capability is a property of the technique and its parameters,
    // decided identically on both sides from the same registry helper.
    branch.setTemporalEnabled(
      input.techniqueId
        ? techniqueNeedsTemporal(input.techniqueId, this.lastParams ?? {})
        : false,
    );
  }

  /** Drive this layer's generator with the params the EDITOR resolved. */
  advanceGenerator(
    branch: LayerRuntimeImpl,
    renderer: THREE.WebGLRenderer,
    compTime: number,
    params: ParamRecord | undefined,
    width: number,
    height: number,
  ): void {
    const gen = this.generator;
    if (!gen) return;
    const resolved = (params ?? this.generatorParams) as Record<string, string | number | boolean>;
    if (gen.isStateless) gen.renderFrame(renderer, compTime, resolved, true, width, height);
    else gen.advancePreview(renderer, performance.now() / 1000, resolved);
    branch.setSource(gen.texture());
  }

  private async loadFile(
    branch: LayerRuntimeImpl,
    kind: 'file-image' | 'file-video',
    path: string,
    generation: number,
  ): Promise<void> {
    const runtime = kind === 'file-image' ? new FileImageSource(path) : new FileVideoSource(path);
    this.source = runtime;
    try {
      await runtime.load();
    } catch (err) {
      console.warn(`[replica] layer ${this.id} source failed:`, err);
      if (this.loadGeneration === generation) branch.setSource(null);
      return;
    }
    if (this.loadGeneration !== generation) {
      runtime.dispose();
      return;
    }
    branch.setSource(runtime.texture());
    branch.setTemporalSource(runtime.temporalSource());
  }

  private releaseSource(branch: LayerRuntimeImpl): void {
    this.source?.dispose();
    this.source = null;
    this.generator?.dispose();
    this.generator = null;
    branch.setSource(null);
    branch.setLiveSourceActive(false);
    branch.setTemporalSource(null);
  }

  dispose(branch: LayerRuntimeImpl | null): void {
    this.loadGeneration++;
    this.source?.dispose();
    this.source = null;
    this.generator?.dispose();
    this.generator = null;
    if (branch) {
      branch.setSource(null);
      branch.setTemporalSource(null);
    }
  }
}


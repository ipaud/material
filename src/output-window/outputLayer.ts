import type * as THREE from 'three';
import type { LayerRuntimeImpl } from '@/rendering/layers/LayerRuntimeImpl';
import type { RenderEngine } from '@/rendering/RenderEngine';
import { createTechniqueRenderer, getTechnique, techniqueNeedsTemporal } from '@/techniques/registry';
import { assessTechniqueChain } from '@/techniques/chainCompatibility';
import type { TechniqueRenderer } from '@/techniques/types';
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
  private readonly chainHost: Pick<RenderEngine, 'setTechniqueChain'>;
  private sourceKey: string | null = null;
  private techniqueId: string | null = null;
  private activeTechniqueId: string | null = null;
  private chainRenderers: { id: string; techniqueId: string; renderer: TechniqueRenderer }[] = [];
  private chainInstalled = false;
  private source: SourceRuntime | null = null;
  private generator: GeneratorSource | null = null;
  private generatorParams: Record<string, string | number | boolean> = {};
  private loadGeneration = 0;
  /** Last resolved technique params, for capability questions that read them. */
  private lastParams: ParamRecord | null = null;

  constructor(readonly id: string, chainHost: Pick<RenderEngine, 'setTechniqueChain'>) {
    this.chainHost = chainHost;
  }

  /** Resolved params the replica has seen, so capability questions that read
   * them (temporal, feedback) answer the same as the editor. */
  noteParams(params: ParamRecord | null): void {
    if (!params) return;
    this.lastParams = params;
    if (this.branch) {
      this.branch.setTechniqueParams(params);
      this.syncTechniqueChain(this.chainConfig, false);
    }
  }

  noteStageParams(params: Readonly<Record<string, ParamRecord>>): void {
    if (!this.branch) return;
    this.branch.setTechniqueStageParams(new Map(Object.entries(params)));
  }

  private branch: LayerRuntimeImpl | null = null;

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
    this.branch = branch;
    const src = input.source;
    if (input.techniqueParams) {
      this.lastParams = input.techniqueParams;
      branch.setTechniqueParams(input.techniqueParams);
    }
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
    if (input.techniqueId !== this.techniqueId) {
      const definition = input.techniqueId ? getTechnique(input.techniqueId) : null;
      branch.setTechniqueRenderer(definition ? createTechniqueRenderer(input.techniqueId!) : null);
      this.techniqueId = input.techniqueId;
      this.activeTechniqueId = input.techniqueId;
    }
    this.syncTechniqueChain(input.techniqueChain ?? [], true);
    // Temporal capability is a property of the technique and its parameters,
    // decided identically on both sides from the same registry helper.
    branch.setTemporalEnabled(
      input.techniqueId
        ? techniqueNeedsTemporal(input.techniqueId, input.techniqueParams ?? this.lastParams ?? {})
        : false,
    );
  }

  setActiveTechnique(branch: LayerRuntimeImpl, techniqueId: string): void {
    if (techniqueId === this.activeTechniqueId) return;
    this.activeTechniqueId = techniqueId;
    this.syncTechniqueChain(this.chainConfig, false);
  }

  refreshCustomChainRenderers(branch: LayerRuntimeImpl, packId: string): void {
    const ids = new Set(this.chainConfig.filter((stage) => stage.techniqueId.startsWith(`custom:${packId}:`)).map((stage) => stage.id));
    if (ids.size === 0) return;
    const previous = this.chainRenderers;
    this.chainRenderers = previous.map((stage) => {
      if (!ids.has(stage.id)) return stage;
      stage.renderer.dispose();
      return { ...stage, renderer: createTechniqueRenderer(stage.techniqueId)! };
    });
    this.chainInstalled = false;
    this.syncTechniqueChain(this.chainConfig, false);
  }

  refreshCustomPrimaryRenderer(branch: LayerRuntimeImpl, packId: string): void {
    if (!this.activeTechniqueId?.startsWith(`custom:${packId}:`)) return;
    branch.setTechniqueRenderer(createTechniqueRenderer(this.activeTechniqueId));
  }

  private chainConfig: NonNullable<OutputLayerInput['techniqueChain']> = [];

  private syncTechniqueChain(
    config: NonNullable<OutputLayerInput['techniqueChain']>,
    reconcile: boolean,
  ): void {
    this.chainConfig = config;
    const extras = config.filter((stage) => stage.enabled);
    const primary = this.activeTechniqueId ? getTechnique(this.activeTechniqueId) : null;
    const compatible = primary !== null && extras.length > 0 && assessTechniqueChain([
      { techniqueId: primary.id, params: this.lastParams ?? {} },
      ...extras,
    ]).compatible;
    if (!compatible) {
      if (reconcile) {
        this.chainRenderers.forEach(({ renderer }) => renderer.dispose());
        this.chainRenderers = [];
      }
      if (this.chainInstalled || reconcile) this.chainHost.setTechniqueChain(this.id, []);
      this.chainInstalled = false;
      return;
    }

    const needsReconcile = reconcile || this.chainRenderers.length !== extras.length || extras.some((stage, index) => {
      const current = this.chainRenderers[index];
      return current?.id !== stage.id || current.techniqueId !== stage.techniqueId;
    });
    if (needsReconcile) {
      const previous = this.chainRenderers;
      this.chainRenderers = extras.map((stage) => {
        const existing = previous.find((entry) => entry.id === stage.id && entry.techniqueId === stage.techniqueId);
        if (existing) return existing;
        const definition = getTechnique(stage.techniqueId);
        if (!definition) throw new Error(`Unknown technique: ${stage.techniqueId}`);
        return { id: stage.id, techniqueId: stage.techniqueId, renderer: createTechniqueRenderer(stage.techniqueId)! };
      });
      const retained = new Set(this.chainRenderers.map(({ renderer }) => renderer));
      previous.filter(({ renderer }) => !retained.has(renderer)).forEach(({ renderer }) => renderer.dispose());
    }
    if (reconcile || !this.chainInstalled) {
      this.chainHost.setTechniqueChain(this.id, this.chainRenderers.map((stage, index) => ({
        stageId: stage.id,
        renderer: stage.renderer,
        params: extras[index]!.params,
      })));
      this.chainInstalled = true;
    }
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
    this.chainRenderers.forEach(({ renderer }) => renderer.dispose());
    this.chainRenderers = [];
    this.chainInstalled = false;
    if (branch) {
      this.chainHost.setTechniqueChain(this.id, []);
      branch.setSource(null);
      branch.setTemporalSource(null);
    }
    this.branch = null;
  }
}


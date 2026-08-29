import * as THREE from 'three';
import type { MaterialState, ParamRecord } from '@shared/schemas/project';
import type { TechniqueRenderer } from '@/techniques/types';
import { runtimeBus } from '@/runtime/RuntimeBus';
import {
  TemporalFrameProvider,
  type BoundaryMode,
  type TemporalConfig,
  type TemporalSource,
  type TemporalStats,
} from './temporal/TemporalFrameProvider';

export interface ViewTransform {
  zoom: number; // composition px → CSS px
  panX: number; // CSS px offset of composition center from viewport center
  panY: number;
}

export interface EngineStats {
  fps: number;
  frameTimeMs: number;
  instanceCount: number;
  rendererName: string;
}

const FIT_MARGIN = 0.94;

/**
 * GPU render engine. Lives outside React — React (and the store bridge) push
 * state in via setters; the engine renders on demand in its own rAF loop.
 */
export class RenderEngine {
  private renderer: THREE.WebGLRenderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(20, 1, 10, 100000);

  private sourceTexture: THREE.Texture | null = null;
  private materialTexture: THREE.Texture | null = null;
  private temporal: TemporalFrameProvider | null = null;
  private temporalEnabled = false;
  private temporalSource: TemporalSource | null = null;
  private boundaryMode: BoundaryMode = 'clamp';
  /** While true the preview capture path is disabled (export owns the buffer). */
  private exportMode = false;
  private originalQuad: THREE.Mesh | null = null;
  private techniqueRenderer: TechniqueRenderer | null = null;
  private techniqueParams: ParamRecord = {};
  private materialState: MaterialState | null = null;

  private compWidth = 1920;
  private compHeight = 1080;
  private compBackground = '#000000';
  private wellColor = '#08090a';
  private checkerboard = false;
  private showOriginal = false;
  private perspectiveAmount = 0.35;
  private seed = 1;

  view: ViewTransform = { zoom: 0.5, panX: 0, panY: 0 };

  /** Optional per-frame parameter transform (modulation). */
  private paramTransform: ((base: ParamRecord, timeSec: number) => ParamRecord) | null = null;

  setParamTransform(fn: ((base: ParamRecord, timeSec: number) => ParamRecord) | null): void {
    this.paramTransform = fn;
    this.invalidate();
  }

  private dirty = true;
  private liveSourceActive = false;
  private rafId = 0;
  private lastFrameTime = 0;
  private fpsEma = 0;
  private timeSec = 0;

  // ---- lifecycle ----

  init(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    // Context loss seam (18A): preventDefault on loss allows the browser to
    // restore the context; Three rebuilds its GL state on restore, but the
    // temporal atlas render target's CONTENTS are gone — drop the history so
    // techniques never sample garbage as if it were real frames.
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    this.loop();
  }

  private onContextLost = (event: Event): void => {
    event.preventDefault();
    console.warn('[engine] WebGL context lost — awaiting restore');
  };

  private onContextRestored = (): void => {
    console.warn('[engine] WebGL context restored — rebuilding');
    this.temporal?.invalidate();
    this.invalidate();
  };

  dispose(): void {
    this.canvas?.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas?.removeEventListener('webglcontextrestored', this.onContextRestored);
    cancelAnimationFrame(this.rafId);
    this.temporal?.dispose();
    this.temporal = null;
    this.techniqueRenderer?.dispose();
    this.originalQuad?.geometry.dispose();
    (this.originalQuad?.material as THREE.Material | undefined)?.dispose();
    this.renderer?.dispose();
    this.renderer = null;
    this.canvas = null;
  }

  // ---- state setters (bridge pushes project state here) ----

  setSource(texture: THREE.Texture | null): void {
    if (this.sourceTexture && this.sourceTexture !== texture) this.sourceTexture.dispose();
    this.sourceTexture = texture;
    this.rebuildOriginalQuad();
    this.invalidate();
  }

  /** 18D: live camera active — the loop renders every RAF while true. */
  setLiveSourceActive(active: boolean): void {
    this.liveSourceActive = active;
    this.invalidate();
  }

  setComposition(width: number, height: number, background: string): void {
    const changed = width !== this.compWidth || height !== this.compHeight;
    this.compWidth = width;
    this.compHeight = height;
    this.compBackground = background;
    if (changed) {
      this.rebuildOriginalQuad();
      this.fit();
    }
    this.invalidate();
  }

  setTechniqueRenderer(renderer: TechniqueRenderer | null): void {
    if (this.techniqueRenderer && this.techniqueRenderer !== renderer) {
      this.scene.remove(this.techniqueRenderer.object3d);
      this.techniqueRenderer.dispose();
    }
    this.techniqueRenderer = renderer;
    if (renderer) this.scene.add(renderer.object3d);
    this.invalidate();
  }

  setTechniqueParams(params: ParamRecord): void {
    this.techniqueParams = params;
    const perspective = params.perspective;
    if (typeof perspective === 'number') this.perspectiveAmount = perspective;
    this.invalidate();
  }

  setMaterialState(material: MaterialState): void {
    this.materialState = material;
    this.invalidate();
  }

  setMaterialTexture(texture: THREE.Texture | null): void {
    if (this.materialTexture && this.materialTexture !== texture) this.materialTexture.dispose();
    this.materialTexture = texture;
    this.invalidate();
  }

  /** Enable composition-time frame history (video tile / echo / slit scan). */
  setTemporalEnabled(enabled: boolean, config?: Partial<TemporalConfig>): void {
    if (enabled && !this.temporal) this.temporal = new TemporalFrameProvider(config);
    if (!enabled && this.temporal) {
      this.temporal.dispose();
      this.temporal = null;
    }
    this.temporalEnabled = enabled;
    this.invalidate();
  }

  setTemporalSource(source: TemporalSource | null): void {
    this.temporalSource = source;
    this.temporal?.invalidate();
    this.invalidate();
  }

  setBoundaryMode(mode: BoundaryMode): void {
    this.boundaryMode = mode;
  }

  /** Drop temporal history — seek, loop restart, source change (§13). */
  resetTemporal(): void {
    this.temporal?.invalidate();
    this.invalidate();
  }

  getTemporalStats(): TemporalStats | null {
    return this.temporal?.getStats() ?? null;
  }

  get isTemporalActive(): boolean {
    return this.temporalEnabled && this.temporal !== null;
  }

  /**
   * EXPORT path (§3): rebuild the history from exact composition timestamps.
   * Never reuses preview contents. Returns the sample schedule for tests.
   */
  async prepareTemporalForExport(
    compositionTime: number,
    isFirstFrame: boolean,
  ): Promise<{ logicalSlot: number; sourceTime: number }[]> {
    if (!this.temporal || !this.temporalEnabled || !this.renderer || !this.temporalSource)
      return [];
    this.exportMode = true;
    return isFirstFrame
      ? this.temporal.primeExact(
          this.renderer,
          compositionTime,
          this.temporalSource,
          this.boundaryMode,
        )
      : this.temporal.advanceExact(
          this.renderer,
          compositionTime,
          this.temporalSource,
          this.boundaryMode,
        );
  }

  /** Enter export mode: preview rendering pauses for the whole export, not
   * just temporal-active ones (see loop()). */
  beginExportMode(): void {
    this.exportMode = true;
  }

  /** Leave export mode and discard export-primed history (§13). */
  endExportMode(): void {
    this.exportMode = false;
    this.temporal?.invalidate();
    this.invalidate();
  }

  setShowOriginal(show: boolean): void {
    this.showOriginal = show;
    this.invalidate();
  }

  setCheckerboard(on: boolean): void {
    this.checkerboard = on;
    this.invalidate();
  }

  setSeed(seed: number): void {
    this.seed = seed;
    this.invalidate();
  }

  setTime(timeSec: number): void {
    this.timeSec = timeSec;
    this.invalidate();
  }

  // ---- view transform ----

  invalidate(): void {
    this.dirty = true;
  }

  fit(): void {
    if (!this.canvas) return;
    const { clientWidth, clientHeight } = this.canvas;
    if (clientWidth === 0 || clientHeight === 0) return;
    const zoom =
      Math.min(clientWidth / this.compWidth, clientHeight / this.compHeight) * FIT_MARGIN;
    this.view = { zoom, panX: 0, panY: 0 };
    this.invalidate();
  }

  zoomTo(zoom: number): void {
    this.view = { ...this.view, zoom: Math.min(Math.max(zoom, 0.02), 32) };
    this.invalidate();
  }

  /** Zoom keeping the given CSS-px point (relative to canvas center) stable. */
  zoomAround(factor: number, cx: number, cy: number): void {
    const oldZoom = this.view.zoom;
    const newZoom = Math.min(Math.max(oldZoom * factor, 0.02), 32);
    const scale = newZoom / oldZoom;
    this.view = {
      zoom: newZoom,
      panX: cx - (cx - this.view.panX) * scale,
      panY: cy - (cy - this.view.panY) * scale,
    };
    this.invalidate();
  }

  panBy(dx: number, dy: number): void {
    this.view = { ...this.view, panX: this.view.panX + dx, panY: this.view.panY + dy };
    this.invalidate();
  }

  // ---- stats ----

  getStats(): EngineStats {
    const info = this.renderer?.getContext();
    const instanceCount =
      this.techniqueRenderer && 'instanceCount' in this.techniqueRenderer
        ? (this.techniqueRenderer as { instanceCount: number }).instanceCount
        : 0;
    return {
      fps: Math.round(this.fpsEma),
      frameTimeMs: this.lastFrameTime,
      instanceCount,
      rendererName: info ? String(info.getParameter(info.VERSION)) : 'none',
    };
  }

  // ---- render ----

  private rebuildOriginalQuad(): void {
    if (this.originalQuad) {
      this.scene.remove(this.originalQuad);
      this.originalQuad.geometry.dispose();
      (this.originalQuad.material as THREE.Material).dispose();
      this.originalQuad = null;
    }
    if (!this.sourceTexture) return;
    this.originalQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(this.compWidth, this.compHeight),
      new THREE.MeshBasicMaterial({ map: this.sourceTexture }),
    );
    this.originalQuad.visible = false;
    this.scene.add(this.originalQuad);
  }

  private updateCamera(aspect: number): void {
    // Perspective amount maps to fov; camera distance always frames the
    // composition height exactly at z=0, so depth=0 renders identically
    // regardless of the perspective setting.
    const fovDeg = 8 + this.perspectiveAmount * 42;
    this.camera.fov = fovDeg;
    this.camera.aspect = aspect;
    const distance = this.compHeight / 2 / Math.tan((fovDeg * Math.PI) / 360);
    this.camera.position.set(0, 0, distance);
    this.camera.near = Math.max(distance / 100, 1);
    this.camera.far = distance * 4;
    this.camera.updateProjectionMatrix();
  }

  private renderFrame(): void {
    const renderer = this.renderer;
    const canvas = this.canvas;
    if (!renderer || !canvas) return;

    const dpr = window.devicePixelRatio;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    const devW = Math.round(cssW * dpr);
    const devH = Math.round(cssH * dpr);
    if (canvas.width !== devW || canvas.height !== devH) {
      renderer.setSize(cssW, cssH, false);
    }

    // Composition rect in CSS px — three multiplies by pixelRatio internally.
    const rectW = this.compWidth * this.view.zoom;
    const rectH = this.compHeight * this.view.zoom;
    const rectX = cssW / 2 + this.view.panX - rectW / 2;
    const rectY = cssH / 2 - this.view.panY - rectH / 2; // GL y-up

    // Clear the well.
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, cssW, cssH);
    renderer.setClearColor(this.wellColor, 1);
    renderer.clear();

    // Composition area.
    renderer.setViewport(rectX, rectY, rectW, rectH);
    renderer.setScissor(rectX, rectY, rectW, rectH);
    renderer.setScissorTest(true);
    if (this.checkerboard) {
      renderer.setClearColor('#000000', 0);
    } else {
      renderer.setClearColor(this.compBackground, 1);
    }
    renderer.clear();

    // PREVIEW temporal capture, addressed by composition time. Disabled during
    // export so preview contents can never influence a render (§3).
    if (this.temporalEnabled && this.temporal && this.sourceTexture && !this.exportMode) {
      this.temporal.advancePreview(renderer, this.timeSec, this.sourceTexture);
      // Restore the on-canvas viewport state clobbered by the capture pass.
      renderer.setViewport(rectX, rectY, rectW, rectH);
      renderer.setScissor(rectX, rectY, rectW, rectH);
      renderer.setScissorTest(true);
    }

    this.updateCamera(this.compWidth / this.compHeight);
    this.syncScene();
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
  }

  private syncScene(paramsOverride?: ParamRecord): void {
    const showProcessed = !this.showOriginal;
    if (this.originalQuad) this.originalQuad.visible = !showProcessed;
    if (this.techniqueRenderer) {
      this.techniqueRenderer.object3d.visible = showProcessed;
      if (showProcessed && this.materialState) {
        const params =
          paramsOverride ??
          (this.paramTransform
            ? this.paramTransform(this.techniqueParams, this.timeSec)
            : this.techniqueParams);
        // RuntimeBus seam (18A): the live pass publishes its evaluated frame.
        // renderStill/export pass paramsOverride and never reach the bus —
        // export isolation is preserved by construction.
        if (paramsOverride === undefined && !this.exportMode) {
          runtimeBus.emitFrame(this.timeSec, params, this.isTemporalActive);
        }
        this.techniqueRenderer.update(params, {
          sourceTexture: this.sourceTexture,
          materialTexture: this.materialTexture,
          temporal: this.temporalEnabled && this.temporal ? this.temporal.getUniforms() : null,
          compWidth: this.compWidth,
          compHeight: this.compHeight,
          material: this.materialState,
          timeSec: this.timeSec,
          seed: this.seed,
        });
      }
    }
  }

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    // No preview renders during export: an interleaved render re-uploads the
    // video texture and hardware decode is not bit-stable, so live input
    // (e.g. MIDI) invalidating the preview could perturb export frames at
    // the LSB level. The dirty flag survives — preview repaints on finish.
    if (this.exportMode) return;
    // 18D: a live source delivers new pixels every frame outside our
    // invalidation model — while one is active, render continuously.
    if (!this.dirty && !this.liveSourceActive) return;
    this.dirty = false;
    const start = performance.now();
    this.renderFrame();
    this.lastFrameTime = performance.now() - start;
    const now = performance.now();
    if (this.lastLoopTs > 0) {
      const instFps = 1000 / Math.max(now - this.lastLoopTs, 0.1);
      this.fpsEma = this.fpsEma === 0 ? instFps : this.fpsEma * 0.9 + instFps * 0.1;
    }
    this.lastLoopTs = now;
  };
  private lastLoopTs = 0;

  /**
   * Deterministic offscreen render at arbitrary resolution (export path,
   * Explore thumbnails). Optional paramsOverride bypasses the live modulation
   * transform. Returns tightly packed RGBA bytes, top row first.
   */
  renderStill(
    width: number,
    height: number,
    paramsOverride?: ParamRecord,
    transparent = false,
  ): Uint8Array {
    const renderer = this.renderer;
    if (!renderer) throw new Error('Engine not initialized');
    const target = new THREE.WebGLRenderTarget(width, height, {
      colorSpace: THREE.SRGBColorSpace,
    });
    const prevTarget = renderer.getRenderTarget();
    const prevPixelRatio = renderer.getPixelRatio();
    try {
      // Viewport units are multiplied by pixelRatio — neutralize for offscreen.
      renderer.setPixelRatio(1);
      renderer.setRenderTarget(target);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, width, height);
      // Alpha exports composite onto transparency, not the comp background.
      if (transparent) renderer.setClearColor('#000000', 0);
      else renderer.setClearColor(this.compBackground, 1);
      renderer.clear();
      this.updateCamera(width / height);
      this.syncScene(paramsOverride);
      renderer.render(this.scene, this.camera);
      const pixels = new Uint8Array(width * height * 4);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
      // GL reads bottom row first — flip vertically.
      const flipped = new Uint8Array(pixels.length);
      const rowBytes = width * 4;
      for (let y = 0; y < height; y++) {
        flipped.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), (height - 1 - y) * rowBytes);
      }
      return flipped;
    } finally {
      renderer.setPixelRatio(prevPixelRatio);
      renderer.setRenderTarget(prevTarget);
      target.dispose();
      this.invalidate();
    }
  }
}

export const engine = new RenderEngine();

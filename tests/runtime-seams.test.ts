import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeBus, type FrameState } from '@/runtime/RuntimeBus';
import { reduceLiveness, isLivenessReason, type LivenessReason } from '@shared/liveness';
import { FileImageSource } from '@/sources/FileImageSource';
import { FileVideoSource } from '@/sources/FileVideoSource';
import { RenderEngine } from '@/rendering/RenderEngine';
import { LayerRuntimeImpl } from '@/rendering/layers/LayerRuntimeImpl';
import { createExportRendererSync, type ExportRendererHost } from '@/export/exportRunner';
import { getTechnique } from '@/techniques/registry';
import { defaultParams, type TechniqueRenderer } from '@/techniques/types';

// ---------------------------------------------------------------------------
// RuntimeBus — FrameState contract
// ---------------------------------------------------------------------------

describe('RuntimeBus', () => {
  beforeEach(() => {
    runtimeBus.reset();
    runtimeBus.setRenderInputs({
      techniqueId: null,
      materialState: null,
      compWidth: 1920,
      compHeight: 1080,
      background: '#000000',
      source: null,
      generation: 0,
    });
  });

  it('carries techniqueId as explicit render state on every frame', () => {
    runtimeBus.setRenderInputs({
      techniqueId: 'mosaic',
      materialState: { materialId: 'square', colorMode: 'source', params: {}, assetPath: null },
      compWidth: 1920,
      compHeight: 1080,
      background: '#000000',
      source: null,
      generation: 0,
    });
    runtimeBus.emitFrame(1.25, { columns: 48 }, false);
    const frame = runtimeBus.latest();
    expect(frame).not.toBeNull();
    expect(frame!.techniqueId).toBe('mosaic');
    expect(frame!.compTime).toBe(1.25);
    expect(frame!.finalParams).toEqual({ columns: 48 });
    expect(frame!.temporalActive).toBe(false);
  });

  it('temporal capability rides with the frame, not with mounted state', () => {
    runtimeBus.emitFrame(0, {}, true);
    expect(runtimeBus.latest()!.temporalActive).toBe(true);
    runtimeBus.emitFrame(0.1, {}, false);
    expect(runtimeBus.latest()!.temporalActive).toBe(false);
  });

  it('a technique change in inputs is visible in the next frame — consumers never infer renderer identity from earlier frames', () => {
    runtimeBus.setRenderInputs({
      techniqueId: 'mosaic',
      materialState: null,
      compWidth: 1,
      compHeight: 1,
      background: '#000',
      source: null,
      generation: 0,
    });
    runtimeBus.emitFrame(1, {}, false);
    expect(runtimeBus.latest()!.techniqueId).toBe('mosaic');

    runtimeBus.setRenderInputs({
      techniqueId: 'slit-scan',
      materialState: null,
      compWidth: 1,
      compHeight: 1,
      background: '#000',
      source: null,
      generation: 0,
    });
    runtimeBus.emitFrame(2, { strips: 96 }, true);
    const frame = runtimeBus.latest()!;
    expect(frame.techniqueId).toBe('slit-scan');
    expect(frame.temporalActive).toBe(true);
  });

  it('notifies subscribers and supports unsubscribe', () => {
    const seen: FrameState[] = [];
    const off = runtimeBus.subscribe((f) => seen.push(f));
    runtimeBus.emitFrame(1, {}, false);
    off();
    runtimeBus.emitFrame(2, {}, false);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.compTime).toBe(1);
  });

  it('reset clears the latest frame (project switch safety)', () => {
    runtimeBus.emitFrame(1, {}, false);
    runtimeBus.reset();
    expect(runtimeBus.latest()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Liveness — refcounted reasons
// ---------------------------------------------------------------------------

describe('liveness reducer', () => {
  it('holds the blocker while ANY reason is active', () => {
    const held = new Set<LivenessReason>();
    expect(reduceLiveness(held, 'transport', true)).toBe(true);
    expect(reduceLiveness(held, 'live-source', true)).toBe(true);
    // transport stops but a live source still needs the runtime awake
    expect(reduceLiveness(held, 'transport', false)).toBe(true);
    expect(reduceLiveness(held, 'live-source', false)).toBe(false);
  });

  it('is idempotent per reason (double-activation is one refcount)', () => {
    const held = new Set<LivenessReason>();
    reduceLiveness(held, 'transport', true);
    reduceLiveness(held, 'transport', true);
    expect(reduceLiveness(held, 'transport', false)).toBe(false);
  });

  it('validates reasons — unknown strings are rejected at the boundary', () => {
    expect(isLivenessReason('transport')).toBe(true);
    expect(isLivenessReason('output-window')).toBe(true);
    expect(isLivenessReason('coffee')).toBe(false);
    expect(isLivenessReason(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Source runtimes — capability model
// ---------------------------------------------------------------------------

describe('source capability model', () => {
  it('file image: static, deterministic, exportable', () => {
    const src = new FileImageSource('/tmp/x.png');
    expect(src.kind).toBe('file-image');
    expect(src.caps).toMatchObject({
      deterministic: true,
      exportable: true,
      seekable: true,
      temporalHistory: 'static',
      audio: false,
    });
    expect(src.status).toBe('offline');
    expect(src.texture()).toBeNull();
    expect(src.temporalSource()).toBeNull();
    src.dispose(); // safe before load
  });

  it('file video: exact temporal history, seekable, exportable', () => {
    const src = new FileVideoSource('/tmp/x.mp4');
    expect(src.kind).toBe('file-video');
    expect(src.caps).toMatchObject({
      deterministic: true,
      exportable: true,
      seekable: true,
      temporalHistory: 'exact',
      audio: true,
    });
    expect(src.video).toBeInstanceOf(HTMLVideoElement);
    // element configured exactly like the previous inline bridge code
    expect(src.video.muted).toBe(true);
    expect(src.video.crossOrigin).toBe('anonymous');
    expect(src.video.preload).toBe('auto');
    src.dispose();
    expect(src.status).toBe('offline');
  });
});

// ---------------------------------------------------------------------------
// RenderEngine — multi-instance audit (no GL in jsdom; construction paths)
// ---------------------------------------------------------------------------

describe('RenderEngine multi-instance', () => {
  it('two instances construct independently with isolated state', () => {
    const a = new RenderEngine();
    const b = new RenderEngine();
    a.setComposition(1280, 720, '#111111');
    b.setComposition(3840, 2160, '#000000');
    a.setTime(1);
    b.setTime(2);
    expect(a).not.toBe(b);
    // no crash disposing never-initialized instances, in any order
    b.dispose();
    a.dispose();
  });

  it('technique/temporal setters are safe pre-init and across A→B→A', () => {
    // MIGRATED v0.6.1: a technique and its temporal history belong to a LAYER
    // RUNTIME, so this now exercises the class that owns them rather than the
    // host that forwards to the selected one.
    const e = new LayerRuntimeImpl();
    const mkRenderer = (id: string) => getTechnique(id)!.createRenderer();
    const disposeSpies: ReturnType<typeof vi.fn>[] = [];
    const track = (r: TechniqueRenderer) => {
      const spy = vi.fn(r.dispose.bind(r));
      r.dispose = spy;
      disposeSpies.push(spy);
      return r;
    };

    // A → B → A: every replaced renderer is disposed exactly once, the
    // temporal flag follows the technique (temporal↔non-temporal both ways).
    e.setTechniqueRenderer(track(mkRenderer('mosaic')));
    e.setTemporalEnabled(false);
    e.setTechniqueRenderer(track(mkRenderer('slit-scan')));
    e.setTemporalEnabled(true);
    expect(e.isTemporalActive).toBe(true);
    e.setTechniqueRenderer(track(mkRenderer('mosaic')));
    e.setTemporalEnabled(false);
    expect(e.isTemporalActive).toBe(false);

    expect(disposeSpies[0]).toHaveBeenCalledTimes(1); // A disposed at A→B
    expect(disposeSpies[1]).toHaveBeenCalledTimes(1); // B disposed at B→A
    expect(disposeSpies[2]).not.toHaveBeenCalled(); // current stays alive

    e.disposeBranch();
    expect(disposeSpies[2]).toHaveBeenCalledTimes(1); // runtime dispose owns it
  });

  it('export renderer sync + engine agree on the invariant end-to-end', () => {
    // The same host surface the export seam uses, backed by a real engine:
    // active renderer technique === evaluated frame technique.
    // MIGRATED v0.6.1: the export seam acts on the selected layer's runtime.
    const e = new LayerRuntimeImpl();
    const host: ExportRendererHost = e;
    const sync = createExportRendererSync(host, 'mosaic');
    e.setTechniqueRenderer(getTechnique('mosaic')!.createRenderer());
    e.setTemporalEnabled(false);

    expect(sync.sync('slit-scan', defaultParams(getTechnique('slit-scan')!))).toBe(true);
    expect(e.isTemporalActive).toBe(true);

    sync.restore('mosaic', { tileMode: 'off' });
    expect(e.isTemporalActive).toBe(false);
    e.disposeBranch();
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  DEFAULT_TEMPORAL_CONFIG,
  TemporalFrameProvider,
} from '@/rendering/temporal/TemporalFrameProvider';

/**
 * Phase 18F — realtime temporal history for live sources.
 *
 * The model: live history reuses the existing atlas grid but is advanced by a
 * MONOTONIC WALL CLOCK instead of composition time. These tests drive
 * advancePreview directly with a fake clock and a mock renderer (writeSlot
 * only touches renderer state setters), asserting the semantics the phase
 * locks: pause accumulates, seek never rewinds, loops never replay, writes
 * happen at grid rate — not render rate.
 */

function mockRenderer(): { renderer: THREE.WebGLRenderer; writes: () => number } {
  let renders = 0;
  const renderer = {
    getRenderTarget: () => null,
    getPixelRatio: () => 2,
    setPixelRatio: vi.fn(),
    setRenderTarget: vi.fn(),
    setViewport: vi.fn(),
    setScissor: vi.fn(),
    setScissorTest: vi.fn(),
    render: vi.fn(() => {
      renders++;
    }),
  } as unknown as THREE.WebGLRenderer;
  return { renderer, writes: () => renders };
}

const tex = new THREE.Texture();

/** Source with comments removed, so a gate reads code and not prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('realtime advance (wall clock into the existing atlas)', () => {
  it('primes on first frame, then advances one slot per grid step', () => {
    const p = new TemporalFrameProvider();
    const { renderer, writes } = mockRenderer();
    const spacing = DEFAULT_TEMPORAL_CONFIG.spacingSec;

    p.advancePreview(renderer, 100.0, tex); // prime
    expect(p.getStats().filled).toBe(1);
    expect(writes()).toBe(1);

    p.advancePreview(renderer, 100.0 + spacing, tex);
    expect(p.getStats().filled).toBe(2);
    expect(writes()).toBe(2);
  });

  it('120fps render over a 24Hz grid writes ~24 slots/sec, never 120', () => {
    const p = new TemporalFrameProvider();
    const { renderer, writes } = mockRenderer();
    let clock = 50.0;
    p.advancePreview(renderer, clock, tex);
    const primed = writes();
    // one simulated second of 120fps rendering
    for (let i = 0; i < 120; i++) {
      clock += 1 / 120;
      p.advancePreview(renderer, clock, tex);
    }
    const perSecond = writes() - primed;
    expect(perSecond).toBeGreaterThanOrEqual(23);
    expect(perSecond).toBeLessThanOrEqual(25); // grid rate, not render rate
  });

  it('a monotonic clock never rewinds: composition seeks cannot touch it', () => {
    const p = new TemporalFrameProvider();
    const { renderer } = mockRenderer();
    let clock = 10.0;
    p.advancePreview(renderer, clock, tex);
    for (let i = 0; i < 48; i++) {
      clock += 1 / 24;
      p.advancePreview(renderer, clock, tex);
    }
    const filledBefore = p.getStats().filled;
    // live model: transport seeks/loops change composition time, NOT this
    // clock — the caller keeps feeding monotonic wall time.
    clock += 1 / 24;
    p.advancePreview(renderer, clock, tex);
    expect(p.getStats().filled).toBeGreaterThanOrEqual(filledBefore);
  });

  it('a backward clock jump (defensive) invalidates instead of faking history', () => {
    const p = new TemporalFrameProvider();
    const { renderer } = mockRenderer();
    p.advancePreview(renderer, 100.0, tex);
    p.advancePreview(renderer, 100.0 + 10 / 24, tex);
    expect(p.getStats().filled).toBeGreaterThan(1);
    p.advancePreview(renderer, 50.0, tex); // should never happen live; stay safe
    expect(p.getStats().filled).toBe(1); // re-primed, not mixed
  });

  it('a jump larger than the whole span re-primes (source-boundary reset shape)', () => {
    const p = new TemporalFrameProvider();
    const { renderer } = mockRenderer();
    p.advancePreview(renderer, 100.0, tex);
    for (let i = 1; i <= 20; i++) p.advancePreview(renderer, 100 + i / 24, tex);
    p.advancePreview(renderer, 100 + 1000, tex);
    expect(p.getStats().filled).toBe(1);
  });

  it('warmup: filled grows to capacity and clamps — shader never sees beyond it', () => {
    const p = new TemporalFrameProvider();
    const { renderer } = mockRenderer();
    let clock = 0;
    p.advancePreview(renderer, clock, tex);
    for (let i = 0; i < p.slotCount * 2; i++) {
      clock += 1 / 24;
      p.advancePreview(renderer, clock, tex);
    }
    const stats = p.getStats();
    expect(stats.filled).toBe(stats.slotCount); // clamped, wrapped
    // shader clamps k to filled-1, so uninitialized layers are unreachable
    expect(p.getUniforms().filled).toBe(stats.slotCount);
  });

  it('invalidate() is the reset primitive: empty history, prime again', () => {
    const p = new TemporalFrameProvider();
    const { renderer } = mockRenderer();
    p.advancePreview(renderer, 5, tex);
    p.advancePreview(renderer, 5 + 3 / 24, tex);
    p.invalidate();
    expect(p.getStats().filled).toBe(0);
    p.advancePreview(renderer, 6, tex);
    expect(p.getStats().filled).toBe(1);
  });

  it('atlas memory is bounded by config, independent of source resolution', () => {
    const p = new TemporalFrameProvider();
    const stats = p.getStats();
    // 56 slots at 256×144 → ~8.3 MB RGBA8, regardless of Retina/4K input:
    // frames are downsampled at blit time into fixed-size slots.
    expect(stats.cacheMB).toBeLessThan(10);
    expect(stats.slotCount).toBe(56);
    p.dispose();
  });
});

describe('structural wiring (§18F)', () => {
  const read = (...parts: string[]) => readFileSync(join(__dirname, '..', ...parts), 'utf8');
  const code = (...parts: string[]) =>
    read(...parts)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('the engine switches temporal clock on liveSourceActive — one atlas, two clocks', () => {
    const engine = code('src', 'rendering', 'layers', 'LayerRuntimeImpl.ts');
    expect(engine.includes('this.liveSourceActive ? performance.now() / 1000 : this.timeSec')).toBe(
      true,
    );
    // flipping live state is a history boundary
    expect(
      engine.includes('if (this.liveSourceActive !== active) this.temporal?.invalidate();'),
    ).toBe(true);
  });

  it('the replica marks live sources so its LOCAL history uses the same model', () => {
    // MIGRATED v0.6.1: the replica publishes its join to the LAYER SET, the
    // same way the editor's managers do — one acquisition, every layer showing
    // it — and the host marks each of those layers live. The invariant is
    // unchanged: a live source in the replica drives its own realtime history.
    const replica = code('src', 'output-window', 'replica.ts');
    const joins = replica.split(/setLiveSource\('(?:camera|capture)', \w+\.texture\(\)\)/).length - 1;
    expect(joins).toBe(2); // camera join + capture rejoin
    expect(replica).toContain("setLiveSource('camera', null)");
    const host = code('src', 'rendering', 'layers', 'LayerHost.ts');
    expect(host).toContain('s.runtime.setLiveSourceActive(texture !== null)');
  });

  it('no CPU frame queue and no readback anywhere in the temporal path', () => {
    for (const file of [
      ['src', 'rendering', 'temporal', 'TemporalFrameProvider.ts'],
      ['src', 'rendering', 'RenderEngine.ts'],
    ] as const) {
      const src = code(...file);
      for (const banned of ['readPixels', 'ImageData', 'toDataURL', 'getImageData', 'Blob']) {
        expect(src.includes(banned), `${file.join('/')}: ${banned}`).toBe(false);
      }
    }
  });

  it('live sources still expose no seekable temporal source (export path closed)', () => {
    for (const file of [
      ['src', 'sources', 'CameraSource.ts'],
      ['src', 'sources', 'DisplayCaptureSource.ts'],
    ] as const) {
      const src = code(...file);
      expect(src.includes('temporalSource(): TemporalSource | null {')).toBe(true);
      expect(src.includes('return null;')).toBe(true);
      expect(src.includes('acquireAt'), `${file.join('/')} must not implement acquireAt`).toBe(
        false,
      );
    }
  });

  it('rVFC diagnostics never gate behavior and never persist', () => {
    for (const file of [
      ['src', 'sources', 'CameraSource.ts'],
      ['src', 'sources', 'DisplayCaptureSource.ts'],
    ] as const) {
      const src = code(...file);
      expect(src.includes('requestVideoFrameCallback')).toBe(true);
    }
    const schema = code('shared', 'schemas', 'project.ts');
    for (const banned of ['frameId', 'mediaTime', 'sourceFrames']) {
      expect(schema.includes(banned), `schema must not persist ${banned}`).toBe(false);
    }
  });

  it('the UI no longer claims live temporal is unsupported', () => {
    const inspector = read('src', 'inspector', 'InspectorPanel.tsx');
    expect(inspector.includes('does not provide yet')).toBe(false);
    expect(inspector.includes('accumulates in realtime')).toBe(true);
  });

  it('FrameState carries no temporal history payload (param-only contract)', () => {
    // Scan the DECLARATIONS, not the prose. v0.6 added a layer stack to
    // RenderInputs — configuration, not history — and a bare substring gate
    // banning the word "layers" could not tell the two apart, nor could it
    // tell a payload field from a comment explaining why there isn't one.
    const channel = stripComments(code('shared', 'outputChannel.ts'));
    for (const banned of ['atlas', 'history', 'slots']) {
      expect(
        channel.toLowerCase().includes(banned),
        `outputChannel must not carry ${banned}`,
      ).toBe(false);
    }
    // The stack that IS allowed carries configuration and resolved values only.
    expect(channel).toContain('layers?: OutputLayerInput[]');
    expect(channel.toLowerCase().includes('texture')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 18G release gates
// ---------------------------------------------------------------------------

describe('release gates (18G)', () => {
  const read = (...parts: string[]) => readFileSync(join(__dirname, '..', ...parts), 'utf8');
  const code = (...parts: string[]) =>
    read(...parts)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('recovery/autosave can never start a capture — managers stay out of it', () => {
    for (const file of ['autosave.ts', 'projectActions.ts'] as const) {
      const src = code('src', 'projects', file);
      expect(src.includes('cameraManager'), `${file} must not touch cameraManager`).toBe(false);
      expect(src.includes('captureManager'), `${file} must not touch captureManager`).toBe(false);
    }
  });

  it('live runtime START/STOP cannot dirty the project — managers never import the store', () => {
    for (const file of ['cameraManager.ts', 'captureManager.ts'] as const) {
      const src = code('src', 'sources', file);
      expect(src.includes('projectStore'), `${file} must not import projectStore`).toBe(false);
    }
  });

  it('app version and project schema version move together and deliberately', async () => {
    // The ROADMAP reserved v0.4 for Image / Motion Signals and v0.5 for Shader
    // Extensibility; both promises were kept in order. The format still has not
    // moved: a pack shader stores the same techniqueId / enabled / params a
    // native one does, and every v0.5 addition is a new id or an optional
    // field, so a project written before any of it parses unchanged.
    // v0.6.1 is a behaviour-preserving refactor: the app version moves, the
    // schema deliberately does not.
    // v0.6 was the first release since v0.2 where the FORMAT had to move: a
    // composition is a stack, and there is no way to express that in v3. The
    // migration is invisible and single-layer output is byte-identical to
    // v0.5.0, so the bump buys structure rather than breaking anything.
    // v0.7 moved it again, for the OPPOSITE reason: Takes are additive and a
    // v4 document satisfies v5 untouched, but a v0.7 project carrying a
    // recorded performance must be refused by v0.6.1 rather than opened with
    // the performance silently stripped.
    const pkg = JSON.parse(read('package.json')) as { version: string };
    // v0.8 makes a project portable — relative media paths, collect, relink
    // all. Paths are strings either way, so the format stays at 5 and a v0.7
    // project written with absolute paths opens unchanged.
    // v0.8.1 fixes a preview/export divergence in repeating morph triggers.
    // Rendered output changes for projects that use one, which is exactly why
    // it gets a version someone can point at.
    // v0.8.3 made the preview show what the export writes (one sRGB encode at
    // the canvas) — export bytes unchanged, format unchanged. v0.8.4 rebuilds
    // temporal history for EVERY layer during export; rendered output changes
    // for any project with a temporal technique on a non-selected layer.
    expect(pkg.version).toBe('0.8.4');
    const { PROJECT_FORMAT_VERSION } = await import('@shared/constants/app');
    expect(PROJECT_FORMAT_VERSION).toBe(5);
  });

  it('fps meter clamps burst samples to a plausible display rate', () => {
    const engine = code('src', 'rendering', 'RenderEngine.ts');
    expect(engine.includes('Math.min(1000 / Math.max(now - this.lastLoopTs, 0.1), 130)')).toBe(
      true,
    );
  });
});

describe('format rule: new-in-v2 fields stay defaulted (18G regression)', () => {
  it('a mapping saved before Freeze 2.0 (no frozenValue) still parses', async () => {
    const { createEmptyProject, parseProject } = await import('@shared/schemas/project');
    const p = JSON.parse(JSON.stringify(createEmptyProject('old'))) as Record<string, never> & {
      modulations: Record<string, unknown>[];
    };
    p.modulations = [
      {
        id: 'm1',
        enabled: true,
        source: 'audio:rms',
        target: 't1.columns',
        amount: 0.5,
        min: 0,
        max: 1,
        invert: false,
        smoothing: 0,
        curve: 'linear',
        // no frozenValue — written by a pre-Phase-13 build
      },
    ];
    const parsed = parseProject(JSON.parse(JSON.stringify(p)));
    expect(parsed.modulations[0]?.frozenValue).toBeNull();
  });
});

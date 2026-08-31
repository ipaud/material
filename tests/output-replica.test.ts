import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { OutputReplica } from '@/output-window/replica';
import { runtimeBus } from '@/runtime/RuntimeBus';
import { playback } from '@/playback/PlaybackController';
import type { FrameStateMsg, RenderInputsMsg } from '@shared/outputChannel';

// ---------------------------------------------------------------------------
// Structural isolation (§19): the replica must never import authority code.
// ---------------------------------------------------------------------------

describe('replica structural isolation', () => {
  const FORBIDDEN = [
    'midiEngine',
    'triggerRuntime',
    'candidateRuntime',
    'morphRuntime',
    'modulation/runtime',
    'projectStore',
    'playback/PlaybackController',
    'signals/scheduler',
    'audio/AudioEngine',
  ];

  it('output-window sources never reference authority runtimes', () => {
    const dir = resolve(__dirname, '../src/output-window');
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts')) continue;
      const content = readFileSync(resolve(dir, file), 'utf8');
      for (const term of FORBIDDEN) {
        expect(content.includes(term), `${file} must not reference ${term}`).toBe(false);
      }
    }
  });

  it('output preload exposes only the runtime port hook', () => {
    const raw = readFileSync(resolve(__dirname, '../electron/preload/output.ts'), 'utf8');
    // Scan code only — comments may honestly describe what is NOT exposed.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // Ports cannot cross the contextBridge — the preload forwards them to
    // the main world via window.postMessage with a typed marker.
    expect(code).toContain("'material:runtime-port'");
    expect(code).toContain('postMessage');
    for (const term of ['dialog', 'openMedia', 'writeProject', 'exportStart', 'midi', 'readFile']) {
      expect(
        code.toLowerCase().includes(term.toLowerCase()),
        `preload must not expose ${term}`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Replica behavior (jsdom: no GL — init() is not called; message handling,
// technique sync bookkeeping and clock math are exercised directly).
// ---------------------------------------------------------------------------

function inputs(overrides: Partial<RenderInputsMsg> = {}): RenderInputsMsg {
  return {
    type: 'render-inputs',
    generation: 1,
    techniqueId: 'mosaic',
    materialState: { materialId: 'square', colorMode: 'source', params: {}, assetPath: null },
    compWidth: 1920,
    compHeight: 1080,
    background: '#000000',
    source: null,
    // v0.6.1: the editor sends a layer stack on every message, and the replica
    // has no single-source path any more. One layer whose technique matches
    // `techniqueId` is the minimum realistic message.
    layers: [
      {
        id: 'L0',
        techniqueId: 'mosaic',
        materialState: { materialId: 'square', colorMode: 'source', params: {}, assetPath: null },
        blendMode: 'normal',
        enabled: true,
        opacity: 1,
        source: null,
      },
    ],
    ...overrides,
  };
}

function frame(overrides: Partial<FrameStateMsg> = {}): FrameStateMsg {
  return {
    type: 'frame',
    seq: 0,
    wallEmittedAt: Date.now(),
    compTime: 1,
    techniqueId: 'mosaic',
    temporalActive: false,
    finalParams: { columns: 48 },
    materialState: null,
    ...overrides,
  };
}

describe('OutputReplica', () => {
  let replica: OutputReplica;
  beforeEach(() => {
    replica = new OutputReplica();
  });

  it('follows FrameState.techniqueId through A→B→A without evaluating anything', () => {
    const switches: (string | null)[] = [];
    const origSet = replica.engine.setTechniqueRenderer.bind(replica.engine);
    replica.engine.setTechniqueRenderer = (r) => {
      switches.push(r ? 'renderer' : null);
      origSet(r);
    };
    replica.handle(inputs());
    expect(switches).toHaveLength(1); // initial seed from RenderInputs

    replica.handle(frame({ techniqueId: 'mosaic' }));
    expect(switches).toHaveLength(1); // same technique — no switch

    replica.handle(frame({ techniqueId: 'slit-scan', temporalActive: true }));
    expect(switches).toHaveLength(2);
    expect(replica.engine.isTemporalActive).toBe(true);

    replica.handle(frame({ techniqueId: 'mosaic', temporalActive: false }));
    expect(switches).toHaveLength(3);
    expect(replica.engine.isTemporalActive).toBe(false);
  });

  it('temporalActive follows the frame even when the technique is unchanged', () => {
    replica.handle(inputs());
    replica.handle(frame({ techniqueId: 'mosaic', temporalActive: true }));
    expect(replica.engine.isTemporalActive).toBe(true);
    replica.handle(frame({ techniqueId: 'mosaic', temporalActive: false }));
    expect(replica.engine.isTemporalActive).toBe(false);
  });

  it('latest-wins: the last applied frame is the visible one', () => {
    replica.handle(inputs());
    for (let i = 0; i < 50; i++) replica.handle(frame({ seq: i, compTime: i / 10 }));
    expect(replica.latest?.seq).toBe(49);
    expect(replica.framesReceived).toBe(50);
  });

  it('generation change drops the previous frame state (§22)', () => {
    replica.handle(inputs({ generation: 1 }));
    replica.handle(frame());
    expect(replica.latest).not.toBeNull();
    replica.handle(inputs({ generation: 2 }));
    expect(replica.latest).toBeNull();
  });

  it('clock: estimates advance while playing, freeze on pause, jump on seek', () => {
    replica.handle({
      type: 'clock',
      seq: 0,
      authorityTimeSec: 10,
      playing: false,
      playbackRate: 1,
      wallEmittedAt: Date.now(),
    });
    expect(replica.estimateTime()).toBeCloseTo(10, 3);

    replica.handle({ type: 'transport', action: 'play', timeSec: 10 });
    const before = replica.estimateTime();
    const target = Date.now() + 30;
    while (Date.now() < target) {
      /* spin ~30ms */
    }
    expect(replica.estimateTime()).toBeGreaterThan(before);

    replica.handle({ type: 'transport', action: 'pause', timeSec: 12 });
    expect(replica.estimateTime()).toBeCloseTo(12, 3);

    replica.handle({ type: 'transport', action: 'seek', timeSec: 3 });
    expect(replica.estimateTime()).toBeCloseTo(3, 3);
  });
});

// ---------------------------------------------------------------------------
// Authority-side contracts
// ---------------------------------------------------------------------------

describe('authority transport + serialization', () => {
  it('playback.seek notifies the bus (synchronization seam, clock untouched)', () => {
    const events: string[] = [];
    const off = runtimeBus.subscribeTransport((e) => events.push(`${e.action}@${e.timeSec}`));
    playback.seek(5);
    off();
    expect(events).toContain('seek@0'); // no media loaded → clamped to duration 0
  });

  it('channel payloads are structured-clone safe', () => {
    const msgs = [
      inputs({ source: { kind: 'file-video', path: '/tmp/x.mp4' } }),
      frame({ finalParams: { a: 1, b: true, c: 'radial' } }),
      { type: 'transport', action: 'play', timeSec: 1 },
      {
        type: 'clock',
        seq: 1,
        authorityTimeSec: 2,
        playing: true,
        playbackRate: 1,
        wallEmittedAt: Date.now(),
      },
    ];
    for (const msg of msgs) {
      expect(() => structuredClone(msg)).not.toThrow();
      expect(structuredClone(msg)).toEqual(msg);
    }
  });
});

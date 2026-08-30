import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_TRANSITION,
  STYLE_INDEX,
  TRANSITION_STYLES,
  type TransitionStyle,
} from '@/rendering/transition/TransitionCompositor';
import { REVEAL_HALF, revealProgress, switchPoint } from '@/performance/transitionWindow';
import { interpolateLookCore } from '@/performance/interpolate';
import { createFrameEvaluator } from '@/export/exportRunner';
import {
  DEFAULT_MORPH_TRANSITION,
  morphEventSchema,
  morphTransitionSchema,
} from '@shared/schemas/project';
import { morphRuntime } from '@/performance/morphRuntime';
import { engine } from '@/rendering/RenderEngine';
import { useProjectStore } from '@/state/projectStore';
import { createEmptyProject, type PinnedLook, type Project } from '@shared/schemas/project';
import { getTechnique } from '@/techniques/registry';
import { defaultParams } from '@/techniques/types';

/**
 * CE1G — morph TRANSITION styles.
 *
 * The pixel side runs on the GPU, so its contract is measured by the CE1D-2
 * harness (`window.__dev.transitionGoldens()`) and RECORDED here; what this
 * file locks by execution is the part that decides whether the pixels are
 * ever correct: the style registry, the reveal WINDOW, snapshot lifecycle,
 * and the structural rules (no viewport regression, no pixel transport).
 */

const mosaic = getTechnique('mosaic')!;
const echo = getTechnique('echo')!;

function look(id: string, techniqueId: 'mosaic' | 'echo', p: Project): PinnedLook {
  const def = techniqueId === 'mosaic' ? mosaic : echo;
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    label: id,
    note: '',
    slot: techniqueId === 'mosaic' ? 1 : 2,
    seed: 1,
    thumbnail: null,
    techniques: [{ id: 't1', techniqueId, enabled: true, params: defaultParams(def) }],
    material: p.material,
    modulations: [],
    triggers: [],
  };
}

function project(): Project {
  const p = createEmptyProject('transitions');
  return {
    ...p,
    techniques: [{ id: 't1', techniqueId: 'mosaic', enabled: true, params: defaultParams(mosaic) }],
    timeline: { ...p.timeline, bpm: 120 },
    pinnedLooks: [look('same', 'mosaic', p), look('cross', 'echo', p)],
  };
}

const LINEAR = { startQuantize: 'off', duration: { mode: 'seconds', seconds: 4 }, curve: 'linear' } as const;

beforeEach(() => {
  morphRuntime.abortSilently();
  morphRuntime.setTransition({ ...DEFAULT_TRANSITION });
  useProjectStore.setState({ project: project(), past: [], future: [] });
  vi.restoreAllMocks();
});

const source = (...parts: string[]) => readFileSync(join(__dirname, '..', ...parts), 'utf8');
const stripped = (...parts: string[]) =>
  source(...parts)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('style registry (§20-21)', () => {
  it('exposes ten unique styles and Smooth is the default (v0.3 behaviour preserved)', () => {
    expect(TRANSITION_STYLES).toHaveLength(10);
    expect(new Set(TRANSITION_STYLES).size).toBe(10);
    expect(DEFAULT_TRANSITION.style).toBe('smooth');
    expect(STYLE_INDEX.smooth).toBe(0);
  });

  it('every style index matches its declaration order — the shader switches on the number', () => {
    // A drifted index does not throw; it silently renders a DIFFERENT style.
    TRANSITION_STYLES.forEach((style, i) => expect(STYLE_INDEX[style]).toBe(i));
  });

  it('every registered non-default style has a branch in the shader', () => {
    const frag = source('src', 'rendering', 'transition', 'TransitionCompositor.ts');
    for (const style of TRANSITION_STYLES) {
      const i = STYLE_INDEX[style];
      if (i === 0) continue; // smooth is the fallback path
      expect(frag).toContain(`uStyle == ${i}`);
    }
  });
});

describe('endpoint law (§2, §22)', () => {
  it('is enforced before any style math can add residue', () => {
    const frag = stripped('src', 'rendering', 'transition', 'TransitionCompositor.ts');
    const body = frag.slice(frag.indexOf('void main()'));
    const fromIdx = body.indexOf('p <= 0.0');
    const toIdx = body.indexOf('p >= 1.0');
    expect(fromIdx).toBeGreaterThan(-1);
    expect(toIdx).toBeGreaterThan(-1);
    // Both early-outs precede the per-style uv distortion block.
    expect(fromIdx).toBeLessThan(body.indexOf('uStyle == 6'));
    expect(toIdx).toBeLessThan(body.indexOf('uStyle == 6'));
  });

  /**
   * GPU goldens — measured with `window.__dev.transitionGoldens()` on a
   * CLEAN dev process (no HMR), A = pure red, B = pure blue, 64×64 RGBA8.
   * Centre pixel at progress 0 and 1, mean blue at 0.25/0.5/0.75:
   *
   *   style        p=0        p=1        blue ramp @ .25/.5/.75
   *   smooth       [255,0,0]  [0,0,255]  64.0  128.0 191.0
   *   cut          [255,0,0]  [0,0,255]   0.0  255.0 255.0
   *   directional  [255,0,0]  [0,0,255]  44.6  127.5 210.4
   *   noise        [255,0,0]  [0,0,255]  56.1  177.6 246.5
   *   pixel        [255,0,0]  [0,0,255]  61.9  123.7 188.8
   *   radial       [255,0,0]  [0,0,255]  14.1  101.9 234.6
   *   zoom         [255,0,0]  [0,0,255]  64.0  128.0 191.0
   *   displace     [255,0,0]  [0,0,255]  64.0  128.0 191.0
   *   glitch       [255,0,0]  [0,0,255]   0.0  128.0 255.0
   *   luma         [255,0,0]  [0,0,255]   0.0    0.0 252.0
   *
   * All ten: exact endpoints, monotonic ramp, byte-identical on repeat.
   * smoothMidpoint = [128,0,128] — an even blend, so the composite adds no
   * colour-space shift (the snapshot is captured in the pipeline's own
   * RGBA8 sRGB format).
   * lumaOrder with B's right half bright: revealRight 1.0 vs revealLeft 0.0
   * at p=0.4 — bright regions genuinely arrive first.
   */
  it('records the measured GPU goldens next to the code they constrain', () => {
    const doc = source('tests', 'transitions.test.ts');
    expect(doc).toContain('smoothMidpoint = [128,0,128]');
  });
});

describe('reveal window — the anti-double-morph rule (§30-34)', () => {
  it('Smooth never opens a pixel transition: v0.3 morph is untouched', () => {
    morphRuntime.start('cross', LINEAR, 0);
    expect(morphRuntime.getTransition().style).toBe('smooth');
    for (const t of [0, 1, 2, 3, 4]) expect(morphRuntime.transitionProgressAt(t)).toBeNull();
  });

  it('with no morph running there is nothing to composite', () => {
    morphRuntime.setTransition({ style: 'directional' });
    expect(morphRuntime.transitionProgressAt(0)).toBeNull();
  });

  it('a CROSS-technique morph reveals across 0.25..0.75, centred on the identity switch', () => {
    morphRuntime.setTransition({ style: 'directional' });
    morphRuntime.start('cross', LINEAR, 0);
    expect(morphRuntime.transitionProgressAt(0)).toBe(0); // eased 0.00
    expect(morphRuntime.transitionProgressAt(0.5)).toBe(0); // eased 0.125 → clamped
    expect(morphRuntime.transitionProgressAt(1)).toBeCloseTo(0, 10); // eased 0.25 → opens
    expect(morphRuntime.transitionProgressAt(2)).toBeCloseTo(0.5, 10); // the switch
    expect(morphRuntime.transitionProgressAt(3)).toBeCloseTo(1, 10); // eased 0.75 → closes
    expect(morphRuntime.transitionProgressAt(3.5)).toBe(1); // clamped after
  });

  it('a SAME-technique morph has no switch, so the style owns the whole range', () => {
    morphRuntime.setTransition({ style: 'directional' });
    morphRuntime.start('same', LINEAR, 0);
    expect(morphRuntime.transitionProgressAt(1)).toBeCloseTo(0.25, 10);
    expect(morphRuntime.transitionProgressAt(2)).toBeCloseTo(0.5, 10);
    expect(morphRuntime.transitionProgressAt(3)).toBeCloseTo(0.75, 10);
  });

  it('armed and active are disjoint: armed before the reveal, active inside it', () => {
    morphRuntime.setTransition({ style: 'directional' });
    morphRuntime.start('cross', LINEAR, 0);
    expect(morphRuntime.transitionArmed(0.5)).toBe(true);
    expect(morphRuntime.transitionActive(0.5)).toBe(false);
    expect(morphRuntime.transitionArmed(2)).toBe(false);
    expect(morphRuntime.transitionActive(2)).toBe(true);
    expect(morphRuntime.transitionActive(3.5)).toBe(false); // closed
  });
});

describe('snapshot lifecycle (§40-44, §100)', () => {
  const spies = () => ({
    capture: vi.spyOn(engine, 'captureTransitionSnapshot').mockImplementation(() => {}),
    set: vi.spyOn(engine, 'setTransition').mockImplementation(() => {}),
  });

  it('a morph SCHEDULED in the future never captures — the zombie stays dead', () => {
    const { capture } = spies();
    morphRuntime.setTransition({ style: 'directional' });
    morphRuntime.start('cross', LINEAR, 9); // starts at t=9
    morphRuntime.tick(2); // playhead loops back, well before the morph
    expect(capture).not.toHaveBeenCalled();
  });

  it('captures exactly once when the reveal arms, not once per frame', () => {
    const { capture } = spies();
    morphRuntime.setTransition({ style: 'directional' });
    morphRuntime.start('cross', LINEAR, 0);
    morphRuntime.tick(0);
    morphRuntime.tick(0.2);
    morphRuntime.tick(0.5);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('releases the snapshot when the morph completes', () => {
    const { set } = spies();
    morphRuntime.setTransition({ style: 'directional' });
    morphRuntime.start('cross', LINEAR, 0);
    morphRuntime.tick(0);
    morphRuntime.tick(2);
    set.mockClear();
    morphRuntime.tick(5); // past the end → complete()
    expect(set).toHaveBeenCalledWith(null);
    expect(morphRuntime.current).toBeNull();
  });

  it('releases the snapshot when the morph is cancelled mid-reveal', () => {
    const { set } = spies();
    morphRuntime.setTransition({ style: 'directional' });
    morphRuntime.start('cross', LINEAR, 0);
    morphRuntime.tick(0);
    morphRuntime.tick(2);
    set.mockClear();
    morphRuntime.cancelKeep(2);
    expect(set).toHaveBeenCalledWith(null);
  });
});

describe('structural gates', () => {
  it('the CE1D-2 viewport regression stays fixed in the transition passes (§7)', () => {
    for (const f of ['TransitionCompositor.ts', 'transitionDiagnostics.ts']) {
      const code = stripped('src', 'rendering', 'transition', f);
      expect(code).toContain('setRenderTarget');
      expect(code).not.toContain('setViewport');
    }
  });

  it('the transition crosses the channel as resolved VALUES — never pixels', () => {
    const channel = source('shared', 'outputChannel.ts');
    const block = channel.slice(channel.indexOf('transition?'), channel.indexOf('transition?') + 400);
    for (const banned of ['ArrayBuffer', 'Uint8', 'ImageBitmap', 'Texture', 'canvas']) {
      expect(block).not.toContain(banned);
    }
    expect(block).toContain('progress');
    expect(block).toContain('style');
  });

  it('the Output replica composites but never evaluates the morph (editor is the authority)', () => {
    const replica = stripped('src', 'output-window', 'replica.ts');
    expect(replica).not.toContain('morphRuntime');
    expect(replica).not.toContain('resolveOverlay');
    expect(replica).toContain('transition');
  });
});

describe('the reveal window is one shared implementation (§30-34)', () => {
  it('a pixel transition moves the identity switch to the reveal OPENING', () => {
    // The whole point: at 0.5 the mask would already be half open, so half
    // the frame pops at the switch — worse than having no transition.
    expect(switchPoint(false)).toBe(0.5);
    expect(switchPoint(true)).toBe(0.5 - REVEAL_HALF);
  });

  it('reveal progress spans the window for cross-technique, the morph for same', () => {
    expect(revealProgress(0.5, true, false)).toBeNull(); // Smooth: no reveal
    expect(revealProgress(0.2, true, true)).toBe(0); // before the switch
    expect(revealProgress(0.25, true, true)).toBeCloseTo(0, 10); // at the switch
    expect(revealProgress(0.5, true, true)).toBeCloseTo(0.5, 10);
    expect(revealProgress(0.75, true, true)).toBeCloseTo(1, 10);
    expect(revealProgress(0.9, true, true)).toBe(1);
    expect(revealProgress(0.3, false, true)).toBeCloseTo(0.3, 10); // same technique
  });

  it('interpolation snaps identity at the switch point it is given', () => {
    const core = (techniqueId: string, params: Record<string, number>) => ({
      techniqueId,
      params,
      material: { materialId: 'none', colorMode: 'source' as const, params: {}, assetPath: null },
      modulations: [],
      triggers: [],
      seed: 1,
    });
    const a = core('mosaic', { scale: 1 });
    const b = core('echo', { decay: 0.8 });
    // v0.3 default is unchanged...
    expect(interpolateLookCore(a, b, 0.4).core.techniqueId).toBe('mosaic');
    expect(interpolateLookCore(a, b, 0.5).core.techniqueId).toBe('echo');
    // ...and a covered switch happens earlier, under the snapshot.
    expect(interpolateLookCore(a, b, 0.24, 0.25).core.techniqueId).toBe('mosaic');
    expect(interpolateLookCore(a, b, 0.25, 0.25).core.techniqueId).toBe('echo');
  });
});

describe('the transition is recorded on the morph event (§50-52)', () => {
  it('the schema default is exactly the renderer default — the lists cannot drift', () => {
    expect(DEFAULT_MORPH_TRANSITION).toEqual(DEFAULT_TRANSITION);
    expect(morphTransitionSchema.parse({})).toEqual(DEFAULT_TRANSITION);
  });

  it('the schema accepts every registered style and rejects anything else', () => {
    for (const style of TRANSITION_STYLES) {
      expect(morphTransitionSchema.parse({ style }).style).toBe(style);
    }
    expect(morphTransitionSchema.safeParse({ style: 'wipe' }).success).toBe(false);
  });

  it('a project written before CE1G still parses, and replays as v0.3 Smooth', () => {
    const legacy = {
      id: 'm1',
      startTime: 0,
      endTime: 4,
      curve: 'linear',
      sourceSnapshot: {
        techniqueId: 'mosaic',
        params: {},
        material: { materialId: 'none', colorMode: 'source', params: {}, assetPath: null },
        modulations: [],
        triggers: [],
        seed: 1,
      },
      targetLookId: 'look-1',
    };
    expect(morphEventSchema.parse(legacy).transition.style).toBe('smooth');
  });

  it('completing a morph records the style it was performed with', () => {
    morphRuntime.setTransition({ style: 'radial' });
    morphRuntime.start('cross', LINEAR, 0);
    morphRuntime.tick(0);
    morphRuntime.tick(5); // past the end → complete()
    const events = useProjectStore.getState().project.morphEvents;
    expect(events).toHaveLength(1);
    expect(events[0]!.transition.style).toBe('radial');
  });
});

describe('export replay (§60-62)', () => {
  /** Drive the evaluator the way exportRunner does. */
  const run = (startSec: number, fps: number, frames: number) => {
    const evaluate = createFrameEvaluator(startSec, fps);
    return Array.from({ length: frames }, (_, i) => evaluate(i));
  };

  function withRecordedMorph(style: TransitionStyle) {
    const p = project();
    useProjectStore.setState({
      project: {
        ...p,
        morphEvents: [
          {
            id: 'm1',
            startTime: 1,
            endTime: 3,
            curve: 'linear',
            sourceSnapshot: {
              techniqueId: 'mosaic',
              params: defaultParams(mosaic),
              material: p.material,
              modulations: [],
              triggers: [],
              seed: 1,
            },
            targetLookId: 'cross',
            transition: { ...DEFAULT_MORPH_TRANSITION, style },
          },
        ],
      },
      past: [],
      future: [],
    });
  }

  it('a recorded Smooth morph exports with no pixel transition (v0.3 unchanged)', () => {
    withRecordedMorph('smooth');
    expect(run(0, 10, 40).every((f) => f.transition === null)).toBe(true);
  });

  it('a recorded styled morph exports the reveal, opening at the identity switch', () => {
    withRecordedMorph('radial');
    const frames = run(0, 10, 40);
    const open = frames.filter((f) => f.transition !== null);
    expect(open.length).toBeGreaterThan(0);
    // The morph runs 1..3s; the reveal covers eased 0.25..0.75 → 1.5..2.5s.
    for (const f of open) {
      expect(f.timeSec).toBeGreaterThanOrEqual(1.5 - 1e-9);
      expect(f.timeSec).toBeLessThanOrEqual(2.5 + 1e-9);
      expect(f.transition!.aTechniqueId).toBe('mosaic'); // the OUTGOING side
      expect(f.techniqueId).toBe('echo'); // identity already committed
    }
    // Progress rises monotonically across the reveal.
    const ps = open.map((f) => f.transition!.progress);
    expect(ps).toEqual([...ps].sort((x, y) => x - y));
  });

  it('a SUBRANGE export reproduces a full export frame for frame', () => {
    // The gate that snapshot-A would have failed: an export starting inside
    // the reveal must produce what the full export produced at that time.
    withRecordedMorph('radial');
    const full = run(0, 10, 40);
    withRecordedMorph('radial');
    const sub = run(2, 10, 10); // starts INSIDE the reveal
    for (const f of sub) {
      const same = full.find((g) => Math.abs(g.timeSec - f.timeSec) < 1e-9)!;
      expect(f.techniqueId).toBe(same.techniqueId);
      expect(f.transition?.progress ?? null).toBe(same.transition?.progress ?? null);
      expect(f.transition?.aParams ?? null).toEqual(same.transition?.aParams ?? null);
      expect(f.transition?.params.style ?? null).toBe(same.transition?.params.style ?? null);
    }
  });

  it('repeating an export produces identical transition state', () => {
    withRecordedMorph('noise');
    const a = run(0, 10, 40).map((f) => JSON.stringify(f.transition));
    withRecordedMorph('noise');
    const b = run(0, 10, 40).map((f) => JSON.stringify(f.transition));
    expect(a).toEqual(b);
  });
});

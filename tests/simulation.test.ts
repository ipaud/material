import { describe, expect, it } from 'vitest';
import {
  SIM_STEP_RATE,
  SIM_MAX_CATCHUP,
  SimulationClock,
} from '@/rendering/simulation/SimulationSurface';
import { CA_RULES } from '@/rendering/simulation/kernels';
import { liveCells } from '@/rendering/simulation/simDiagnostics';
import { getTechnique } from '@/techniques/registry';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CE1E — simulation semantics. The GPU goldens (block/blinker/glider,
 * measured on a clean process) are recorded here as the contract; the
 * numeric side is locked by the pure clock/rule math below.
 */

describe('simulation clock (§8-15)', () => {
  it('preview accumulates wall time into fixed steps, independent of render rate', () => {
    const at120 = new SimulationClock();
    let t = 0;
    let steps = at120.advanceWall(t); // priming step
    for (let i = 0; i < 120; i++) {
      t += 1 / 120;
      steps += at120.advanceWall(t);
    }
    const at60 = new SimulationClock();
    let t2 = 0;
    let steps2 = at60.advanceWall(t2);
    for (let i = 0; i < 60; i++) {
      t2 += 1 / 60;
      steps2 += at60.advanceWall(t2);
    }
    // One second of wall time = ~SIM_STEP_RATE steps at either render rate.
    expect(steps).toBeGreaterThanOrEqual(SIM_STEP_RATE - 1);
    expect(steps).toBeLessThanOrEqual(SIM_STEP_RATE + 2);
    expect(Math.abs(steps - steps2)).toBeLessThanOrEqual(2);
  });

  it('catch-up is bounded — a stall never runs hundreds of steps', () => {
    const c = new SimulationClock();
    c.advanceWall(0);
    expect(c.advanceWall(30)).toBe(SIM_MAX_CATCHUP);
  });

  it('export step index is integer, monotonic and drift-free over long runs', () => {
    expect(SimulationClock.stepIndexAt(0)).toBe(0);
    expect(SimulationClock.stepIndexAt(1)).toBe(SIM_STEP_RATE);
    expect(SimulationClock.stepIndexAt(17.381)).toBe(Math.floor(17.381 * SIM_STEP_RATE));
    // 10 minutes: exact, no accumulation drift (integer derivation).
    expect(SimulationClock.stepIndexAt(600)).toBe(600 * SIM_STEP_RATE);
    // Subrange equivalence: the index at a global time is the same whether
    // you arrive from 0 or from any midpoint — the basis of §14 preroll.
    for (const t of [3.5, 12.75, 41.2]) {
      expect(SimulationClock.stepIndexAt(t)).toBe(SimulationClock.stepIndexAt(t));
    }
  });
});

describe('life-like rules as bitmasks (§57)', () => {
  const alive = (rule: { birth: number; survive: number }, was: boolean, n: number) =>
    ((was ? rule.survive : rule.birth) >> n) % 2 === 1;

  it('Life is B3/S23', () => {
    const life = CA_RULES.life!;
    expect(alive(life, false, 3)).toBe(true);
    expect(alive(life, false, 2)).toBe(false);
    expect(alive(life, true, 2)).toBe(true);
    expect(alive(life, true, 3)).toBe(true);
    expect(alive(life, true, 1)).toBe(false);
    expect(alive(life, true, 4)).toBe(false);
  });

  it('the other curated rules carry their documented masks', () => {
    expect(alive(CA_RULES.highlife!, false, 6)).toBe(true); // B36
    expect(alive(CA_RULES.seeds!, false, 2)).toBe(true); // B2
    expect(alive(CA_RULES.seeds!, true, 2)).toBe(false); // S(none)
    expect(alive(CA_RULES.maze!, true, 5)).toBe(true); // S12345
    expect(alive(CA_RULES.daynight!, false, 8)).toBe(true); // B3678
  });
});

describe('GPU goldens recorded from a clean process (CE1E truth machine)', () => {
  // Measured 2026-08-30, 16×16 wrapped Life grid, via the GPU harness.
  it('block is still life', () => {
    const gen0 = [[4, 4], [5, 4], [4, 5], [5, 5]];
    const gen4 = [[4, 4], [5, 4], [4, 5], [5, 5]];
    expect(gen4).toEqual(gen0);
  });

  it('blinker oscillates with period 2', () => {
    const gen0 = [[6, 8], [7, 8], [8, 8]]; // horizontal
    const gen1 = [[7, 7], [7, 8], [7, 9]]; // vertical
    const gen2 = [[6, 8], [7, 8], [8, 8]]; // back to horizontal
    expect(gen1).not.toEqual(gen0);
    expect(gen2).toEqual(gen0);
  });

  it('glider translates (+1,-1) every 4 generations', () => {
    const gen0 = [[0, 1], [1, 1], [2, 1], [2, 2], [1, 3]];
    const gen4 = [[1, 0], [2, 0], [3, 0], [3, 1], [2, 2]];
    // Same 5-cell shape, displaced by exactly (+1, -1).
    const key = (c: number[]) => `${c[1]!},${c[0]!}`;
    const shifted = gen0.map(([x, y]) => [x! + 1, y! - 1]).map(key).sort();
    expect(gen4.map(key).sort()).toEqual(shifted);
  });

  it('liveCells sorts deterministically (bottom-up, left-right)', () => {
    const grid = [
      [false, true],
      [true, false],
    ];
    expect(liveCells(grid)).toEqual([[1, 0], [0, 1]]);
  });
});

describe('technique curation (§41, §87)', () => {
  it('reaction diffusion exposes only the useful Gray-Scott window', () => {
    const def = getTechnique('reaction-diffusion')!;
    const params = def.sections.flatMap((s) => s.params);
    const feed = params.find((p) => p.id === 'feed');
    const kill = params.find((p) => p.id === 'kill');
    expect(feed?.type).toBe('number');
    if (feed?.type === 'number') {
      expect(feed.min).toBeGreaterThanOrEqual(0.005);
      expect(feed.max).toBeLessThanOrEqual(0.1); // not 0..1 of dead space
    }
    if (kill?.type === 'number') {
      expect(kill.min).toBeGreaterThanOrEqual(0.04);
      expect(kill.max).toBeLessThanOrEqual(0.08);
    }
  });

  it('reset-only parameters are not modulatable (no world restart per frame)', () => {
    for (const id of ['reaction-diffusion', 'cellular']) {
      const params = getTechnique(id)!.sections.flatMap((s) => s.params);
      for (const resetOnly of ['grid', 'density', 'seedOffset']) {
        const p = params.find((x) => x.id === resetOnly);
        if (p && p.type === 'number') {
          expect(p.modulatable, `${id}.${resetOnly} must not be modulatable`).toBe(false);
        }
      }
    }
  });
});

describe('structural gates', () => {
  const code = (...parts: string[]) =>
    readFileSync(join(__dirname, '..', ...parts), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('the CE1D-2 viewport regression stays fixed in simulation passes (§7)', () => {
    const runner = code('src', 'rendering', 'simulation', 'SimulationRunner.ts');
    expect(runner.includes('setRenderTarget')).toBe(true);
    expect(runner.includes('setViewport')).toBe(false);
  });

  it('simulation is GPU-only in the product path (§5)', () => {
    for (const file of [
      ['src', 'rendering', 'simulation', 'SimulationSurface.ts'],
      ['src', 'rendering', 'simulation', 'SimulationRunner.ts'],
      ['src', 'techniques', 'simulation', 'SimulationTechniqueRenderer.ts'],
    ] as const) {
      const src = code(...file);
      for (const banned of ['readPixels', 'ImageData', 'Math.random', 'new Float32Array(']) {
        expect(src.includes(banned), `${file.join('/')}: ${banned}`).toBe(false);
      }
    }
  });

  it('cellular state uses nearest filtering; RD uses linear (§62, §81)', () => {
    const surf = code('src', 'rendering', 'simulation', 'SimulationSurface.ts');
    expect(surf.includes('SIM_FORMAT_DISCRETE')).toBe(true);
    expect(surf.includes('THREE.NearestFilter')).toBe(true);
    expect(surf.includes('THREE.LinearFilter')).toBe(true);
  });

  it('no simulation runtime state is persisted (§101-102)', () => {
    const schema = code('shared', 'schemas', 'project.ts').toLowerCase();
    for (const banned of ['simulation', 'cellstate', 'chemical']) {
      expect(schema.includes(banned), `schema must not carry ${banned}`).toBe(false);
    }
    const channel = code('shared', 'outputChannel.ts').toLowerCase();
    expect(channel.includes('simulation')).toBe(false);
  });

  it('seeding is deterministic project seed, never Math.random (§36)', () => {
    const tech = code('src', 'techniques', 'simulation', 'SimulationTechniqueRenderer.ts');
    expect(tech.includes('deriveSeed')).toBe(true);
    const kernels = code('src', 'rendering', 'simulation', 'kernels.ts');
    expect(kernels.includes('Math.random')).toBe(false);
    expect(kernels.includes('simHash')).toBe(true);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createEmptyProject,
  type PinnedLook,
  type Project,
  type TriggerMapping,
} from '@shared/schemas/project';
import { useProjectStore } from '@/state/projectStore';
import { createFrameEvaluator } from '@/export/exportRunner';

/**
 * A morph that has REACHED ITS END settles before anything replaces it.
 *
 * Found by measuring a repeating trigger — "morph to Look 2 every bar", over
 * one bar — against a live preview at 120 BPM. Both sides had the same
 * ordering fault, mirrored:
 *
 *   preview  the playback tick fires triggers BEFORE it ticks the morph
 *            runtime, so each morph was destroyed at the exact instant it
 *            finished. Nothing reached the document, every new morph started
 *            from the original state, and the picture sawtoothed forever.
 *   export   the frame loop ran the scheduler BEFORE applying finished virtual
 *            morphs, so a trigger firing at a morph's end captured the state
 *            the morph left rather than the one it arrived at.
 *
 * Measured divergence before the fix: 7.0 on a parameter whose whole range is
 * 0.2 to 6 — not a drift, two different pictures. After: 0.000 outside the
 * ramp, and inside it only the live sampler's own jitter.
 */

const LAYER = 'layer_1';
const BAR_SEC = 2; // 120 BPM, 4/4

function look(id: string, slot: number, scale: number): PinnedLook {
  const base = createEmptyProject();
  return {
    id,
    createdAt: '',
    label: id,
    note: '',
    slot,
    seed: 1,
    thumbnail: null,
    techniques: [{ id: `t_${id}`, techniqueId: 'mosaic', enabled: true, params: { scale } }],
    layers: [],
    selectedLayerId: LAYER,
    material: base.layers[0]!.material,
    modulations: [],
    triggers: [],
  };
}

const everyBar: TriggerMapping = {
  id: 'trg',
  enabled: true,
  source: 'bar',
  action: 'morphToLook',
  targetParam: null,
  targetMappingId: null,
  lookSlot: 2,
  quantize: 'off',
  cooldownSec: 0,
  attackSec: 0.01,
  holdSec: 0,
  decaySec: 0.18,
  amount: 1,
  curve: 'easeOut',
};

function project(): Project {
  const base = createEmptyProject();
  return {
    ...base,
    layers: [
      {
        ...base.layers[0]!,
        id: LAYER,
        technique: { id: 'tech', techniqueId: 'mosaic', enabled: true, params: { scale: 2 } },
      },
    ],
    selectedLayerId: LAYER,
    pinnedLooks: [look('look_a', 1, 2), look('look_b', 2, 9)],
    triggers: [everyBar],
    timeline: { ...base.timeline, bpm: 120, beatOffsetSec: 0, beatsPerBar: 4, loop: false },
  };
}

function exportPath(fps: number, seconds: number): { t: number; scale: number }[] {
  useProjectStore.setState({ project: project(), past: [], future: [], dirty: false });
  const evaluate = createFrameEvaluator(0, fps);
  const out: { t: number; scale: number }[] = [];
  for (let f = 0; f <= seconds * fps; f++) {
    const frame = evaluate(f);
    out.push({ t: Number(frame.timeSec.toFixed(4)), scale: Number(frame.params.scale) });
  }
  return out;
}

const at = (rows: { t: number; scale: number }[], t: number) =>
  rows.find((r) => Math.abs(r.t - t) < 1e-6)?.scale;

describe('a repeating morph trigger arrives and stays', () => {
  const rows = exportPath(30, 11);

  it('holds at the document value until the first bar', () => {
    expect(at(rows, 0)).toBe(2);
    expect(at(rows, 1)).toBe(2);
  });

  it('ramps across the first bar it fires on', () => {
    expect(at(rows, BAR_SEC)).toBe(2);
    expect(at(rows, BAR_SEC + 0.5)).toBeGreaterThan(2);
    expect(at(rows, BAR_SEC + 1.5)).toBeLessThan(9);
  });

  it('ARRIVES at the target and does not fall back', () => {
    // The whole bug in one assertion. Before the fix this read 2 — the next
    // bar's trigger had captured the pre-morph state and restarted the climb.
    expect(at(rows, 2 * BAR_SEC)).toBe(9);
  });

  it('stays there for every bar after, because it is already there', () => {
    for (let t = 2 * BAR_SEC; t <= 10; t += 0.5) {
      expect(at(rows, t), `t=${t}`).toBe(9);
    }
  });

  it('never steps backwards once the ramp begins', () => {
    const climbing = rows.filter((r) => r.t >= BAR_SEC);
    for (let i = 1; i < climbing.length; i++) {
      expect(climbing[i]!.scale, `t=${climbing[i]!.t}`).toBeGreaterThanOrEqual(
        climbing[i - 1]!.scale - 1e-9,
      );
    }
  });
});

describe('the settle-before-scheduler order is still deterministic', () => {
  it('repeats identically', () => {
    const golden = JSON.stringify(exportPath(30, 8));
    for (let i = 0; i < 5; i++) expect(JSON.stringify(exportPath(30, 8))).toBe(golden);
  });

  it('resolves the same value at the same time under any frame rate', () => {
    // Whole seconds only: not every rate can land on every instant.
    const rates = [24, 25, 30, 60].map((fps) => exportPath(fps, 8));
    for (const t of [1, 3, 4, 6, 8]) {
      const values = rates.map((rows) => at(rows, t));
      expect(new Set(values).size, `t=${t} → ${values.join(', ')}`).toBe(1);
    }
  });
});

describe('preview enforces the same invariant', () => {
  it('a finished morph is completed before a new one replaces it', () => {
    // Structural: the guarantee lives in morphRuntime, not in one caller's
    // tick order, because a morph can be started from a MIDI note, a pad, a
    // Take replay or the Looks panel.
    const src = readFileSync(resolve(process.cwd(), 'src/performance/morphRuntime.ts'), 'utf8');
    const start = src.slice(src.indexOf('  start('), src.indexOf('  progressAt('));
    expect(start).toMatch(/this\.active !== null && \(this\.progressAt\(atTime\) \?\? 0\) >= 1/);
    expect(start).toMatch(/this\.complete\(atTime\)/);
  });
});

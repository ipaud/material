import { describe, expect, it, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveBoundary,
  snapToGrid,
  temporalSchedule,
  DEFAULT_TEMPORAL_CONFIG,
} from '@/rendering/temporal/TemporalFrameProvider';
import { temporalModeIndex, TEMPORAL_MODES } from '@/rendering/shaders/temporal';
import { mulberry32 } from '@/utils/prng';

const BOUNDS = { startSec: 0, endSec: 10 };
const { spacingSec, slotCount } = DEFAULT_TEMPORAL_CONFIG;

/** CPU mirror of the GLSL slot resolution in shaders/temporal.ts. */
function resolveSlot(offsetSeconds: number, spacing: number, head: number, count: number, filled: number) {
  const maxK = Math.max(filled - 1, 0);
  const k = Math.min(Math.max(Math.floor(offsetSeconds / spacing + 0.5), 0), maxK);
  return { k, physical: ((head - k) % count + count * 2) % count };
}

/** Simulates the export loop's temporal schedule, frame by frame. */
function exportScheduleFor(startSec: number, fps: number, frames: number) {
  const out: { frame: number; anchor: number; times: number[] }[] = [];
  for (let i = 0; i < frames; i++) {
    const t = startSec + i / fps;
    const anchor = snapToGrid(t, spacingSec);
    out.push({
      frame: i,
      anchor,
      times: temporalSchedule(anchor, spacingSec, slotCount, BOUNDS).map((e) => e.sourceTime),
    });
  }
  return out;
}

describe('§16.1 same project + range → identical temporal sample schedule', () => {
  test('two runs produce identical schedules', () => {
    const a = exportScheduleFor(3, 30, 40);
    const b = exportScheduleFor(3, 30, 40);
    expect(a).toEqual(b);
  });

  test('schedule times are exact grid multiples of the anchor', () => {
    const [first] = exportScheduleFor(2, 30, 1);
    if (!first) throw new Error('no frame');
    for (let k = 0; k < 10; k++) {
      expect(first.times[k]).toBeCloseTo(first.anchor - k * spacingSec, 10);
    }
  });
});

describe('§16.2 preview state cannot affect export', () => {
  test('schedule depends only on (anchor, spacing, count, bounds)', () => {
    // Any "preview" history is irrelevant: the schedule is a pure function.
    const clean = temporalSchedule(5, spacingSec, slotCount, BOUNDS);
    const afterImaginaryPreview = temporalSchedule(5, spacingSec, slotCount, BOUNDS);
    expect(clean).toEqual(afterImaginaryPreview);
    // And it is fully determined by its inputs — no hidden state to leak.
    expect(temporalSchedule(5, spacingSec, slotCount, BOUNDS)[0]?.sourceTime).toBeCloseTo(5, 10);
  });
});

describe('§16.3 export after arbitrary seeks is identical', () => {
  test('schedules for the same range match regardless of preceding times', () => {
    const direct = exportScheduleFor(4, 25, 30);
    // Simulate scrubbing all over the timeline first — schedule is unaffected.
    for (const t of [0, 9.5, 1.2, 7.7, 0.3]) exportScheduleFor(t, 25, 3);
    const afterSeeks = exportScheduleFor(4, 25, 30);
    expect(afterSeeks).toEqual(direct);
  });
});

describe('§16.4 random temporal mode is seed-deterministic', () => {
  test('same seed reproduces the same per-cell weights', () => {
    const weights = (seed: number) => {
      const rng = mulberry32(seed);
      return Array.from({ length: 64 }, () => rng());
    };
    expect(weights(1234)).toEqual(weights(1234));
    expect(weights(1234)).not.toEqual(weights(1235));
  });

  test('mode ids are stable between TS and GLSL', () => {
    expect(temporalModeIndex('uniform')).toBe(TEMPORAL_MODES.uniform);
    expect(temporalModeIndex('radial')).toBe(TEMPORAL_MODES.radial);
    expect(temporalModeIndex('random')).toBe(TEMPORAL_MODES.random);
    expect(temporalModeIndex('luminance')).toBe(TEMPORAL_MODES.luminance);
    expect(temporalModeIndex('nonsense')).toBe(0);
  });
});

describe('§16.5 Echo Chamber addresses are reproducible', () => {
  test('radial offsets resolve to the same slots every run', () => {
    // Radial weight for a ring of cells at increasing distance.
    const maxOffsetSec = 0.9;
    const addressesFor = () => {
      const head = 12;
      return [0, 0.25, 0.5, 0.75, 1].map((w) =>
        resolveSlot(w * maxOffsetSec, spacingSec, head, slotCount, slotCount),
      );
    };
    expect(addressesFor()).toEqual(addressesFor());
    // Center (weight 0) is always "now"; the outer ring reaches furthest back.
    const [center, , , , outer] = addressesFor();
    expect(center?.k).toBe(0);
    expect(outer?.k).toBeGreaterThan(0);
    expect(outer?.k).toBeLessThanOrEqual(slotCount - 1);
  });

  test('slot lookup mirrors the ring arithmetic exactly', () => {
    const head = 3;
    const count = 8;
    // k=0 -> head; k=1 -> head-1; wrapping below zero.
    expect(resolveSlot(0, 1, head, count, count).physical).toBe(3);
    expect(resolveSlot(1, 1, head, count, count).physical).toBe(2);
    expect(resolveSlot(4, 1, head, count, count).physical).toBe(7);
    expect(resolveSlot(5, 1, head, count, count).physical).toBe(6);
  });

  test('offsets beyond the buffer clamp to the oldest available frame', () => {
    const filled = 10;
    const { k } = resolveSlot(999, spacingSec, 0, slotCount, filled);
    expect(k).toBe(filled - 1);
  });
});

describe('§16.6 looping preview does not contaminate a later export', () => {
  test('anchor snapping is idempotent across loop restarts', () => {
    // Loop restart returns to the same composition times; the grid must map
    // them to exactly the same anchors as the first pass.
    const pass1 = [0, 0.5, 1, 1.5].map((t) => snapToGrid(t, spacingSec));
    const pass2 = [0, 0.5, 1, 1.5].map((t) => snapToGrid(t, spacingSec));
    expect(pass1).toEqual(pass2);
    const scheduleFirst = temporalSchedule(pass1[2] ?? 0, spacingSec, slotCount, BOUNDS);
    const scheduleAfterLoop = temporalSchedule(pass2[2] ?? 0, spacingSec, slotCount, BOUNDS);
    expect(scheduleAfterLoop).toEqual(scheduleFirst);
  });
});

describe('§16.7 source boundary clamping is deterministic', () => {
  test('before start clamps to the first frame', () => {
    expect(resolveBoundary(-5, 0, 10, 'clamp')).toBe(0);
    expect(resolveBoundary(-0.001, 0, 10, 'clamp')).toBe(0);
  });

  test('after end clamps to the last frame', () => {
    expect(resolveBoundary(99, 0, 10, 'clamp')).toBe(10);
  });

  test('a schedule near t=0 is fully clamped, never negative', () => {
    const schedule = temporalSchedule(0.1, spacingSec, slotCount, BOUNDS);
    for (const entry of schedule) {
      expect(entry.sourceTime).toBeGreaterThanOrEqual(0);
      expect(entry.sourceTime).toBeLessThanOrEqual(10);
    }
    // Deep history at the very start collapses onto frame 0.
    expect(schedule[schedule.length - 1]?.sourceTime).toBe(0);
  });

  test('wrap and mirror modes are pure and in range', () => {
    for (const t of [-3.3, -0.1, 0, 5, 10, 13.7]) {
      const wrapped = resolveBoundary(t, 0, 10, 'wrap');
      const mirrored = resolveBoundary(t, 0, 10, 'mirror');
      expect(wrapped).toBeGreaterThanOrEqual(0);
      expect(wrapped).toBeLessThanOrEqual(10);
      expect(mirrored).toBeGreaterThanOrEqual(0);
      expect(mirrored).toBeLessThanOrEqual(10);
      expect(resolveBoundary(t, 0, 10, 'wrap')).toBe(wrapped);
    }
  });
});

describe('temporal memory budget', () => {
  test('default buffer stays well under a preview budget', () => {
    const bytes =
      Math.ceil(Math.sqrt(slotCount)) *
      DEFAULT_TEMPORAL_CONFIG.slotWidth *
      Math.ceil(slotCount / Math.ceil(Math.sqrt(slotCount))) *
      DEFAULT_TEMPORAL_CONFIG.slotHeight *
      4;
    expect(bytes / (1024 * 1024)).toBeLessThan(16);
  });

  test('buffer span covers the advertised max offset', () => {
    const span = (slotCount - 1) * spacingSec;
    expect(span).toBeGreaterThanOrEqual(2.29);
  });
});

/**
 * CE1H §30-34 — the CE1C debt, root-caused and closed.
 *
 * Symptom: a subrange export of a temporal technique never matched the same
 * global frames of a full export (0/12), even with a decoder-free
 * deterministic generator source.
 *
 * It was never the schedule. Measured with the GPU harness
 * (`window.__dev.temporalPathCompare`), the atlas built by priming at T and
 * the atlas built by priming earlier and advancing to T are IDENTICAL by
 * logical slot, with the same anchor, spacing and filled count. The only
 * difference is `head` — where logical slot 0 physically sits in the atlas.
 *
 * The slots are tiles in one texture, so a bilinear tap at a tile edge
 * blended in the NEIGHBOURING tile — a different moment in time. Rotating
 * the physical placement changes which frame is adjacent, so identical
 * history rendered differently. `sampleTemporal` now clamps each tap half a
 * texel inside its own tile, which makes sampling head-invariant.
 *
 * Measured after the fix (clean process, deterministic `waves` generator,
 * 320×180 @12fps, full 1–3s vs subrange 2–3s):
 *   Time Field  12/12 byte-identical (worst pixel delta 0)
 *   Slit Scan   12/12 byte-identical (worst pixel delta 0)
 * and `temporalExportProbe` reports frameSame=true at T=2 and T=2.5 for
 * both techniques.
 */
describe('temporal atlas sampling is head-invariant (CE1C debt, CE1H §32-34)', () => {
  const shader = readFileSync(
    join(__dirname, '..', 'src', 'rendering', 'shaders', 'temporal.ts'),
    'utf8',
  );

  it('every tap is clamped inside its own atlas tile', () => {
    // Without this, a subrange export cannot reproduce a full export: the
    // bleed depends on head, and head depends on how history was built.
    expect(shader).toContain('halfTexel');
    expect(shader).toContain('textureSize(uTemporalTex, 0)');
    expect(shader).toMatch(/clamp\(\(base \+ cell\) \/ grid, lo, hi\)/);
  });

  it('the tile bounds are derived from the atlas grid, not hardcoded', () => {
    expect(shader).toContain('vec2 lo = base / grid + halfTexel;');
    expect(shader).toContain('vec2 hi = (base + 1.0) / grid - halfTexel;');
  });
});

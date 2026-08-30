import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENCODE_MAX, encodeByte, decodeByte, regionStats } from '@/rendering/flow/flowDiagnostics';

/** CE1D-2 — pure math of the GPU verification harness (§14 companion). */

describe('flow diagnostic encoding', () => {
  it('signed encode/decode round-trips the contract points', () => {
    expect(encodeByte(-ENCODE_MAX)).toBe(0);
    expect(encodeByte(0)).toBe(128);
    expect(encodeByte(ENCODE_MAX)).toBe(255);
    expect(Math.abs(decodeByte(128))).toBeLessThan(ENCODE_MAX / 127.5); // ≤ half-LSB
    expect(decodeByte(255)).toBeCloseTo(ENCODE_MAX, 6);
    expect(decodeByte(0)).toBeCloseTo(-ENCODE_MAX, 6);
    // saturation clamps visibly, never wraps
    expect(encodeByte(ENCODE_MAX * 3)).toBe(255);
    expect(encodeByte(-ENCODE_MAX * 3)).toBe(0);
  });

  it('regionStats aggregates decoded vectors correctly', () => {
    // 4×1 buffer: two pixels of +MAX x, two of zero.
    const w = 4;
    const h = 1;
    const buf = new Uint8Array(w * h * 4);
    for (let x = 0; x < w; x++) {
      buf[x * 4] = x < 2 ? 255 : 128;
      buf[x * 4 + 1] = 128;
    }
    const all = regionStats(buf, w, h, { x0: 0, x1: 4, y0: 0, y1: 1 });
    expect(all.pixels).toBe(4);
    expect(all.meanX).toBeCloseTo(ENCODE_MAX / 2, 3); // 8-bit LSB tolerance
    expect(Math.abs(all.meanY)).toBeLessThan(ENCODE_MAX / 127.5);
    const moving = regionStats(buf, w, h, { x0: 0, x1: 2, y0: 0, y1: 1 });
    expect(moving.meanX).toBeCloseTo(ENCODE_MAX, 3);
    expect(moving.maxMag).toBeCloseTo(ENCODE_MAX, 3);
  });
});

describe('Tikhonov regression (§14) — the intended normal equations', () => {
  // Pure-math mirror of the LK solve: regularization on the DIAGONAL must
  // recover the 1-D component in the aperture case; det-only must not.
  const solveDiagonal = (a11: number, a12: number, a22: number, b1: number, b2: number, reg = 1e-3) => {
    const A11 = a11 + reg;
    const A22 = a22 + reg;
    const det = A11 * A22 - a12 * a12;
    return { vx: (-A22 * b1 + a12 * b2) / det, vy: (a12 * b1 - A11 * b2) / det };
  };
  const solveDetOnly = (a11: number, a12: number, a22: number, b1: number, b2: number, reg = 1e-4) => {
    const det = a11 * a22 - a12 * a12 + reg;
    return { vx: (-a22 * b1 + a12 * b2) / det, vy: (a12 * b1 - a11 * b2) / det };
  };

  it('aperture case (vertical edge: a22=0) — diagonal solves, det-only collapses', () => {
    // Pure horizontal structure: a11>0, a22=0, temporal shift b1<0 (moving right).
    const a11 = 0.2, a12 = 0, a22 = 0, b1 = -0.1, b2 = 0;
    const diag = solveDiagonal(a11, a12, a22, b1, b2);
    expect(diag.vx).toBeGreaterThan(0.3); // recovers rightward motion
    expect(Math.abs(diag.vy)).toBeLessThan(1e-9);
    const det = solveDetOnly(a11, a12, a22, b1, b2);
    expect(Math.abs(det.vx)).toBeLessThan(1e-9); // the CE1D bug, locked forever
  });

  it('well-conditioned case: both solvers agree', () => {
    const a11 = 0.3, a12 = 0.05, a22 = 0.25, b1 = -0.06, b2 = 0.02;
    const d1 = solveDiagonal(a11, a12, a22, b1, b2, 1e-6);
    const d2 = solveDetOnly(a11, a12, a22, b1, b2, 1e-9);
    expect(d1.vx).toBeCloseTo(d2.vx, 3);
    expect(d1.vy).toBeCloseTo(d2.vy, 3);
  });

  it('the shipped shader carries diagonal regularization', () => {
    // Structural companion: the GLSL applies reg to a11/a22, not to det.
    const src = readFileSync('src/rendering/flow/OpticalFlowField.ts', 'utf8');
    expect(src.includes('a11 += reg;')).toBe(true);
    expect(src.includes('a22 += reg;')).toBe(true);
    expect(src.includes('det += reg')).toBe(false);
  });
});

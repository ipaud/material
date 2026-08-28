import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MaterialMark } from '@/brand/MaterialMark';
import { ICON_LANE, iconPositionForSeed } from '@/brand/mark';
import { deriveSeed } from '@/utils/prng';

/**
 * The mark's signal position is the project's brand fingerprint. Like the
 * pattern goldens, the exact values are compatibility: a project must show
 * the same mark forever.
 */

afterEach(cleanup);

describe('iconPositionForSeed', () => {
  it('is deterministic and stays in the grid', () => {
    for (let seed = 0; seed < 500; seed++) {
      const position = iconPositionForSeed(seed);
      expect(position).toBeGreaterThanOrEqual(0);
      expect(position).toBeLessThanOrEqual(8);
      expect(iconPositionForSeed(seed)).toBe(position);
    }
  });

  it('derives through the sanctioned PRNG lane', () => {
    expect(iconPositionForSeed(12345)).toBe(deriveSeed(12345, ICON_LANE) % 9);
  });

  it('locks golden fingerprints (changing these changes every project mark)', () => {
    // Exact values — locked like the P3 pattern goldens.
    expect(iconPositionForSeed(1)).toBe(1);
    expect(iconPositionForSeed(12345)).toBe(2);
    expect(iconPositionForSeed(841295)).toBe(7);
    expect(iconPositionForSeed(0xffffffff)).toBe(8);
  });

  it('spreads across the grid over many seeds', () => {
    const seen = new Set<number>();
    for (let seed = 0; seed < 200; seed++) seen.add(iconPositionForSeed(seed));
    expect(seen.size).toBe(9);
  });
});

describe('MaterialMark', () => {
  it('renders nine modules with the signal at the given position', () => {
    const { container } = render(<MaterialMark position={2} />);
    const rects = container.querySelectorAll('rect');
    expect(rects).toHaveLength(9);
    const signals = container.querySelectorAll('.material-mark-signal');
    expect(signals).toHaveLength(1);
    expect([...rects].indexOf(signals[0] as SVGRectElement)).toBe(2);
  });

  it('is decorative — hidden from assistive tech', () => {
    const { container } = render(<MaterialMark position={4} />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('moves the signal with the position', () => {
    for (const position of [0, 4, 8]) {
      const { container, unmount } = render(<MaterialMark position={position} />);
      const rects = [...container.querySelectorAll('rect')];
      expect(rects.findIndex((r) => r.classList.contains('material-mark-signal'))).toBe(position);
      unmount();
    }
  });
});

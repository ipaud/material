import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  boundsFor,
  describeDisplay,
  fullscreenBounds,
  pickDefaultDisplay,
  resolveDisplay,
  sameBounds,
  sortDisplays,
  windowedBounds,
  type DisplayInfo,
} from '@shared/display';

/**
 * Phase 18C — display targeting. Pure helpers, so multi-monitor topologies
 * (including the ones this machine does not have) are testable without
 * hardware and without mocking Electron.
 */

function display(over: Partial<DisplayInfo> = {}): DisplayInfo {
  const bounds = over.bounds ?? { x: 0, y: 0, width: 1920, height: 1080 };
  return {
    id: 1,
    label: 'Display',
    bounds,
    workArea: over.workArea ?? { ...bounds, y: bounds.y + 25, height: bounds.height - 25 },
    scaleFactor: 1,
    rotation: 0,
    primary: false,
    internal: false,
    ...over,
  };
}

const builtIn = display({
  id: 1,
  label: 'Built-in Display',
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  scaleFactor: 2,
  primary: true,
  internal: true,
});
/** Arranged to the LEFT of the built-in panel: negative x, as macOS reports. */
const leftProjector = display({
  id: 2,
  label: 'EPSON Projector',
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
});
const rightMonitor = display({
  id: 3,
  label: 'LG ULTRAFINE',
  bounds: { x: 1512, y: 0, width: 3840, height: 2160 },
  scaleFactor: 2,
});
/** Arranged ABOVE the primary: negative y. */
const aboveMonitor = display({
  id: 4,
  label: 'Overhead',
  bounds: { x: 0, y: -1080, width: 1920, height: 1080 },
});

describe('default display selection', () => {
  it('prefers an external display — that is what a projector is for', () => {
    expect(pickDefaultDisplay([builtIn, rightMonitor])?.id).toBe(rightMonitor.id);
    expect(pickDefaultDisplay([builtIn, leftProjector, rightMonitor])?.id).toBe(leftProjector.id);
  });

  it('falls back to the only display on a single-monitor machine', () => {
    expect(pickDefaultDisplay([builtIn])?.id).toBe(builtIn.id);
  });

  it('handles an empty list without throwing', () => {
    expect(pickDefaultDisplay([])).toBeNull();
    expect(resolveDisplay([], 7)).toBeNull();
  });

  it('picks a non-primary display even when it reports as internal', () => {
    const secondInternal = display({ id: 9, internal: true, primary: false });
    expect(pickDefaultDisplay([builtIn, secondInternal])?.id).toBe(9);
  });
});

describe('remembered display resolution', () => {
  const all = [builtIn, leftProjector, rightMonitor];

  it('uses the remembered display when it is still connected', () => {
    expect(resolveDisplay(all, rightMonitor.id)?.id).toBe(rightMonitor.id);
  });

  it('falls back safely when the remembered display is gone', () => {
    // Stale id from a previous hardware session must never produce an
    // off-screen window or an error.
    expect(resolveDisplay([builtIn, rightMonitor], leftProjector.id)?.id).toBe(rightMonitor.id);
    expect(resolveDisplay([builtIn], 999)?.id).toBe(builtIn.id);
  });

  it('falls back when nothing was remembered', () => {
    expect(resolveDisplay(all, null)?.id).toBe(leftProjector.id);
  });
});

describe('display ordering', () => {
  it('lists the built-in panel first, then externals by position', () => {
    const sorted = sortDisplays([rightMonitor, leftProjector, builtIn]);
    expect(sorted.map((d) => d.id)).toEqual([builtIn.id, leftProjector.id, rightMonitor.id]);
  });

  it('is stable and never used as identity', () => {
    const a = sortDisplays([rightMonitor, leftProjector, builtIn]);
    const b = sortDisplays([builtIn, rightMonitor, leftProjector]);
    expect(a.map((d) => d.id)).toEqual(b.map((d) => d.id));
  });
});

describe('geometry', () => {
  it('fullscreen covers the whole panel, including the menu bar area', () => {
    expect(fullscreenBounds(builtIn)).toEqual(builtIn.bounds);
    // workArea would leave the menu bar/Dock visible — explicitly not used.
    expect(fullscreenBounds(builtIn)).not.toEqual(builtIn.workArea);
  });

  it('keeps negative coordinates: a display left of primary stays there', () => {
    const bounds = boundsFor(leftProjector, 'fullscreen');
    expect(bounds.x).toBe(-1920);
    expect(bounds).toEqual({ x: -1920, y: 0, width: 1920, height: 1080 });
  });

  it('keeps negative coordinates above the primary too', () => {
    expect(boundsFor(aboveMonitor, 'fullscreen').y).toBe(-1080);
  });

  it('windowed geometry is centred on the TARGET display, negative x included', () => {
    const bounds = windowedBounds(leftProjector);
    expect(bounds.width).toBe(Math.round(1920 * 0.7));
    // Centre of the window equals the centre of that display's work area.
    const centreX = bounds.x + bounds.width / 2;
    const waCentreX = leftProjector.workArea.x + leftProjector.workArea.width / 2;
    expect(centreX).toBeCloseTo(waCentreX, 0);
    expect(bounds.x).toBeLessThan(0);
  });

  it('windowed geometry never collapses below a usable size', () => {
    const tiny = display({ bounds: { x: 0, y: 0, width: 200, height: 100 } });
    const bounds = windowedBounds(tiny);
    expect(bounds.width).toBeGreaterThanOrEqual(320);
    expect(bounds.height).toBeGreaterThanOrEqual(180);
  });

  it('mixed DPI: geometry is in DIPs, scale factor travels separately', () => {
    // 3840×2160 at 2× reports 1920×1080 logical bounds in Electron; the
    // helpers must not multiply by the scale factor themselves.
    const hidpi = display({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 });
    expect(fullscreenBounds(hidpi)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(describeDisplay(hidpi)).toContain('@2×');
    expect(describeDisplay(display({ scaleFactor: 1, label: 'X' }))).not.toContain('@');
  });

  it('rotated displays need no special case — bounds already describe them', () => {
    const rotated = display({ bounds: { x: 0, y: 0, width: 1080, height: 1920 }, rotation: 90 });
    expect(fullscreenBounds(rotated)).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
  });

  it('sameBounds compares rectangles, including the null cases', () => {
    expect(sameBounds(builtIn.bounds, { ...builtIn.bounds })).toBe(true);
    expect(sameBounds(builtIn.bounds, leftProjector.bounds)).toBe(false);
    expect(sameBounds(null, null)).toBe(true);
    expect(sameBounds(null, builtIn.bounds)).toBe(false);
  });
});

describe('labels', () => {
  it('describes a display with its real resolution and scale', () => {
    expect(describeDisplay(builtIn)).toBe('Built-in Display · 1512×982 @2×');
    expect(describeDisplay(leftProjector)).toBe('EPSON Projector · 1920×1080');
  });
});

// ---------------------------------------------------------------------------
// Structural invariants — the Output replica stays passive (§101)
// ---------------------------------------------------------------------------

describe('output replica remains passive', () => {
  const read = (...parts: string[]) => readFileSync(join(__dirname, '..', ...parts), 'utf8');
  /** Code only: a comment saying "no MIDI here" must not fail the check. */
  const code = (...parts: string[]) =>
    read(...parts)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('the output window renderer evaluates no creative system', () => {
    for (const file of ['main.ts', 'replica.ts']) {
      const src = code('src', 'output-window', file);
      for (const banned of [
        'pattern',
        'morphRuntime',
        'candidateRuntime',
        'TriggerScheduler',
        'modulationRuntime',
        'evalSources',
        'midi',
      ]) {
        expect(src.toLowerCase().includes(banned.toLowerCase()), `${file} must not use ${banned}`).toBe(
          false,
        );
      }
    }
  });

  it('no pixel transport was introduced', () => {
    for (const file of ['main.ts', 'replica.ts']) {
      const src = code('src', 'output-window', file);
      for (const banned of ['toDataURL', 'capturePage', 'ImageBitmap', 'getImageData', 'captureStream']) {
        expect(src.includes(banned), `${file} must not transport pixels (${banned})`).toBe(false);
      }
    }
  });

  it('the display module is the only place that touches Electron screen', () => {
    const main = code('electron', 'main', 'outputWindow.ts');
    expect(main.includes("from 'electron'")).toBe(true);
    // outputWindow imports the adapter rather than `screen` directly.
    expect(/import \{[^}]*\bscreen\b[^}]*\} from 'electron'/.test(main)).toBe(false);
    expect(main.includes("from './displays'")).toBe(true);
  });

  it('OUTPUT display selection is app preference, never project schema', () => {
    const schema = code('shared', 'schemas', 'project.ts');
    // 18E note: `displayId` DOES exist in the schema now — but only as the
    // screen SOURCE capture preference (input), which is a distinct concept
    // from the output target (§13). Output-target vocabulary stays banned.
    for (const banned of ['lastOutputDisplay', 'outputMode', 'outputDisplay', 'fullscreen']) {
      expect(schema.includes(banned), `project schema must not carry ${banned}`).toBe(false);
    }
    // Every displayId occurrence must live inside the screen source ref.
    const occurrences = schema.split('displayId').length - 1;
    const screenBlock = schema.slice(
      schema.indexOf('screenSourceRefSchema'),
      schema.indexOf('windowSourceRefSchema'),
    );
    expect(occurrences).toBe(screenBlock.split('displayId').length - 1);
    const settings = code('electron', 'filesystem', 'settings.ts');
    expect(settings.includes('lastOutputDisplayId')).toBe(true);
    // Never restore "it was open" — that would seize a projector on launch.
    expect(settings.includes('lastOutputOpen')).toBe(false);
  });
});

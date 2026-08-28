/**
 * Display targeting (Phase 18C) — pure helpers shared by main and renderer.
 *
 * Everything here is a plain function over plain data so display selection,
 * fallback and geometry can be tested without physical monitors and without
 * mocking Electron. The main process adapts `screen.getAllDisplays()` into
 * `DisplayInfo`; nothing else ever sees an Electron Display object.
 *
 * macOS coordinate reality this must respect: a display arranged to the left
 * of (or above) the primary has NEGATIVE bounds. Clamping coordinates to >= 0
 * would silently drag the output back onto the primary monitor.
 */

export interface DisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayInfo {
  /** Electron's display id — the authoritative runtime identity. */
  id: number;
  label: string;
  bounds: DisplayBounds;
  /** Bounds minus menu bar / Dock. */
  workArea: DisplayBounds;
  scaleFactor: number;
  rotation: number;
  primary: boolean;
  /** macOS built-in panel, when Electron reports enough to tell. */
  internal: boolean;
}

export type OutputMode = 'windowed' | 'fullscreen';

export type OutputState = 'closed' | 'open' | 'error' | 'display-disconnected';

export interface OutputDisplayStatus {
  state: OutputState;
  mode: OutputMode;
  /** The display the window is on, or null when closed. */
  displayId: number | null;
  bounds: DisplayBounds | null;
  scaleFactor: number | null;
}

export const CLOSED_OUTPUT_STATUS: OutputDisplayStatus = {
  state: 'closed',
  mode: 'fullscreen',
  displayId: null,
  bounds: null,
  scaleFactor: null,
};

/**
 * Default target: an external display when one exists, because that is what
 * a projector or a second monitor is for. Falls back to primary, then to the
 * first display so a single-monitor machine still works.
 */
export function pickDefaultDisplay(displays: readonly DisplayInfo[]): DisplayInfo | null {
  if (displays.length === 0) return null;
  const external = displays.find((d) => !d.primary && !d.internal);
  if (external) return external;
  const nonPrimary = displays.find((d) => !d.primary);
  if (nonPrimary) return nonPrimary;
  return displays.find((d) => d.primary) ?? displays[0] ?? null;
}

/**
 * Resolve a remembered display id against the monitors actually present.
 * Display ids do not survive a hardware change, so a stale id must degrade
 * to a sensible target rather than to an off-screen window or an error.
 */
export function resolveDisplay(
  displays: readonly DisplayInfo[],
  preferredId: number | null,
): DisplayInfo | null {
  if (preferredId !== null) {
    const exact = displays.find((d) => d.id === preferredId);
    if (exact) return exact;
  }
  return pickDefaultDisplay(displays);
}

/**
 * Presentation order: the built-in panel first, then externals by position.
 * The list index is never identity — selection always uses `id`.
 */
export function sortDisplays(displays: readonly DisplayInfo[]): DisplayInfo[] {
  return [...displays].sort((a, b) => {
    if (a.internal !== b.internal) return a.internal ? -1 : 1;
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    if (a.bounds.x !== b.bounds.x) return a.bounds.x - b.bounds.x;
    return a.bounds.y - b.bounds.y;
  });
}

/** Fullscreen covers the whole panel — bounds, never workArea. */
export function fullscreenBounds(display: DisplayInfo): DisplayBounds {
  return { ...display.bounds };
}

/**
 * A useful windowed setup size: 70% of the work area, centred on the target
 * display. Derived from the DISPLAY's geometry, never from the editor
 * window, so opening on an external monitor cannot inherit editor bounds.
 */
export function windowedBounds(display: DisplayInfo, fraction = 0.7): DisplayBounds {
  const { workArea } = display;
  const width = Math.max(320, Math.round(workArea.width * fraction));
  const height = Math.max(180, Math.round(workArea.height * fraction));
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
}

export function boundsFor(display: DisplayInfo, mode: OutputMode): DisplayBounds {
  return mode === 'fullscreen' ? fullscreenBounds(display) : windowedBounds(display);
}

/** True when the two bounds describe the same rectangle. */
export function sameBounds(a: DisplayBounds | null, b: DisplayBounds | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Human label for a display row: `Built-in Display · 1512×982 @2×`. */
export function describeDisplay(display: DisplayInfo): string {
  const scale = display.scaleFactor !== 1 ? ` @${display.scaleFactor}×` : '';
  return `${display.label} · ${display.bounds.width}×${display.bounds.height}${scale}`;
}

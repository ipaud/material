import { screen, type Display } from 'electron';
import { sortDisplays, type DisplayInfo } from '../../shared/display';

/**
 * The only place that touches Electron's `screen` module (Phase 18C).
 *
 * Raw `Display` objects never cross IPC — they carry more than the renderer
 * needs and their shape is Electron's, not ours. Everything downstream works
 * on the plain `DisplayInfo` from shared/display.ts.
 */

function labelFor(display: Display, index: number): string {
  // Electron's `label` is empty on some macOS versions and driver setups.
  const raw = display.label?.trim();
  if (raw) return raw;
  if (display.internal) return 'Built-in Display';
  return `Display ${index + 1}`;
}

export function toDisplayInfo(display: Display, index: number, primaryId: number): DisplayInfo {
  return {
    id: display.id,
    label: labelFor(display, index),
    bounds: { ...display.bounds },
    workArea: { ...display.workArea },
    scaleFactor: display.scaleFactor,
    rotation: display.rotation,
    primary: display.id === primaryId,
    internal: display.internal === true,
  };
}

/** Every connected display, in presentation order. Never throws. */
export function listDisplays(): DisplayInfo[] {
  try {
    const primaryId = screen.getPrimaryDisplay().id;
    return sortDisplays(screen.getAllDisplays().map((d, i) => toDisplayInfo(d, i, primaryId)));
  } catch (error) {
    // Enumeration failing must degrade to "no displays" so the OUTPUT
    // workspace can say DISPLAY UNAVAILABLE instead of taking the app down.
    console.error('[display] enumeration failed:', error);
    return [];
  }
}

export function findDisplay(id: number): DisplayInfo | null {
  return listDisplays().find((d) => d.id === id) ?? null;
}

/** Subscribe to hotplug and geometry changes; returns an unsubscribe. */
export function watchDisplays(onChange: () => void): () => void {
  const handler = () => onChange();
  screen.on('display-added', handler);
  screen.on('display-removed', handler);
  screen.on('display-metrics-changed', handler);
  return () => {
    screen.off('display-added', handler);
    screen.off('display-removed', handler);
    screen.off('display-metrics-changed', handler);
  };
}

import { BrowserWindow, MessageChannelMain, app } from 'electron';
import path from 'node:path';
import { IPC } from '../../shared/ipc';
import {
  boundsFor,
  CLOSED_OUTPUT_STATUS,
  resolveDisplay,
  type DisplayInfo,
  type OutputDisplayStatus,
  type OutputMode,
} from '../../shared/display';
import { listDisplays, watchDisplays } from './displays';

/**
 * Output Window (18B replica → 18C display destination).
 *
 * One window, maximum, always. Selecting another monitor MOVES this window;
 * it never spawns a second one. Main owns every native concern — display
 * enumeration, target, bounds, fullscreen, lifecycle — and the renderer owns
 * only pixels and the editor-side status UI. Main still never interprets a
 * runtime message: it brokers the MessageChannel and gets out of the way.
 *
 * FULLSCREEN STRATEGY (ADR, see docs/DECISIONS.md): presentation fullscreen
 * is a BORDERLESS window sized to `display.bounds`, not
 * `setFullScreen(true)`. Native fullscreen moves the window into its own
 * macOS Space, which animates on entry, animates again when the target
 * display changes, and drags the user's Space along with it — unacceptable
 * mid-performance. A borderless window at display bounds appears instantly,
 * moves between monitors without a Space transition, and leaves the editor's
 * Space alone. It is raised above the menu bar and Dock only while
 * presenting, and only when the output is NOT sharing a display with the
 * editor — on a single-monitor setup that would lock the performer out of
 * their own instrument.
 */

const isDev = !app.isPackaged;

let outputWindow: BrowserWindow | null = null;
let currentDisplayId: number | null = null;
let currentMode: OutputMode = 'fullscreen';
let lastState: OutputDisplayStatus['state'] = 'closed';
let unwatchDisplays: (() => void) | null = null;

let setLiveness: ((reason: 'output-window', active: boolean) => void) | null = null;
let notifyEditor: ((status: OutputDisplayStatus) => void) | null = null;
let notifyDisplays: ((displays: DisplayInfo[]) => void) | null = null;

export function configureOutputWindow(deps: {
  setLiveness: (reason: 'output-window', active: boolean) => void;
  notifyEditor: (status: OutputDisplayStatus) => void;
  notifyDisplays?: (displays: DisplayInfo[]) => void;
}): void {
  setLiveness = deps.setLiveness;
  notifyEditor = deps.notifyEditor;
  notifyDisplays = deps.notifyDisplays ?? null;
}

/** 18E: is this frame the Output replica's main frame? (capture gate) */
export function isOutputFrame(frame: { processId: number; routingId: number } | null): boolean {
  if (!frame || outputWindow === null || outputWindow.isDestroyed()) return false;
  const main = outputWindow.webContents.mainFrame;
  return main.processId === frame.processId && main.routingId === frame.routingId;
}

export function isOutputOpen(): boolean {
  return outputWindow !== null && !outputWindow.isDestroyed();
}

export function outputStatus(): OutputDisplayStatus {
  if (!isOutputOpen()) {
    return { ...CLOSED_OUTPUT_STATUS, state: lastState === 'closed' ? 'closed' : lastState };
  }
  const window = outputWindow as BrowserWindow;
  const display = currentDisplayId !== null ? findKnown(currentDisplayId) : null;
  return {
    state: 'open',
    mode: currentMode,
    // `getBounds()` still reports the pre-fullscreen frame while
    // simpleFullScreen is on, so a fullscreen output must report the panel
    // it is actually covering — that number is what the UI shows.
    bounds:
      currentMode === 'fullscreen' && display ? { ...display.bounds } : window.getBounds(),
    displayId: currentDisplayId,
    scaleFactor: display?.scaleFactor ?? null,
  };
}

function findKnown(id: number): DisplayInfo | null {
  return listDisplays().find((d) => d.id === id) ?? null;
}

function publish(state?: OutputDisplayStatus['state']): void {
  if (state) lastState = state;
  notifyEditor?.(outputStatus());
}

function brokerPorts(editor: BrowserWindow, output: BrowserWindow): void {
  const { port1, port2 } = new MessageChannelMain();
  editor.webContents.postMessage(IPC.outputRuntimePort, null, [port1]);
  output.webContents.postMessage('output:runtime-port', null, [port2]);
}

/**
 * Apply target geometry. Always sets bounds explicitly — Electron will not
 * move a window onto a negative-coordinate display for us, and a display
 * left of or above the primary is exactly where a projector usually lands.
 */
function applyGeometry(window: BrowserWindow, display: DisplayInfo, mode: OutputMode): void {
  if (mode === 'windowed') {
    window.setSimpleFullScreen(false);
    window.setAlwaysOnTop(false);
    window.setVisibleOnAllWorkspaces(false);
    window.setBounds(boundsFor(display, 'windowed'));
    return;
  }

  // Fullscreen: position on the target display FIRST so the fullscreen
  // applies to the right monitor, then fill it. Plain `setBounds` to
  // display.bounds is not enough — macOS constrains an ordinary window to
  // the work area, leaving the menu bar visible.
  window.setBounds(boundsFor(display, 'windowed'));
  window.setSimpleFullScreen(true);
  // Measured on macOS 15: simpleFullScreen alone stops at the work area and
  // leaves the menu bar showing (1512×949 of a 1512×982 panel). Raising the
  // window to screen-saver level is what actually fills the display —
  // 1512×982 at y=0 — with no Space transition. A projector needs that
  // coverage, so fullscreen always takes it; the way back out is the
  // editor's ⌘⇧F, the DISPLAY panel, or Escape on the output window.
  window.setAlwaysOnTop(true, 'screen-saver');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

export function openOutputWindow(
  getEditor: () => BrowserWindow | null,
  options: { displayId?: number | null | undefined; mode?: OutputMode | undefined } = {},
): boolean {
  const editor = getEditor();
  if (!editor) return false;

  const displays = listDisplays();
  const target = resolveDisplay(displays, options.displayId ?? currentDisplayId);
  if (!target) {
    publish('error');
    return false;
  }
  const mode = options.mode ?? currentMode;

  if (isOutputOpen()) {
    // Already open: this is a MOVE, never a second window.
    moveOutputWindow(target.id, mode);
    return true;
  }

  currentDisplayId = target.id;
  currentMode = mode;

  const window = new BrowserWindow({
    // Positioned on the target display before showing, so opening cannot
    // flash on the primary monitor first.
    ...boundsFor(target, 'windowed'),
    minWidth: 320,
    minHeight: 180,
    show: false,
    // Borderless in both modes: the output is a picture, not a document
    // window, and switching frame style at runtime is not supported.
    frame: false,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/output.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  outputWindow = window;
  // Windowed placement first: the window is constructed on the target
  // display, so showing it cannot flash on the primary one.
  window.setBounds(boundsFor(target, 'windowed'));

  window.once('ready-to-show', () => {
    // `showInactive` keeps keyboard focus in the editor — the performer must
    // not have to click back to use pads, keys or MIDI.
    window.showInactive();
    // simpleFullScreen only takes effect on a VISIBLE window, so fullscreen
    // is applied here rather than at construction time.
    applyGeometry(window, target, mode);
    getEditor()?.focus();
  });

  window.webContents.once('did-finish-load', () => {
    const ed = getEditor();
    if (ed && !window.isDestroyed()) {
      brokerPorts(ed, window);
      setLiveness?.('output-window', true);
      publish('open');
    }
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    console.warn('[output] renderer gone:', details.reason);
    lastState = 'error';
    if (!window.isDestroyed()) window.destroy();
  });

  window.on('closed', () => {
    outputWindow = null;
    setLiveness?.('output-window', false);
    // A crash already set 'error'; a deliberate close reports 'closed'.
    publish(lastState === 'error' || lastState === 'display-disconnected' ? lastState : 'closed');
    lastState = 'closed';
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/output-window/output.html`);
  } else {
    void window.loadFile(path.join(import.meta.dirname, '../renderer/output-window/output.html'));
  }
  return true;
}

/** Move the existing window to another display and/or mode. */
export function moveOutputWindow(displayId: number | null, mode?: OutputMode): boolean {
  if (!isOutputOpen()) return false;
  const window = outputWindow as BrowserWindow;
  const target = resolveDisplay(listDisplays(), displayId ?? currentDisplayId);
  if (!target) return false;
  const nextMode = mode ?? currentMode;

  // Drop the raised level before moving: a screen-saver-level window can
  // otherwise appear to jump across the primary display on its way over.
  window.setAlwaysOnTop(false);
  currentDisplayId = target.id;
  currentMode = nextMode;
  applyGeometry(window, target, nextMode);
  publish('open');
  return true;
}

export function setOutputMode(mode: OutputMode): boolean {
  return moveOutputWindow(currentDisplayId, mode);
}

export function closeOutputWindow(): void {
  if (isOutputOpen()) outputWindow?.close();
}

/**
 * Hotplug policy (18C): if the display the output is presenting on goes
 * away, CLOSE the output and report DISPLAY DISCONNECTED. The tempting
 * alternative — move it to the primary display — would slam a fullscreen
 * composition over the performer's editor at the worst possible moment.
 * Reopening is one click, and it is the performer's decision.
 */
function onDisplaysChanged(): void {
  const displays = listDisplays();
  notifyDisplays?.(displays);

  if (!isOutputOpen() || currentDisplayId === null) return;
  const target = displays.find((d) => d.id === currentDisplayId);
  if (!target) {
    console.warn('[output] target display disconnected — closing output');
    lastState = 'display-disconnected';
    closeOutputWindow();
    return;
  }
  // Still there, but its geometry may have changed (resolution, scaling,
  // rotation, rearrangement): re-apply so the window keeps filling it.
  const window = outputWindow as BrowserWindow;
  applyGeometry(window, target, currentMode);
  publish('open');
}

export function startDisplayWatch(): void {
  if (unwatchDisplays) return;
  unwatchDisplays = watchDisplays(onDisplaysChanged);
}

export function stopDisplayWatch(): void {
  unwatchDisplays?.();
  unwatchDisplays = null;
}

/** Current target selection, for the editor UI and preference persistence. */
export function outputTarget(): { displayId: number | null; mode: OutputMode } {
  return { displayId: currentDisplayId, mode: currentMode };
}

export function setOutputTarget(displayId: number | null, mode: OutputMode): void {
  currentDisplayId = displayId;
  currentMode = mode;
}

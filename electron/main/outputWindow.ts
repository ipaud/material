import { BrowserWindow, MessageChannelMain, app } from 'electron';
import path from 'node:path';
import { IPC } from '../../shared/ipc';
import type { OutputWindowStatus } from '../../shared/outputChannel';

/**
 * Dedicated Output Window (Phase 18B spike).
 *
 * One window maximum. Main only creates the window and brokers a
 * MessageChannelMain pair between the editor (authority) and the output
 * (replica) — it never interprets runtime messages. Closing output never
 * touches the editor; quitting the editor closes output.
 */

const isDev = !app.isPackaged;

let outputWindow: BrowserWindow | null = null;
let setLiveness: ((reason: 'output-window', active: boolean) => void) | null = null;
let notifyEditor: ((status: OutputWindowStatus) => void) | null = null;

export function configureOutputWindow(deps: {
  setLiveness: (reason: 'output-window', active: boolean) => void;
  notifyEditor: (status: OutputWindowStatus) => void;
}): void {
  setLiveness = deps.setLiveness;
  notifyEditor = deps.notifyEditor;
}

export function isOutputOpen(): boolean {
  return outputWindow !== null && !outputWindow.isDestroyed();
}

function brokerPorts(editor: BrowserWindow, output: BrowserWindow): void {
  const { port1, port2 } = new MessageChannelMain();
  editor.webContents.postMessage(IPC.outputRuntimePort, null, [port1]);
  output.webContents.postMessage('output:runtime-port', null, [port2]);
}

export function openOutputWindow(getEditor: () => BrowserWindow | null): boolean {
  const editor = getEditor();
  if (!editor) return false;
  if (isOutputOpen()) {
    outputWindow?.focus();
    return true;
  }

  const window = new BrowserWindow({
    width: 960,
    height: 540,
    minWidth: 320,
    minHeight: 180,
    show: false,
    backgroundColor: '#000000',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/output.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // The whole point: output keeps rendering regardless of focus/occlusion.
      backgroundThrottling: false,
    },
  });
  outputWindow = window;

  window.once('ready-to-show', () => window.show());
  window.webContents.once('did-finish-load', () => {
    const ed = getEditor();
    if (ed && !window.isDestroyed()) {
      brokerPorts(ed, window);
      setLiveness?.('output-window', true);
      notifyEditor?.('open');
    }
  });

  // Replica failure must never take the editor down: report, clean up.
  window.webContents.on('render-process-gone', (_event, details) => {
    console.warn('[output] renderer gone:', details.reason);
    notifyEditor?.('error');
    if (!window.isDestroyed()) window.destroy();
  });

  window.on('closed', () => {
    console.log('[output] closed');
    outputWindow = null;
    setLiveness?.('output-window', false);
    notifyEditor?.('closed');
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/output-window/output.html`);
  } else {
    void window.loadFile(path.join(import.meta.dirname, '../renderer/output-window/output.html'));
  }
  return true;
}

export function closeOutputWindow(): void {
  if (isOutputOpen()) outputWindow?.close();
}

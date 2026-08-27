import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { registerIpcHandlers, SESSION_ID } from '../ipc/handlers';
import { clearRecovery } from '../filesystem/recovery';
import { buildAppMenu } from './menu';
import { registerMediaProtocolHandler, registerMediaSchemeAsPrivileged } from './protocol';

const isDev = !app.isPackaged;

// Dev-only: allow CDP-based QA tooling to drive the app.
if (isDev) app.commandLine.appendSwitch('remote-debugging-port', '9223');

// MATERIAL is an offline instrument: audio playback must not require a gesture.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow: BrowserWindow | null = null;

registerMediaSchemeAsPrivileged();

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#0c0c0d',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // A visual instrument must keep rendering while the window is occluded
      // or unfocused (performance use, second display, exporting in the
      // background). Chromium otherwise throttles rAF to a near halt.
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // No external navigation, no popups.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('material://')) {
      event.preventDefault();
    }
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(import.meta.dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerMediaProtocolHandler();
  registerIpcHandlers(() => mainWindow);
  buildAppMenu(() => mainWindow);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

// A recovery file left on disk means the previous session did not shut down
// cleanly, so it must only be removed on a deliberate quit.
let recoveryCleared = false;
app.on('will-quit', (event) => {
  if (recoveryCleared) return;
  event.preventDefault();
  void clearRecovery(SESSION_ID)
    .catch(() => undefined)
    .finally(() => {
      recoveryCleared = true;
      app.quit();
    });
});

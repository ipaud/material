import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { registerIpcHandlers } from '../ipc/handlers';
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

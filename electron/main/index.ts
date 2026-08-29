import { app, BrowserWindow, session, shell } from 'electron';
import path from 'node:path';
import { cameraIntentArmed, registerIpcHandlers, SESSION_ID } from '../ipc/handlers';
import { closeOutputWindow } from './outputWindow';
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
    backgroundColor: '#08090a',
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

  // A renderer that fails to load must never leave an invisible-but-running
  // app: `show: false` waits for 'ready-to-show', which never fires if the
  // load failed. Report the reason and show the window anyway so the failure
  // is visible instead of silent.
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, url) => {
    console.error(`[main] renderer failed to load (${errorCode} ${errorDescription}): ${url}`);
    mainWindow?.show();
  });
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      console.error('[main] renderer never became ready — showing the window anyway');
      mainWindow.show();
    }
  }, 10_000);

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
    // The editor is the authority — without it the replica has nothing to show.
    closeOutputWindow();
  });
}

app.whenReady().then(() => {
  registerMediaProtocolHandler();

  // Web MIDI: Chromium ≥M119 routes ALL Web MIDI access through the
  // 'midiSysex' permission gate — even requestMIDIAccess({sysex:false}).
  // Granting the gate does NOT enable sysex data: the renderer only ever
  // requests sysex:false, so access.sysexEnabled stays false (verified in
  // QA).
  //
  // Camera (18D): video capture is INTENT-GATED. getUserMedia is allowed
  // only while the editor has explicitly armed camera intent (a user
  // clicking START CAMERA) — never on launch, project open or browsing.
  // The gate covers the output replica too: it may re-acquire the SAME
  // device for fan-out, but only while the editor's intent is armed, so the
  // replica can never initiate capture on its own. Audio capture stays
  // denied — MATERIAL never asks for the microphone.
  // All other permission requests stay denied (offline instrument).
  const isMidi = (permission: string): boolean =>
    permission === 'midi' || permission === 'midiSysex';
  const mediaAllowed = (permission: string, details: { mediaTypes?: string[] }): boolean => {
    if (permission !== 'media') return false;
    if (!cameraIntentArmed()) return false;
    const types = details.mediaTypes ?? [];
    // Plain enumerateDevices probes arrive as 'media' with no types; a
    // video-only getUserMedia arrives as ['video']. Audio is never allowed.
    return !types.includes('audio');
  };
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) =>
    callback(isMidi(permission) || mediaAllowed(permission, details as { mediaTypes?: string[] })),
  );
  session.defaultSession.setPermissionCheckHandler((_wc, permission, _origin, details) =>
    isMidi(permission) || mediaAllowed(permission, details as { mediaTypes?: string[] }),
  );

  registerIpcHandlers(() => mainWindow);
  buildAppMenu(() => mainWindow);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  console.log('[main] window-all-closed — quitting');
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

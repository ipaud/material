import { app, dialog, ipcMain, powerSaveBlocker, type BrowserWindow } from 'electron';
import { isLivenessReason, reduceLiveness, type LivenessReason } from '../../shared/liveness';
import { listDisplays } from '../main/displays';
import { readSettings, updateSettings } from '../filesystem/settings';
import {
  closeOutputWindow,
  configureOutputWindow,
  moveOutputWindow,
  openOutputWindow,
  outputTarget,
  setOutputMode,
  setOutputTarget,
  startDisplayWatch,
} from '../main/outputWindow';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { IPC, type AppInfo } from '../../shared/ipc';
import {
  PROJECT_EXTENSION,
  SUPPORTED_AUDIO_EXTENSIONS,
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_SVG_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS,
} from '../../shared/constants/app';
import { detectEncoders, ffmpegPath, ffprobePath } from '../media/ffmpeg';
import { probeMedia } from '../media/probe';
import { readSanitizedSvg } from '../media/svg';
import { readProjectFile, writeProjectFile } from '../filesystem/projects';
import { deleteUserPreset, listUserPresets, saveUserPreset } from '../filesystem/presets';
import { isApprovedMediaPath } from '../filesystem/mediaRegistry';
import { cancelExport, finishExport, startExport, writeExportFrame } from '../export/encoder';
import {
  clearRecovery,
  discardRecovery,
  listRecoveries,
  writeRecovery,
} from '../filesystem/recovery';
import { randomUUID } from 'node:crypto';

/** Identifies this app run; scopes the autosave file. */
export const SESSION_ID = randomUUID();

const pathArgSchema = z.string().min(1);
const nameArgSchema = z.string().min(1).max(255);
const base64Schema = z.string().min(1);
// Reject path separators and hidden-file prefixes in user-facing default names.
function sanitizeDefaultName(name: string): string {
  return name.replace(/[/\\:]/g, '-').replace(/^\.+/, '');
}

/** Held while the live engine must not be suspended by macOS App Nap. */
let liveEngineBlockerId: number | null = null;
const outputModeSchema = z.enum(['windowed', 'fullscreen']);
const outputOpenOptionsSchema = z.object({
  displayId: z.number().nullable().optional(),
  mode: outputModeSchema.optional(),
});

const livenessReasons = new Set<LivenessReason>();

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.appInfo, async (): Promise<AppInfo> => {
    return {
      version: app.getVersion(),
      electron: process.versions.electron ?? 'unknown',
      platform: process.platform,
      ffmpegAvailable: ffmpegPath !== null,
      ffprobeAvailable: ffprobePath !== null,
      availableEncoders: await detectEncoders(),
      livenessActive: liveEngineBlockerId !== null,
    };
  });

  ipcMain.handle(IPC.openMediaDialog, async (): Promise<string[]> => {
    const win = getWindow();
    if (!win) return [];
    const result = await dialog.showOpenDialog(win, {
      title: 'Import Media',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Media',
          extensions: [
            ...SUPPORTED_IMAGE_EXTENSIONS,
            ...SUPPORTED_VIDEO_EXTENSIONS,
            ...SUPPORTED_AUDIO_EXTENSIONS,
            ...SUPPORTED_SVG_EXTENSIONS,
          ],
        },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle(IPC.probeMedia, async (_event, rawPath: unknown) => {
    const filePath = pathArgSchema.parse(rawPath);
    return probeMedia(filePath);
  });

  ipcMain.handle(IPC.readProject, async (_event, rawPath: unknown) => {
    const filePath = pathArgSchema.parse(rawPath);
    const project = await readProjectFile(filePath);
    app.addRecentDocument(filePath);
    return { path: filePath, project };
  });

  ipcMain.handle(IPC.writeProject, async (_event, rawPath: unknown, rawProject: unknown) => {
    const filePath = pathArgSchema.parse(rawPath);
    await writeProjectFile(filePath, rawProject);
    app.addRecentDocument(filePath);
  });

  ipcMain.handle(IPC.readSvg, async (_event, rawPath: unknown) => {
    const filePath = pathArgSchema.parse(rawPath);
    if (!isApprovedMediaPath(filePath)) throw new Error('SVG has not been imported');
    return readSanitizedSvg(filePath);
  });

  ipcMain.handle(IPC.exportSaveDialog, async (_event, rawFormat: unknown, rawName: unknown) => {
    const win = getWindow();
    if (!win) return null;
    const format = z.enum(['png-sequence', 'h264', 'prores422', 'prores4444']).parse(rawFormat);
    const defaultName = sanitizeDefaultName(nameArgSchema.parse(rawName));
    if (format !== 'png-sequence') {
      const isProRes = format.startsWith('prores');
      const ext = isProRes ? 'mov' : 'mp4';
      const result = await dialog.showSaveDialog(win, {
        title: isProRes ? 'Export ProRes' : 'Export H.264',
        defaultPath: `${defaultName}.${ext}`,
        filters: [
          isProRes
            ? { name: 'QuickTime Movie', extensions: ['mov'] }
            : { name: 'MP4 Video', extensions: ['mp4'] },
        ],
      });
      return result.canceled || !result.filePath ? null : result.filePath;
    }
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose folder for PNG sequence',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled || result.filePaths.length === 0 ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.exportStart, (_event, rawConfig: unknown) =>
    startExport(rawConfig, getWindow),
  );
  ipcMain.handle(IPC.exportFrame, (_event, sessionId: unknown, frame: unknown) =>
    writeExportFrame(sessionId, frame, getWindow),
  );
  ipcMain.handle(IPC.exportFinish, (_event, sessionId: unknown) =>
    finishExport(sessionId, getWindow),
  );
  ipcMain.handle(IPC.exportCancel, (_event, sessionId: unknown) => cancelExport(sessionId));

  /**
   * LIVE ENGINE (Phase 17). macOS App Nap suspends an app's timers once it
   * is hidden/occluded and looks idle, throttling requestAnimationFrame to
   * ~1 Hz. Chromium's own `backgroundThrottling: false` does not cover it —
   * the throttling happens below Chromium, and `document.visibilityState`
   * still reports "visible". Measured: once App Nap engages, starting
   * playback does NOT recover the frame rate, while the audio clock keeps
   * perfect time — output freezes under a running track.
   *
   * `prevent-app-suspension` is the documented inhibitor. It is held only
   * while playback runs, so an idle editor still naps normally.
   */
  const applyLiveness = (reason: LivenessReason, active: boolean): boolean => {
    const shouldBlock = reduceLiveness(livenessReasons, reason, active);
    if (shouldBlock) {
      if (liveEngineBlockerId === null || !powerSaveBlocker.isStarted(liveEngineBlockerId)) {
        liveEngineBlockerId = powerSaveBlocker.start('prevent-app-suspension');
      }
    } else if (liveEngineBlockerId !== null && powerSaveBlocker.isStarted(liveEngineBlockerId)) {
      powerSaveBlocker.stop(liveEngineBlockerId);
      liveEngineBlockerId = null;
    }
    return liveEngineBlockerId !== null;
  };

  ipcMain.handle(IPC.setLiveness, (_event, rawReason: unknown, rawActive: unknown) => {
    // Refcounted reason set (Phase 18A): transport is one of several
    // realtime requirements in v0.3 — see shared/liveness.ts.
    if (!isLivenessReason(rawReason)) return liveEngineBlockerId !== null;
    return applyLiveness(rawReason, rawActive === true);
  });

  // ---- Output window (18B) / Display destination (18C) -------------------
  configureOutputWindow({
    setLiveness: (reason, active) => void applyLiveness(reason, active),
    notifyEditor: (status) => {
      getWindow()?.webContents.send(IPC.outputStatus, status);
    },
    notifyDisplays: (displays) => {
      getWindow()?.webContents.send(IPC.outputDisplayList, displays);
    },
  });
  startDisplayWatch();

  // The remembered target is machine setup, not creative state: it lives in
  // app settings and is applied lazily on first use.
  let targetLoaded = false;
  const loadTarget = async () => {
    if (targetLoaded) return;
    targetLoaded = true;
    const settings = await readSettings();
    setOutputTarget(settings.lastOutputDisplayId, settings.lastOutputMode);
  };

  const rememberTarget = () => {
    const { displayId, mode } = outputTarget();
    void updateSettings({ lastOutputDisplayId: displayId, lastOutputMode: mode });
  };

  ipcMain.handle(IPC.outputOpen, async (_event, rawOptions: unknown) => {
    await loadTarget();
    const options = outputOpenOptionsSchema.parse(rawOptions ?? {});
    const opened = openOutputWindow(getWindow, options);
    if (opened) rememberTarget();
    return opened;
  });
  ipcMain.handle(IPC.outputClose, () => closeOutputWindow());
  ipcMain.handle(IPC.outputDisplays, () => listDisplays());
  ipcMain.handle(IPC.outputMove, (_event, rawId: unknown, rawMode: unknown) => {
    const displayId = rawId === null || rawId === undefined ? null : z.number().parse(rawId);
    const mode = rawMode === undefined ? undefined : outputModeSchema.parse(rawMode);
    const moved = moveOutputWindow(displayId, mode);
    if (moved) rememberTarget();
    else {
      // Not open yet: remember the choice so the next open uses it.
      setOutputTarget(displayId, mode ?? outputTarget().mode);
      rememberTarget();
    }
    return moved;
  });
  ipcMain.handle(IPC.outputSetMode, (_event, rawMode: unknown) => {
    const mode = outputModeSchema.parse(rawMode);
    const applied = setOutputMode(mode);
    if (!applied) setOutputTarget(outputTarget().displayId, mode);
    rememberTarget();
    return applied;
  });
  // Dock icon follows the project seed (brand fingerprint). macOS only;
  // the 9 variants are pregenerated by scripts/generate-icons.mjs.
  let dockIconPosition = -1;
  ipcMain.handle(IPC.brandDockIcon, (_event, rawPosition: unknown) => {
    const position = z.number().int().min(0).max(8).parse(rawPosition);
    if (process.platform !== 'darwin' || !app.dock) return;
    if (position === dockIconPosition) return;
    dockIconPosition = position;
    const file = app.isPackaged
      ? path.join(process.resourcesPath, 'dock', `pos-${position}.png`)
      : path.join(app.getAppPath(), 'build', 'dock', `pos-${position}.png`);
    try {
      app.dock.setIcon(file);
    } catch (error) {
      // A missing variant must never break anything user-facing.
      console.warn('[brand] dock icon failed:', error);
    }
  });

  // Escape on the output window drops fullscreen back to windowed rather
  // than closing anything — never quits, never disturbs the editor.
  ipcMain.on(IPC.outputEscape, () => {
    if (outputTarget().mode === 'fullscreen') setOutputMode('windowed');
  });
  ipcMain.handle(IPC.outputTarget, async () => {
    await loadTarget();
    return outputTarget();
  });

  ipcMain.handle(IPC.sessionId, () => SESSION_ID);
  ipcMain.handle(IPC.recoveryWrite, async (_event, rawPath: unknown, rawProject: unknown) => {
    const projectPath = rawPath === null ? null : pathArgSchema.parse(rawPath);
    await writeRecovery(SESSION_ID, projectPath, rawProject);
  });
  ipcMain.handle(IPC.recoveryList, () => listRecoveries(SESSION_ID));
  ipcMain.handle(IPC.recoveryClear, () => clearRecovery(SESSION_ID));
  ipcMain.handle(IPC.recoveryDiscard, (_event, rawId: unknown) =>
    // Not `.uuid()`: whatever listRecoveries handed the renderer must be
    // discardable, or a stale entry becomes an undismissable prompt. The
    // real requirement is path safety — no separators, no traversal.
    discardRecovery(
      z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9_-]+$/, 'Invalid recovery id')
        .parse(rawId),
    ),
  );

  ipcMain.handle(IPC.listPresets, async () => listUserPresets());
  ipcMain.handle(IPC.savePreset, async (_event, rawPreset: unknown) => saveUserPreset(rawPreset));
  ipcMain.handle(IPC.deletePreset, async (_event, rawId: unknown) =>
    deleteUserPreset(pathArgSchema.parse(rawId)),
  );

  ipcMain.handle(IPC.openProjectDialog, async (): Promise<string | null> => {
    const win = getWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      title: 'Open Project',
      properties: ['openFile'],
      filters: [{ name: 'MATERIAL Project', extensions: [PROJECT_EXTENSION] }],
    });
    return result.canceled || result.filePaths.length === 0 ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(
    IPC.saveProjectDialog,
    async (_event, rawName: unknown): Promise<string | null> => {
      const win = getWindow();
      if (!win) return null;
      const defaultName = sanitizeDefaultName(nameArgSchema.parse(rawName));
      const result = await dialog.showSaveDialog(win, {
        title: 'Save Project',
        defaultPath: `${defaultName}.${PROJECT_EXTENSION}`,
        filters: [{ name: 'MATERIAL Project', extensions: [PROJECT_EXTENSION] }],
      });
      return result.canceled || !result.filePath ? null : result.filePath;
    },
  );

  ipcMain.handle(
    IPC.savePngDialog,
    async (_event, rawBase64: unknown, rawName: unknown): Promise<string | null> => {
      const win = getWindow();
      if (!win) return null;
      const base64 = base64Schema.parse(rawBase64);
      const defaultName = sanitizeDefaultName(nameArgSchema.parse(rawName));
      const result = await dialog.showSaveDialog(win, {
        title: 'Export PNG',
        defaultPath: `${defaultName}.png`,
        filters: [{ name: 'PNG Image', extensions: ['png'] }],
      });
      if (result.canceled || !result.filePath) return null;
      const buffer = Buffer.from(base64, 'base64');
      // PNG signature check — refuse to write arbitrary bytes from the renderer.
      const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      if (buffer.length < 8 || !buffer.subarray(0, 4).equals(PNG_MAGIC)) {
        throw new Error('Export payload is not a valid PNG');
      }
      const outPath = result.filePath.endsWith('.png') ? result.filePath : `${result.filePath}.png`;
      await fs.writeFile(outPath, buffer);
      return path.normalize(outPath);
    },
  );
}

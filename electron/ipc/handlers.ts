import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
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

const pathArgSchema = z.string().min(1);
const nameArgSchema = z.string().min(1).max(255);
const base64Schema = z.string().min(1);
// Reject path separators and hidden-file prefixes in user-facing default names.
function sanitizeDefaultName(name: string): string {
  return name.replace(/[/\\:]/g, '-').replace(/^\.+/, '');
}

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.appInfo, async (): Promise<AppInfo> => {
    return {
      version: app.getVersion(),
      electron: process.versions.electron ?? 'unknown',
      platform: process.platform,
      ffmpegAvailable: ffmpegPath !== null,
      ffprobeAvailable: ffprobePath !== null,
      availableEncoders: await detectEncoders(),
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
    const format = z.enum(['png-sequence', 'h264']).parse(rawFormat);
    const defaultName = sanitizeDefaultName(nameArgSchema.parse(rawName));
    if (format === 'h264') {
      const result = await dialog.showSaveDialog(win, {
        title: 'Export H.264',
        defaultPath: `${defaultName}.mp4`,
        filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
      });
      return result.canceled || !result.filePath ? null : result.filePath;
    }
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose folder for PNG sequence',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled || result.filePaths.length === 0 ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.exportStart, (_event, rawConfig: unknown) => startExport(rawConfig, getWindow));
  ipcMain.handle(IPC.exportFrame, (_event, sessionId: unknown, frame: unknown) =>
    writeExportFrame(sessionId, frame, getWindow),
  );
  ipcMain.handle(IPC.exportFinish, (_event, sessionId: unknown) =>
    finishExport(sessionId, getWindow),
  );
  ipcMain.handle(IPC.exportCancel, (_event, sessionId: unknown) => cancelExport(sessionId));

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

  ipcMain.handle(IPC.saveProjectDialog, async (_event, rawName: unknown): Promise<string | null> => {
    const win = getWindow();
    if (!win) return null;
    const defaultName = sanitizeDefaultName(nameArgSchema.parse(rawName));
    const result = await dialog.showSaveDialog(win, {
      title: 'Save Project',
      defaultPath: `${defaultName}.${PROJECT_EXTENSION}`,
      filters: [{ name: 'MATERIAL Project', extensions: [PROJECT_EXTENSION] }],
    });
    return result.canceled || !result.filePath ? null : result.filePath;
  });

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

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC, type ExportProgressEvent, type MaterialApi, type MenuEventId } from '../../shared/ipc';

const api: MaterialApi & { getPathForFile(file: File): string } = {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  openMediaDialog: () => ipcRenderer.invoke(IPC.openMediaDialog),
  probeMedia: (path) => ipcRenderer.invoke(IPC.probeMedia, path),
  readProject: (path) => ipcRenderer.invoke(IPC.readProject, path),
  writeProject: (path, project) => ipcRenderer.invoke(IPC.writeProject, path, project),
  openProjectDialog: () => ipcRenderer.invoke(IPC.openProjectDialog),
  saveProjectDialog: (defaultName) => ipcRenderer.invoke(IPC.saveProjectDialog, defaultName),
  savePngDialog: (base64Png, defaultName) =>
    ipcRenderer.invoke(IPC.savePngDialog, base64Png, defaultName),
  readSvg: (path) => ipcRenderer.invoke(IPC.readSvg, path),
  listPresets: () => ipcRenderer.invoke(IPC.listPresets),
  savePreset: (preset) => ipcRenderer.invoke(IPC.savePreset, preset),
  deletePreset: (id) => ipcRenderer.invoke(IPC.deletePreset, id),
  exportSaveDialog: (format, defaultName) =>
    ipcRenderer.invoke(IPC.exportSaveDialog, format, defaultName),
  exportStart: (config) => ipcRenderer.invoke(IPC.exportStart, config),
  exportFrame: (sessionId, rgba) => ipcRenderer.invoke(IPC.exportFrame, sessionId, rgba),
  exportFinish: (sessionId) => ipcRenderer.invoke(IPC.exportFinish, sessionId),
  exportCancel: (sessionId) => ipcRenderer.invoke(IPC.exportCancel, sessionId),
  onExportProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, data: ExportProgressEvent) =>
      callback(data);
    ipcRenderer.on(IPC.exportProgress, listener);
    return () => ipcRenderer.removeListener(IPC.exportProgress, listener);
  },
  setLiveEngine: (active) => ipcRenderer.invoke(IPC.setLiveEngine, active),
  getSessionId: () => ipcRenderer.invoke(IPC.sessionId),
  writeRecovery: (projectPath, project) =>
    ipcRenderer.invoke(IPC.recoveryWrite, projectPath, project),
  listRecoveries: () => ipcRenderer.invoke(IPC.recoveryList),
  clearRecovery: () => ipcRenderer.invoke(IPC.recoveryClear),
  discardRecovery: (sessionId) => ipcRenderer.invoke(IPC.recoveryDiscard, sessionId),
  onMenuEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, id: MenuEventId) => callback(id);
    ipcRenderer.on(IPC.menuEvent, listener);
    return () => ipcRenderer.removeListener(IPC.menuEvent, listener);
  },
  /** Resolve the absolute path of a File dropped onto the window (sandbox-safe). */
  getPathForFile: (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('material', api);

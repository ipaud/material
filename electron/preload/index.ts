import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC, type MaterialApi, type MenuEventId } from '../../shared/ipc';

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
  onMenuEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, id: MenuEventId) => callback(id);
    ipcRenderer.on(IPC.menuEvent, listener);
    return () => ipcRenderer.removeListener(IPC.menuEvent, listener);
  },
  /** Resolve the absolute path of a File dropped onto the window (sandbox-safe). */
  getPathForFile: (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('material', api);

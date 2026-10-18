import { contextBridge, ipcRenderer, webUtils } from 'electron';

// MessagePorts cannot pass through the contextBridge — forward them to the
// main world via window.postMessage (the documented Electron pattern).

// Preloads are typed under the node tsconfig (no DOM lib), but run in the
// renderer with a real window. Narrow, explicit escape hatch:
const rendererWindow = globalThis as unknown as {
  postMessage(message: unknown, targetOrigin: string, transfer?: unknown[]): void;
};
ipcRenderer.on('output:runtime-port', (event) => {
  rendererWindow.postMessage({ type: 'material:output-port' }, '*', event.ports);
});
import {
  IPC,
  type ExportProgressEvent,
  type MaterialApi,
  type MenuEventId,
} from '../../shared/ipc';

const api: MaterialApi & { getPathForFile(file: File): string } = {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  openMediaDialog: () => ipcRenderer.invoke(IPC.openMediaDialog),
  probeMedia: (path) => ipcRenderer.invoke(IPC.probeMedia, path),
  showInFinder: (path) => ipcRenderer.invoke(IPC.showInFinder, path),
  findProxy: (path) => ipcRenderer.invoke(IPC.findProxy, path),
  createProxy: (path) => ipcRenderer.invoke(IPC.createProxy, path),
  readProject: (path, repair) => ipcRenderer.invoke(IPC.readProject, path, repair),
  writeProject: (path, project) => ipcRenderer.invoke(IPC.writeProject, path, project),
  pickMediaFolder: () => ipcRenderer.invoke(IPC.pickMediaFolder),
  collectMedia: (projectPath, sourcePaths) =>
    ipcRenderer.invoke(IPC.collectMedia, projectPath, sourcePaths),
  openProjectDialog: () => ipcRenderer.invoke(IPC.openProjectDialog),
  saveProjectDialog: (defaultName) => ipcRenderer.invoke(IPC.saveProjectDialog, defaultName),
  savePngDialog: (base64Png, defaultName) =>
    ipcRenderer.invoke(IPC.savePngDialog, base64Png, defaultName),
  readSvg: (path) => ipcRenderer.invoke(IPC.readSvg, path),
  // v0.5B: pack DATA in, pack DATA out. No path, no handle, no fs.
  listShaderPacks: () => ipcRenderer.invoke(IPC.shaderPacksList),
  importShaderPack: () => ipcRenderer.invoke(IPC.shaderPackImport),
  removeShaderPack: (id) => ipcRenderer.invoke(IPC.shaderPackRemove, id),
  shaderPacksRoot: () => ipcRenderer.invoke(IPC.shaderPacksRoot),
  importIsfShader: () => ipcRenderer.invoke(IPC.shaderIsfImport),
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
  setLiveness: (reason, active) => ipcRenderer.invoke(IPC.setLiveness, reason, active),
  outputOpen: (options?: unknown) => ipcRenderer.invoke(IPC.outputOpen, options),
  outputClose: () => ipcRenderer.invoke(IPC.outputClose),
  outputDisplays: () => ipcRenderer.invoke(IPC.outputDisplays),
  onOutputDisplays: (callback) => {
    ipcRenderer.on(IPC.outputDisplayList, (_event, displays) => callback(displays));
  },
  outputMove: (displayId: number | null, mode?: unknown) =>
    ipcRenderer.invoke(IPC.outputMove, displayId, mode),
  outputSetMode: (mode: unknown) => ipcRenderer.invoke(IPC.outputSetMode, mode),
  outputTarget: () => ipcRenderer.invoke(IPC.outputTarget),
  setDockIcon: (position: number) => ipcRenderer.invoke(IPC.brandDockIcon, position),
  setCameraIntent: (active: boolean) => ipcRenderer.invoke(IPC.cameraIntent, active === true),
  setCaptureIntent: (target) => ipcRenderer.invoke(IPC.captureIntent, target),
  listCaptureWindows: () => ipcRenderer.invoke(IPC.captureListWindows),
  onOutputStatus: (callback) => {
    ipcRenderer.on(IPC.outputStatus, (_event, status) => callback(status));
  },

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

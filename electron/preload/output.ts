import { contextBridge, ipcRenderer } from 'electron';

/**
 * Output-window preload (Phase 18B). Deliberately minimal: the replica needs
 * exactly one thing from the platform — the runtime MessagePort handed over
 * by the main-process broker. No filesystem, no project access,
 * no MIDI, no export. See docs/LIVE_OUTPUT_ARCHITECTURE.md §9.
 */
// MessagePorts cannot pass through the contextBridge — forward to the main
// world via window.postMessage (the documented Electron pattern).

// Preloads are typed under the node tsconfig (no DOM lib), but run in the
// renderer with a real window. Narrow, explicit escape hatch:
const rendererWindow = globalThis as unknown as {
  postMessage(message: unknown, targetOrigin: string, transfer?: unknown[]): void;
};
ipcRenderer.on('output:runtime-port', (event) => {
  rendererWindow.postMessage({ type: 'material:runtime-port' }, '*', event.ports);
});

contextBridge.exposeInMainWorld('materialOutput', {
  /** Marker only — the replica listens for the window message itself. */
  ready: true,
});

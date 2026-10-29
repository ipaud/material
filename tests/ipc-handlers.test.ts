// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../shared/ipc';
import type * as Handlers from '../electron/ipc/handlers';

/**
 * The renderer → main boundary. Each handler is the only thing standing between page script and the
 * file system, the screen or the power manager, so these tests send it what a compromised or buggy
 * renderer could: relative paths, unimported files, path tricks in names, non-PNG bytes, malformed
 * capture targets. The modules behind the handlers are faked; the handlers' own checks are real.
 */

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const m = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  started: new Set<number>(),
  nextBlocker: 1,
  saveDialog: vi.fn(),
  openDialog: vi.fn(),
  showItemInFolder: vi.fn(),
  addRecentDocument: vi.fn(),
  getSources: vi.fn(),
  setDockIcon: vi.fn(),
  send: vi.fn(),
  outputTarget: { displayId: null as number | null, mode: 'windowed' as 'windowed' | 'fullscreen' },
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.9.4',
    getPath: () => '/tmp/material-user',
    getAppPath: () => '/app',
    isPackaged: false,
    addRecentDocument: m.addRecentDocument,
    dock: { setIcon: m.setDockIcon },
  },
  ipcMain: {
    handle: (channel: string, fn: Handler) => m.handlers.set(channel, fn),
    on: (channel: string, fn: Handler) => m.listeners.set(channel, fn),
  },
  dialog: { showSaveDialog: m.saveDialog, showOpenDialog: m.openDialog },
  shell: { showItemInFolder: m.showItemInFolder },
  desktopCapturer: { getSources: m.getSources },
  powerSaveBlocker: {
    start: () => {
      const id = m.nextBlocker++;
      m.started.add(id);
      return id;
    },
    stop: (id: number) => m.started.delete(id),
    isStarted: (id: number) => m.started.has(id),
  },
}));
vi.mock('../electron/main/displays', () => ({ listDisplays: vi.fn(() => []) }));
vi.mock('../electron/filesystem/settings', () => ({
  readSettings: vi.fn(async () => ({ lastOutputDisplayId: 7, lastOutputMode: 'fullscreen' })),
  updateSettings: vi.fn(async () => ({})),
}));
vi.mock('../electron/main/outputWindow', () => ({
  configureOutputWindow: vi.fn(),
  startDisplayWatch: vi.fn(),
  openOutputWindow: vi.fn(() => true),
  closeOutputWindow: vi.fn(),
  moveOutputWindow: vi.fn(() => false),
  setOutputMode: vi.fn(() => false),
  outputTarget: vi.fn(() => ({ ...m.outputTarget })),
  setOutputTarget: vi.fn((displayId: number | null, mode: 'windowed' | 'fullscreen') => {
    m.outputTarget = { displayId, mode };
  }),
}));
vi.mock('../electron/filesystem/shaderPacks', () => ({}));
vi.mock('../electron/media/ffmpeg', () => ({ detectEncoders: vi.fn(async () => []), ffmpegPath: '/ffmpeg', ffprobePath: null }));
vi.mock('../electron/media/probe', () => ({ probeMedia: vi.fn() }));
vi.mock('../electron/media/proxy', () => ({ createProxy: vi.fn(), findProxy: vi.fn() }));
vi.mock('../electron/media/svg', () => ({ readSanitizedSvg: vi.fn(async () => '<svg/>') }));
vi.mock('../electron/filesystem/projects', () => ({
  readProjectFile: vi.fn(async (p: string) => (p.endsWith('broken.material') ? { ok: false, error: 'bad' } : { ok: true, project: {} })),
  writeProjectFile: vi.fn(),
}));
vi.mock('../electron/filesystem/mediaFolder', () => ({ collectMediaBeside: vi.fn(), scanFolderForMedia: vi.fn() }));
vi.mock('../electron/filesystem/presets', () => ({ deleteUserPreset: vi.fn(), listUserPresets: vi.fn(), saveUserPreset: vi.fn() }));
vi.mock('../electron/filesystem/mediaRegistry', () => ({ isApprovedMediaPath: (p: string) => p === '/media/imported.svg' }));
vi.mock('../electron/export/encoder', () => ({ cancelExport: vi.fn(), finishExport: vi.fn(), startExport: vi.fn(), writeExportFrame: vi.fn() }));
vi.mock('../electron/filesystem/recovery', () => ({
  clearRecovery: vi.fn(),
  discardRecovery: vi.fn(),
  listRecoveries: vi.fn(),
  writeRecovery: vi.fn(),
}));

const win = { webContents: { send: m.send } };
let mod: typeof Handlers;

// Like ipcRenderer.invoke: a handler that throws, sync or async, rejects the call.
const call = async (channel: string, ...args: unknown[]) => {
  const fn = m.handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn({}, ...args);
};

beforeEach(async () => {
  m.handlers.clear();
  m.listeners.clear();
  m.started.clear();
  m.outputTarget = { displayId: null, mode: 'windowed' };
  vi.resetModules();
  mod = await import('../electron/ipc/handlers');
  mod.registerIpcHandlers(() => win as never);
});

afterEach(() => vi.clearAllMocks());

describe('paths from the renderer', () => {
  it('only reveals absolute paths in Finder', async () => {
    await expect(call(IPC.showInFinder, 'relative/file.mov')).rejects.toThrow('Path must be absolute');
    await expect(call(IPC.showInFinder, '')).rejects.toThrow();
    await call(IPC.showInFinder, '/Users/me/clip.mov');
    expect(m.showItemInFolder).toHaveBeenCalledWith('/Users/me/clip.mov');
  });

  it('reads an SVG only after the user imported it', async () => {
    await expect(call(IPC.readSvg, '/etc/anything.svg')).rejects.toThrow('SVG has not been imported');
    await expect(call(IPC.readSvg, '/media/imported.svg')).resolves.toBe('<svg/>');
  });

  it('adds a project to Recent only when it opened', async () => {
    const ok = await call(IPC.readProject, '/p/good.material', false);
    expect(ok).toMatchObject({ ok: true, path: '/p/good.material' });
    await call(IPC.readProject, '/p/broken.material', false);
    expect(m.addRecentDocument.mock.calls).toEqual([['/p/good.material']]);
  });

  it('accepts only path-safe recovery ids', async () => {
    const { discardRecovery } = await import('../electron/filesystem/recovery');
    for (const bad of ['../../etc', 'a/b', '', 'x'.repeat(129), 'id with space']) {
      await expect(call(IPC.recoveryDiscard, bad)).rejects.toThrow();
    }
    await call(IPC.recoveryDiscard, '3f2a-legacy_id');
    expect(discardRecovery).toHaveBeenCalledExactlyOnceWith('3f2a-legacy_id');
  });
});

describe('save dialogs', () => {
  it('strips separators and leading dots from the suggested name', async () => {
    m.saveDialog.mockResolvedValue({ canceled: true });
    await call(IPC.saveProjectDialog, '../.hidden/a:b\\c');
    expect(m.saveDialog.mock.calls[0]![1].defaultPath).toBe('-.hidden-a-b-c.material');
    await call(IPC.saveProjectDialog, '..secret');
    expect(m.saveDialog.mock.calls[1]![1].defaultPath).toBe('secret.material');
  });

  it('picks the container from the export format, and a folder for PNG sequences', async () => {
    m.saveDialog.mockResolvedValue({ canceled: false, filePath: '/out/clip.mov' });
    await expect(call(IPC.exportSaveDialog, 'prores4444', 'clip')).resolves.toBe('/out/clip.mov');
    expect(m.saveDialog.mock.calls[0]![1]).toMatchObject({ title: 'Export ProRes', defaultPath: 'clip.mov' });

    await call(IPC.exportSaveDialog, 'h264', 'clip');
    expect(m.saveDialog.mock.calls[1]![1]).toMatchObject({ title: 'Export H.264', defaultPath: 'clip.mp4' });

    m.openDialog.mockResolvedValue({ canceled: false, filePaths: ['/out/frames'] });
    await expect(call(IPC.exportSaveDialog, 'png-sequence', 'clip')).resolves.toBe('/out/frames');
    await expect(call(IPC.exportSaveDialog, 'gif', 'clip')).rejects.toThrow();
  });

  it('writes a PNG still only when the bytes are a PNG', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'material-png-'));
    try {
      m.saveDialog.mockResolvedValue({ canceled: false, filePath: join(dir, 'still') });
      const notPng = Buffer.from('#!/bin/sh\necho owned\n').toString('base64');
      await expect(call(IPC.savePngDialog, notPng, 'still')).rejects.toThrow('not a valid PNG');

      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
      const written = await call(IPC.savePngDialog, png.toString('base64'), 'still');
      expect(written).toBe(join(dir, 'still.png'));
      expect(readFileSync(join(dir, 'still.png'))).toEqual(png);

      m.saveDialog.mockResolvedValue({ canceled: true });
      await expect(call(IPC.savePngDialog, png.toString('base64'), 'still')).resolves.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without a window there is nothing to attach a dialog to', async () => {
    m.handlers.clear();
    mod.registerIpcHandlers(() => null);
    await expect(call(IPC.openMediaDialog)).resolves.toEqual([]);
    await expect(call(IPC.openProjectDialog)).resolves.toBeNull();
    await expect(call(IPC.saveProjectDialog, 'x')).resolves.toBeNull();
    await expect(call(IPC.pickMediaFolder)).resolves.toBeNull();
    expect(m.openDialog).not.toHaveBeenCalled();
    expect(m.saveDialog).not.toHaveBeenCalled();
  });
});

describe('screen and window capture gate', () => {
  it('arms only well-formed targets and disarms on anything else', async () => {
    await call(IPC.captureIntent, { kind: 'screen', displayId: 2 });
    expect(mod.captureIntentTarget()).toEqual({ kind: 'screen', displayId: 2 });

    await call(IPC.captureIntent, { kind: 'screen', displayId: 'main' });
    expect(mod.captureIntentTarget()).toEqual({ kind: 'screen', displayId: null });

    await call(IPC.captureIntent, { kind: 'window', sourceId: 'window:1234:0' });
    expect(mod.captureIntentTarget()).toEqual({ kind: 'window', sourceId: 'window:1234:0' });

    mod.recordGrantedCapture('window', 'window:1234:0');
    await call(IPC.captureIntent, { kind: 'window', sourceId: 'screen:0:0' });
    expect(mod.captureIntentTarget()).toBeNull();
    expect(mod.grantedCaptureSource()).toBeNull();

    mod.recordGrantedCapture('screen', 'screen:1:0');
    await call(IPC.captureIntent, null);
    expect(mod.grantedCaptureSource()).toBeNull();
  });

  it('lists windows by title only, skipping untitled ones', async () => {
    m.getSources.mockResolvedValue([
      { id: 'window:1:0', name: 'Notes' },
      { id: 'window:2:0', name: '   ' },
    ]);
    await expect(call(IPC.captureListWindows)).resolves.toEqual([{ sourceId: 'window:1:0', title: 'Notes' }]);
    expect(m.getSources.mock.calls[0]![0]).toMatchObject({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
  });

  it('the camera gate is on only for an explicit true', async () => {
    await call(IPC.cameraIntent, 'yes');
    expect(mod.cameraIntentArmed()).toBe(false);
    await call(IPC.cameraIntent, true);
    expect(mod.cameraIntentArmed()).toBe(true);
  });
});

describe('keeping the engine awake', () => {
  it('holds one blocker while any reason is active and releases it after the last one', async () => {
    await expect(call(IPC.setLiveness, 'transport', true)).resolves.toBe(true);
    await expect(call(IPC.setLiveness, 'output-window', true)).resolves.toBe(true);
    expect(m.started.size).toBe(1);

    await expect(call(IPC.setLiveness, 'transport', false)).resolves.toBe(true);
    await expect(call(IPC.setLiveness, 'output-window', false)).resolves.toBe(false);
    expect(m.started.size).toBe(0);
  });

  it('ignores unknown reasons', async () => {
    await expect(call(IPC.setLiveness, 'mining', true)).resolves.toBe(false);
    expect(m.started.size).toBe(0);
  });

  it('reports the state in app info', async () => {
    await call(IPC.setLiveness, 'transport', true);
    await expect(call(IPC.appInfo)).resolves.toMatchObject({ version: '0.9.4', ffmpegAvailable: true, ffprobeAvailable: false, livenessActive: true });
  });
});

describe('output window target', () => {
  it('loads the remembered display once and saves what the user picks', async () => {
    const { updateSettings, readSettings } = await import('../electron/filesystem/settings');
    await expect(call(IPC.outputTarget)).resolves.toEqual({ displayId: 7, mode: 'fullscreen' });
    await call(IPC.outputTarget);
    expect(readSettings).toHaveBeenCalledOnce();

    // not open: the choice is remembered for the next open
    await expect(call(IPC.outputMove, 3, 'windowed')).resolves.toBe(false);
    expect(updateSettings).toHaveBeenLastCalledWith({ lastOutputDisplayId: 3, lastOutputMode: 'windowed' });

    await call(IPC.outputSetMode, 'fullscreen');
    expect(updateSettings).toHaveBeenLastCalledWith({ lastOutputDisplayId: 3, lastOutputMode: 'fullscreen' });
    await expect(call(IPC.outputSetMode, 'kiosk')).rejects.toThrow();
    await expect(call(IPC.outputMove, '3')).rejects.toThrow();
  });

  it('Escape on the output only drops fullscreen', async () => {
    const { setOutputMode } = await import('../electron/main/outputWindow');
    m.listeners.get(IPC.outputEscape)!({});
    expect(setOutputMode).not.toHaveBeenCalled();
    m.outputTarget.mode = 'fullscreen';
    m.listeners.get(IPC.outputEscape)!({});
    expect(setOutputMode).toHaveBeenCalledWith('windowed');
  });
});

describe('dock icon', () => {
  it('takes only the nine grid positions and does not reload the same one', async () => {
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      await expect(call(IPC.brandDockIcon, 9)).rejects.toThrow();
      await expect(call(IPC.brandDockIcon, 1.5)).rejects.toThrow();
      await call(IPC.brandDockIcon, 4);
      await call(IPC.brandDockIcon, 4);
      expect(m.setDockIcon).toHaveBeenCalledExactlyOnceWith(join('/app', 'build', 'dock', 'pos-4.png'));
    } finally {
      Object.defineProperty(process, 'platform', { value: platform });
    }
  });
});

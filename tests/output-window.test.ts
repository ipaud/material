// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DisplayInfo } from '../shared/display';
import type * as OutputWindow from '../electron/main/outputWindow';

/**
 * The Output window's native behaviour, with simulated displays: one window at most, opened on the
 * chosen monitor without flashing on the primary, borderless fullscreen that fills the panel, moving
 * between displays, and what happens when a projector is unplugged or the renderer dies. This is
 * the second-display behaviour that cannot be checked on a one-monitor machine.
 */

const h = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  class FakeWebContents extends EventEmitter {
    mainFrame = { processId: 7, routingId: 3 };
    postMessage = vi.fn();
  }
  class FakeWindow extends EventEmitter {
    static all: FakeWindow[] = [];
    destroyed = false;
    webContents = new FakeWebContents();
    bounds: { x: number; y: number; width: number; height: number };
    setBounds = vi.fn((b: FakeWindow['bounds']) => {
      this.bounds = b;
    });
    getBounds = () => this.bounds;
    setSimpleFullScreen = vi.fn();
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    showInactive = vi.fn();
    loadFile = vi.fn(async () => undefined);
    loadURL = vi.fn(async () => undefined);
    constructor(readonly options: { x: number; y: number; width: number; height: number; show: boolean; webPreferences: Record<string, unknown> }) {
      super();
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      FakeWindow.all.push(this);
    }
    isDestroyed = () => this.destroyed;
    destroy = () => {
      this.destroyed = true;
      this.emit('closed');
    };
    close = () => this.destroy();
  }
  return {
    FakeWindow,
    displays: [] as DisplayInfo[],
    onDisplaysChanged: null as null | (() => void),
  };
});

vi.mock('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: h.FakeWindow,
  MessageChannelMain: class {
    port1 = { id: 'editor-port' };
    port2 = { id: 'output-port' };
  },
}));
vi.mock('../electron/main/displays', () => ({
  listDisplays: () => h.displays,
  watchDisplays: (cb: () => void) => {
    h.onDisplaysChanged = cb;
    return () => {
      h.onDisplaysChanged = null;
    };
  },
}));

const display = (id: number, x: number, primary = false): DisplayInfo => ({
  id,
  label: primary ? 'Built-in' : `Projector ${id}`,
  bounds: { x, y: 0, width: 1920, height: 1080 },
  workArea: { x, y: 25, width: 1920, height: 1055 },
  scaleFactor: primary ? 2 : 1,
  rotation: 0,
  primary,
  internal: primary,
});

let out: typeof OutputWindow;
const editor = { webContents: { postMessage: vi.fn() }, focus: vi.fn() };
const deps = { setLiveness: vi.fn(), notifyEditor: vi.fn(), notifyDisplays: vi.fn() };
const win = () => h.FakeWindow.all.at(-1)!;
const lastStatus = () => deps.notifyEditor.mock.calls.at(-1)?.[0];

function ready(w = win()) {
  w.emit('ready-to-show');
  w.webContents.emit('did-finish-load');
}

beforeEach(async () => {
  h.FakeWindow.all.length = 0;
  h.displays = [display(1, 0, true), display(2, 1920)];
  vi.resetModules();
  out = await import('../electron/main/outputWindow');
  out.configureOutputWindow(deps);
  out.startDisplayWatch();
});

afterEach(() => {
  out.stopDisplayWatch();
  vi.clearAllMocks();
});

describe('opening', () => {
  it('opens one hidden borderless window on the chosen display, then fills it without stealing focus', () => {
    expect(out.openOutputWindow(() => editor as never, { displayId: 2, mode: 'fullscreen' })).toBe(true);
    const w = win();
    expect(w.options.show).toBe(false);
    expect(w.options.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true });
    expect(w.bounds.x).toBeGreaterThanOrEqual(1920); // constructed on display 2, not the primary

    ready(w);
    expect(w.showInactive).toHaveBeenCalled();
    expect(w.setSimpleFullScreen).toHaveBeenLastCalledWith(true);
    expect(w.setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'screen-saver');
    expect(editor.focus).toHaveBeenCalled();
    expect(editor.webContents.postMessage).toHaveBeenCalledWith('output:runtime-port', null, [{ id: 'editor-port' }]);
    expect(w.webContents.postMessage).toHaveBeenCalledWith('output:runtime-port', null, [{ id: 'output-port' }]);
    expect(deps.setLiveness).toHaveBeenCalledWith('output-window', true);
    expect(lastStatus()).toEqual({ state: 'open', mode: 'fullscreen', bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, displayId: 2, scaleFactor: 1 });
  });

  it('opening again moves the same window instead of making a second one', () => {
    out.openOutputWindow(() => editor as never, { displayId: 2 });
    ready();
    expect(out.openOutputWindow(() => editor as never, { displayId: 1, mode: 'windowed' })).toBe(true);
    expect(h.FakeWindow.all).toHaveLength(1);
    expect(out.outputTarget()).toEqual({ displayId: 1, mode: 'windowed' });
    expect(win().setSimpleFullScreen).toHaveBeenLastCalledWith(false);
    expect(lastStatus()).toMatchObject({ state: 'open', mode: 'windowed', displayId: 1 });
  });

  it('a display id that no longer exists falls back to a connected one', () => {
    out.setOutputTarget(99, 'windowed');
    out.openOutputWindow(() => editor as never);
    expect(out.outputTarget().displayId).not.toBe(99);
  });

  it('without an editor or any display there is nothing to open', () => {
    expect(out.openOutputWindow(() => null)).toBe(false);
    h.displays = [];
    expect(out.openOutputWindow(() => editor as never)).toBe(false);
    expect(lastStatus()).toMatchObject({ state: 'error' });
    expect(h.FakeWindow.all).toHaveLength(0);
  });
});

describe('moving and modes', () => {
  it('windowed mode releases the raised level and the all-Spaces flag', () => {
    out.openOutputWindow(() => editor as never, { displayId: 2, mode: 'fullscreen' });
    ready();
    expect(out.setOutputMode('windowed')).toBe(true);
    expect(win().setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    expect(win().setVisibleOnAllWorkspaces).toHaveBeenLastCalledWith(false);
  });

  it('nothing to move while closed', () => {
    expect(out.moveOutputWindow(2)).toBe(false);
    expect(out.setOutputMode('fullscreen')).toBe(false);
  });
});

describe('when things go away', () => {
  it('unplugging the presenting display closes the output and says so — it never jumps onto the editor', () => {
    out.openOutputWindow(() => editor as never, { displayId: 2 });
    ready();
    h.displays = [display(1, 0, true)];
    h.onDisplaysChanged!();
    expect(deps.notifyDisplays).toHaveBeenLastCalledWith(h.displays);
    expect(win().destroyed).toBe(true);
    expect(lastStatus()).toMatchObject({ state: 'display-disconnected' });
    expect(deps.setLiveness).toHaveBeenLastCalledWith('output-window', false);
    expect(out.isOutputOpen()).toBe(false);
  });

  it('a display that only changed resolution keeps the output, re-fitted', () => {
    out.openOutputWindow(() => editor as never, { displayId: 2 });
    ready();
    h.displays = [display(1, 0, true), { ...display(2, 1920), bounds: { x: 1920, y: 0, width: 1280, height: 720 } }];
    h.onDisplaysChanged!();
    expect(out.isOutputOpen()).toBe(true);
    expect(lastStatus()).toMatchObject({ state: 'open', bounds: { width: 1280, height: 720 } });
  });

  it('a crashed output renderer reports an error, then a later close reports closed', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    out.openOutputWindow(() => editor as never, { displayId: 2 });
    ready();
    win().webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(lastStatus()).toMatchObject({ state: 'error' });
    expect(out.outputStatus().state).toBe('closed');

    out.openOutputWindow(() => editor as never, { displayId: 2 });
    ready();
    out.closeOutputWindow();
    expect(lastStatus()).toMatchObject({ state: 'closed' });
  });
});

describe('identity', () => {
  it('recognises the output’s own main frame and nothing else', () => {
    expect(out.isOutputFrame({ processId: 7, routingId: 3 })).toBe(false); // not open yet
    out.openOutputWindow(() => editor as never, { displayId: 2 });
    expect(out.isOutputFrame({ processId: 7, routingId: 3 })).toBe(true);
    expect(out.isOutputFrame({ processId: 7, routingId: 4 })).toBe(false);
    expect(out.isOutputFrame(null)).toBe(false);
  });

  it('watching displays twice installs one watcher', () => {
    const first = h.onDisplaysChanged;
    out.startDisplayWatch();
    expect(h.onDisplaysChanged).toBe(first);
  });
});

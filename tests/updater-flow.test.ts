// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSET_PREFIX, BUNDLE_ID } from '../shared/update';

/**
 * The self-updater's decisions, end to end: when it asks, what it refuses, and what it hands to the
 * install script. Everything that touches the system (dialogs, network, ditto/plutil/codesign, the
 * detached shell) is faked; the bundle and userData paths are real folders in a temp dir.
 */

const m = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getVersion: (): string => '0.9.3',
    getPath: (_: string): string => '',
    quit: vi.fn(),
  },
  answers: new Map<string, number>(),
  shown: [] as string[],
  openExternal: vi.fn(),
  execFile: vi.fn(),
  spawn: vi.fn(),
  readSettings: vi.fn(),
  updateSettings: vi.fn(async () => ({})),
  hasActiveExports: vi.fn(() => false),
  downloadVerified: vi.fn(),
}));

vi.mock('electron', () => ({
  app: m.app,
  shell: { openExternal: m.openExternal },
  dialog: {
    showMessageBox: vi.fn(async (...args: unknown[]) => {
      const options = args.at(-1) as { message: string };
      m.shown.push(options.message);
      // answer by message start; anything not scripted is dismissed
      const key = [...m.answers.keys()].find((k) => options.message.startsWith(k));
      return { response: key === undefined ? 1 : m.answers.get(key), checkboxChecked: false };
    }),
  },
}));
vi.mock('node:child_process', () => ({ execFile: m.execFile, spawn: m.spawn }));
vi.mock('../electron/filesystem/settings', () => ({ readSettings: m.readSettings, updateSettings: m.updateSettings }));
vi.mock('../electron/export/encoder', () => ({ hasActiveExports: m.hasActiveExports }));
vi.mock('../electron/main/updateDownload', () => ({ downloadVerified: m.downloadVerified }));

const HASH = 'b'.repeat(64);
const latest = (version = '0.9.4') => ({
  tag_name: `v${version}`,
  name: `MATERIAL ${version}`,
  draft: false,
  prerelease: false,
  html_url: `https://github.com/ipaud/material/releases/tag/v${version}`,
  body: `Easier to read.\nSHA-256: \`${HASH}\``,
  assets: [
    {
      name: `MATERIAL-${version}-arm64.zip`,
      size: 4321,
      browser_download_url: `${ASSET_PREFIX}v${version}/MATERIAL-${version}-arm64.zip`,
    },
  ],
});

let root: string;
let bundle: string;
let plist: Record<string, string>;
let codesignOk: boolean;
const realPlatform = process.platform;
const realArch = process.arch;

function respond(json: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ status, ok: status >= 200 && status < 300, json: async () => json })),
  );
}

/** Fresh module per test: the updater keeps "busy" and "staged" in module state. */
async function load(platform: NodeJS.Platform = 'darwin', arch = 'arm64') {
  Object.defineProperty(process, 'platform', { value: platform });
  Object.defineProperty(process, 'arch', { value: arch });
  vi.resetModules();
  return import('../electron/main/updater');
}

const ran = (cmd: string) => m.execFile.mock.calls.filter((c) => c[0] === cmd);

beforeEach(() => {
  delete process.env.MATERIAL_UPDATE_FEED;
  root = mkdtempSync(join(tmpdir(), 'material-updater-'));
  bundle = join(root, 'Applications', 'MATERIAL.app');
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true });
  const paths: Record<string, string> = { exe: join(bundle, 'Contents', 'MacOS', 'MATERIAL'), userData: join(root, 'userData') };
  m.app.getPath = (k: string) => paths[k] ?? '';
  m.app.isPackaged = true;
  m.answers.clear();
  m.shown.length = 0;
  plist = { CFBundleIdentifier: BUNDLE_ID, CFBundleShortVersionString: '0.9.4' };
  codesignOk = true;
  m.execFile.mockImplementation((cmd: string, args: string[], cb: (e: Error | null, r?: unknown) => void) => {
    if (cmd === '/usr/bin/plutil') return cb(null, { stdout: `${plist[args[1] ?? '']}\n` });
    if (cmd === '/usr/bin/codesign' && !codesignOk) return cb(new Error('code object is not signed at all'));
    return cb(null, { stdout: '' });
  });
  m.spawn.mockReturnValue({ unref: vi.fn() });
  m.downloadVerified.mockImplementation(async (_url, _zip, _size, _sha, progress: (f: number) => void) => progress(1));
  m.readSettings.mockResolvedValue({ autoUpdateCheck: true });
  m.hasActiveExports.mockReturnValue(false);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  Object.defineProperty(process, 'arch', { value: realArch });
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('checking', () => {
  it('a development build never asks the network, and says why when asked', async () => {
    m.app.isPackaged = false;
    respond(latest());
    const { checkForUpdates } = await load();

    await checkForUpdates(() => null, false);
    expect(fetch).not.toHaveBeenCalled();
    expect(m.shown).toEqual([]);

    await checkForUpdates(() => null, true);
    expect(m.shown).toEqual(['Updates are for the installed app']);
  });

  it('the same version is "up to date" only when the user asked, and the check is remembered', async () => {
    m.app.getVersion = () => '0.9.4';
    respond(latest('0.9.4'));
    const { checkForUpdates } = await load();

    await checkForUpdates(() => null, false);
    expect(m.shown).toEqual([]);
    expect(m.updateSettings).toHaveBeenCalledWith({ lastUpdateCheck: expect.any(Number) });

    await checkForUpdates(() => null, true);
    expect(m.shown).toEqual(['MATERIAL is up to date']);
    m.app.getVersion = () => '0.9.3';
  });

  it('no release at all (404) is not an error', async () => {
    respond({}, 404);
    const { checkForUpdates } = await load();
    await checkForUpdates(() => null, true);
    expect(m.shown).toEqual(['MATERIAL is up to date']);
  });

  it('a failed check is silent at launch and explained from the menu', async () => {
    respond({}, 503);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { checkForUpdates } = await load();

    await checkForUpdates(() => null, false);
    expect(m.shown).toEqual([]);
    await checkForUpdates(() => null, true);
    expect(m.shown).toEqual(['Could not check for updates']);
  });

  it('"Later" downloads nothing; "Release notes" opens the release page', async () => {
    respond(latest());
    const { checkForUpdates } = await load();

    await checkForUpdates(() => null, false);
    expect(m.shown).toEqual(['MATERIAL 0.9.4 is available']);
    expect(m.downloadVerified).not.toHaveBeenCalled();

    m.answers.set('MATERIAL 0.9.4 is available', 2);
    await checkForUpdates(() => null, false);
    expect(m.openExternal).toHaveBeenCalledWith('https://github.com/ipaud/material/releases/tag/v0.9.4');
    expect(m.downloadVerified).not.toHaveBeenCalled();
  });

  it('where it cannot install (Windows, Intel), it only points to the download page', async () => {
    respond(latest());
    m.answers.set('MATERIAL 0.9.4 is available', 0);
    const { checkForUpdates } = await load('win32', 'x64');

    await checkForUpdates(() => null, false);
    expect(m.openExternal).toHaveBeenCalledWith('https://github.com/ipaud/material/releases/tag/v0.9.4');
    expect(m.downloadVerified).not.toHaveBeenCalled();
  });
});

describe('installing', () => {
  beforeEach(() => {
    respond(latest());
    m.answers.set('MATERIAL 0.9.4 is available', 0);
  });

  it('downloads with the published size and hash, verifies the bundle and hands it to the install script', async () => {
    m.answers.set('MATERIAL 0.9.4 is ready to install', 0);
    const { checkForUpdates } = await load();

    await checkForUpdates(() => null, false);

    expect(m.downloadVerified).toHaveBeenCalledWith(
      `${ASSET_PREFIX}v0.9.4/MATERIAL-0.9.4-arm64.zip`,
      join(root, 'userData', 'updates', '0.9.4', 'MATERIAL-0.9.4-arm64.zip'),
      4321,
      HASH,
      expect.any(Function),
    );
    expect(ran('/usr/bin/ditto')).toHaveLength(1);
    expect(ran('/usr/bin/codesign')[0]![1]).toEqual(['--verify', '--strict', join(root, 'userData', 'updates', '0.9.4', 'MATERIAL.app')]);
    const [shell, args, opts] = m.spawn.mock.calls[0]!;
    expect([shell, args[0]]).toEqual(['/bin/sh', '-c']);
    expect(opts.env).toMatchObject({
      NEW_APP: join(root, 'userData', 'updates', '0.9.4', 'MATERIAL.app'),
      TARGET_APP: bundle,
      RELAUNCH: '1',
      PID: String(process.pid),
    });
    expect(m.app.quit).toHaveBeenCalledOnce();
  });

  it('once staged, it does not check again', async () => {
    const { checkForUpdates } = await load();
    await checkForUpdates(() => null, false); // "On next quit" (dismissed)
    expect(m.spawn.mock.calls[0]![2].env.RELAUNCH).toBe('0');
    expect(m.app.quit).not.toHaveBeenCalled();

    await checkForUpdates(() => null, true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('while an export runs, "On next quit" is the default answer', async () => {
    m.hasActiveExports.mockReturnValue(true);
    const { dialog } = await import('electron');
    const { checkForUpdates } = await load();
    await checkForUpdates(() => null, false);
    const ready = vi.mocked(dialog.showMessageBox).mock.calls.map((c) => c.at(-1) as Electron.MessageBoxOptions).find((o) => o.message.endsWith('ready to install'));
    expect(ready?.defaultId).toBe(1);
  });

  it.each([
    ['another app', () => (plist.CFBundleIdentifier = 'com.example.other'), 'the download is not MATERIAL'],
    ['the wrong version', () => (plist.CFBundleShortVersionString = '0.9.2'), 'the download is the wrong version'],
    ['a broken signature', () => (codesignOk = false), 'code object is not signed at all'],
  ])('refuses %s, leaves the app alone and cleans up', async (_, spoil, reason) => {
    spoil();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { dialog } = await import('electron');
    const { checkForUpdates } = await load();

    await checkForUpdates(() => null, false);

    expect(m.spawn).not.toHaveBeenCalled();
    expect(m.shown.at(-1)).toBe('The update could not be installed');
    const detail = (vi.mocked(dialog.showMessageBox).mock.calls.at(-1)!.at(-1) as Electron.MessageBoxOptions).detail;
    expect(detail).toContain(reason);
    expect(existsSync(join(root, 'userData', 'updates'))).toBe(false);
  });

  it('a copy macOS runs from a read-only quarantine folder is not replaced', async () => {
    const translocated = join(root, 'AppTranslocation', 'X', 'MATERIAL.app');
    mkdirSync(join(translocated, 'Contents', 'MacOS'), { recursive: true });
    m.app.getPath = (k: string) => (k === 'exe' ? join(translocated, 'Contents', 'MacOS', 'MATERIAL') : join(root, 'userData'));
    const { checkForUpdates } = await load();

    await checkForUpdates(() => null, false);

    expect(m.shown.at(-1)).toBe('MATERIAL cannot update itself from here');
    expect(m.downloadVerified).not.toHaveBeenCalled();
  });
});

describe('the launch check', () => {
  it('waits a few seconds, then checks only when enabled and not checked within a day', async () => {
    vi.useFakeTimers();
    respond(latest('0.9.3'));
    const { startAutoCheck } = await load();

    m.readSettings.mockResolvedValue({ autoUpdateCheck: false });
    startAutoCheck(() => null);
    await vi.runAllTimersAsync();
    expect(fetch).not.toHaveBeenCalled();

    m.readSettings.mockResolvedValue({ autoUpdateCheck: true, lastUpdateCheck: Date.now() - 60_000 });
    startAutoCheck(() => null);
    await vi.runAllTimersAsync();
    expect(fetch).not.toHaveBeenCalled();

    m.readSettings.mockResolvedValue({ autoUpdateCheck: true, lastUpdateCheck: Date.now() - 2 * 24 * 60 * 60 * 1000 });
    startAutoCheck(() => null);
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('turning it off is saved', async () => {
    const { setAutoCheck } = await load();
    await setAutoCheck(false);
    expect(m.updateSettings).toHaveBeenCalledWith({ autoUpdateCheck: false });
  });
});

import { app, dialog, shell, type BrowserWindow } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  ASSET_PREFIX,
  BUNDLE_ID,
  INSTALL_SCRIPT,
  RELEASE_API,
  isNewer,
  pickNotice,
  pickRelease,
  type Notice,
  type ReleaseInfo,
} from '../../shared/update';
import { hasActiveExports } from '../export/encoder';
import { readSettings, updateSettings } from '../filesystem/settings';
import { downloadVerified } from './updateDownload';

/**
 * Self-update. MATERIAL is not signed with a Developer ID, so macOS auto-updaters (Squirrel, electron-updater)
 * cannot be used: they refuse an update they cannot tie to the running app's signature. Instead, the app finds the
 * newest GitHub release, asks, downloads its own zip, checks the size and SHA-256 the release publishes, checks that
 * what it unpacked is MATERIAL and has a valid bundle signature, and swaps the bundle in after it quits.
 *
 * The only network traffic is one request to api.github.com at launch (at most once a day, and only if the
 * "Check for Updates Automatically" menu item is on), plus the download when you say yes. Nothing about you is sent.
 */

const run = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 8_000;
// For tests: a URL that serves a GitHub-shaped "latest release" JSON. Never needed in normal use.
const FEED = process.env.MATERIAL_UPDATE_FEED;

let busy = false;
let staged = false;

type GetWindow = () => BrowserWindow | null;

/** Only macOS on Apple Silicon can install an update by itself; everywhere else the app just says one exists. */
const CAN_INSTALL = process.platform === 'darwin' && process.arch === 'arm64';

function enabled(): boolean {
  return app.isPackaged || Boolean(FEED);
}

function feedConfig(): { url: string; assetPrefix: string } {
  if (!FEED) return { url: RELEASE_API, assetPrefix: ASSET_PREFIX };
  return { url: FEED, assetPrefix: `${new URL(FEED).origin}/` };
}

async function say(
  getWindow: GetWindow,
  options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
  const win = getWindow();
  return win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

/** The newest installable release, or null when there is none (no release yet, or one this build cannot install). */
async function fetchLatest(): Promise<ReleaseInfo | Notice | null> {
  const { url, assetPrefix } = feedConfig();
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MATERIAL-updater' },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json: unknown = await res.json();
  if (!CAN_INSTALL) return pickNotice(json);
  const release = pickRelease(json, { arch: process.arch, assetPrefix });
  if (!release) console.warn('[update] the latest release has no installable asset for this Mac');
  return release;
}

/** Menu: "Check for Updates…" (says so when there is nothing) and, at launch, the quiet once-a-day check. */
export async function checkForUpdates(getWindow: GetWindow, manual: boolean): Promise<void> {
  if (busy || staged) return;
  if (!enabled()) {
    if (manual) {
      await say(getWindow, {
        type: 'info',
        message: 'Updates are for the installed app',
        detail: 'This is a development build. Releases are on github.com/ipaud/material.',
      });
    }
    return;
  }
  busy = true;
  try {
    const release = await fetchLatest();
    await updateSettings({ lastUpdateCheck: Date.now() });
    if (!release || !isNewer(release.version, app.getVersion())) {
      if (manual) {
        await say(getWindow, {
          type: 'info',
          message: 'MATERIAL is up to date',
          detail: `You have ${app.getVersion()}, the latest version.`,
        });
      }
      return;
    }
    if (!('assetUrl' in release)) {
      const news = await say(getWindow, {
        type: 'info',
        message: `MATERIAL ${release.version} is available`,
        detail: `You have ${app.getVersion()}.${release.notes ? `\n\n${release.notes}` : ''}`,
        buttons: ['Open download page', 'Later'],
        defaultId: 0,
        cancelId: 1,
      });
      if (news.response === 0) void shell.openExternal(release.pageUrl);
      return;
    }
    const ask = await say(getWindow, {
      type: 'info',
      message: `MATERIAL ${release.version} is available`,
      detail: `You have ${app.getVersion()}.${release.notes ? `\n\n${release.notes}` : ''}`,
      buttons: ['Update now', 'Later', 'Release notes'],
      defaultId: 0,
      cancelId: 1,
    });
    if (ask.response === 2) void shell.openExternal(release.pageUrl);
    if (ask.response === 0) await install(release, getWindow);
  } catch (error) {
    console.error('[update] check failed:', error);
    if (manual) {
      await say(getWindow, {
        type: 'warning',
        message: 'Could not check for updates',
        detail: `${error instanceof Error ? error.message : String(error)}\n\nCheck your connection, or look at github.com/ipaud/material/releases.`,
      });
    }
  } finally {
    busy = false;
  }
}

/** At launch: once a day at most, only if the user has not turned it off, never while a CLI job runs. */
export function startAutoCheck(getWindow: GetWindow): void {
  if (!enabled()) return;
  setTimeout(() => {
    void (async () => {
      const settings = await readSettings();
      if (!settings.autoUpdateCheck) return;
      if (settings.lastUpdateCheck && Date.now() - settings.lastUpdateCheck < DAY_MS) return;
      await checkForUpdates(getWindow, false);
    })();
  }, FIRST_CHECK_DELAY_MS);
}

export async function setAutoCheck(on: boolean): Promise<void> {
  await updateSettings({ autoUpdateCheck: on });
}

/** The path of the running MATERIAL.app, or null when not running from a bundle. */
function bundlePath(): string | null {
  return /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(app.getPath('exe'))?.[1] ?? null;
}

async function canReplace(target: string): Promise<boolean> {
  // A freshly downloaded app that was never moved runs from a read-only "translocated" copy.
  if (target.includes('/AppTranslocation/')) return false;
  try {
    await fs.access(path.dirname(target), constants.W_OK);
    await fs.access(target, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function plistValue(plist: string, key: string): Promise<string> {
  const { stdout } = await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]);
  return stdout.trim();
}

/** Unzip next to the zip and refuse anything that is not this app at this version, with an intact signature. */
async function unpack(zip: string, dir: string, version: string): Promise<string> {
  await run('/usr/bin/ditto', ['-x', '-k', zip, dir]);
  const bundle = path.join(dir, 'MATERIAL.app');
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  if ((await plistValue(plist, 'CFBundleIdentifier')) !== BUNDLE_ID) throw new Error('the download is not MATERIAL');
  if ((await plistValue(plist, 'CFBundleShortVersionString')) !== version) throw new Error('the download is the wrong version');
  await run('/usr/bin/codesign', ['--verify', '--strict', bundle]);
  await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', bundle]).catch(() => undefined);
  return bundle;
}

async function install(release: ReleaseInfo, getWindow: GetWindow): Promise<void> {
  const target = bundlePath();
  if (!app.isPackaged || !target || !(await canReplace(target))) {
    await say(getWindow, {
      type: 'info',
      message: 'MATERIAL cannot update itself from here',
      detail: app.isPackaged
        ? 'Move MATERIAL.app to your Applications folder, open it from there, and try again. Or download the new version yourself.'
        : 'This is a development build.',
      buttons: ['Open download page', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    }).then((r) => {
      if (r.response === 0) void shell.openExternal(release.pageUrl);
    });
    return;
  }

  const dir = path.join(app.getPath('userData'), 'updates', release.version);
  await fs.rm(path.join(app.getPath('userData'), 'updates'), { recursive: true, force: true });
  const zip = path.join(dir, release.assetName);
  const win = getWindow();
  let lastShown = -1;
  try {
    await downloadVerified(release.assetUrl, zip, release.size, release.sha256, (fraction) => {
      const pct = Math.floor(fraction * 100);
      if (pct === lastShown) return;
      lastShown = pct;
      win?.setProgressBar(fraction);
    });
    win?.setProgressBar(2); // indeterminate while it unpacks
    const bundle = await unpack(zip, dir, release.version);
    await fs.rm(zip, { force: true });
    win?.setProgressBar(-1);
    await finish(release, bundle, target, getWindow);
  } catch (error) {
    win?.setProgressBar(-1);
    console.error('[update] install failed:', error);
    await fs.rm(path.join(app.getPath('userData'), 'updates'), { recursive: true, force: true }).catch(() => undefined);
    await say(getWindow, {
      type: 'warning',
      message: 'The update could not be installed',
      detail: `${error instanceof Error ? error.message : String(error)}\n\nYour current MATERIAL was not changed.`,
      buttons: ['Open download page', 'Close'],
      defaultId: 1,
      cancelId: 1,
    }).then((r) => {
      if (r.response === 0) void shell.openExternal(release.pageUrl);
    });
  }
}

async function finish(release: ReleaseInfo, newApp: string, target: string, getWindow: GetWindow): Promise<void> {
  const exporting = hasActiveExports();
  const ask = await say(getWindow, {
    type: 'info',
    message: `MATERIAL ${release.version} is ready to install`,
    detail: exporting
      ? 'An export is running. Restarting would stop it. Choose "On next quit" and it installs when you close MATERIAL.'
      : 'Restart now to finish, or it installs the next time you quit. Save your work first.',
    buttons: ['Restart now', 'On next quit'],
    defaultId: exporting ? 1 : 0,
    cancelId: 1,
  });
  const restart = ask.response === 0;
  staged = true;
  spawn('/bin/sh', ['-c', INSTALL_SCRIPT], {
    detached: true,
    stdio: 'ignore',
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      PID: String(process.pid),
      // a restart should happen within a minute; "next quit" waits as long as it takes
      MAX_TICKS: restart ? '600' : '100000000',
      NEW_APP: newApp,
      TARGET_APP: target,
      RELAUNCH: restart ? '1' : '0',
    },
  }).unref();
  if (restart) app.quit();
}

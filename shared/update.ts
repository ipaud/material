/**
 * Update logic with no Electron in it, so it can be tested: which release is newer, which asset is ours, and the
 * script that swaps the app bundle once the app has quit. electron/main/updater.ts does the I/O around it.
 *
 * MATERIAL is not signed with a Developer ID, so Squirrel / electron-updater cannot be used on macOS (they refuse an
 * update whose signature they cannot chain to the running app). The app downloads its own release instead, checks the
 * size and SHA-256 the release publishes, checks the bundle it unpacked is ours, and swaps it in after quitting.
 */

export const REPO = 'ipaud/material';
export const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
/** Where an asset may be downloaded from. Anything else in a release is ignored, whatever the API says. */
export const ASSET_PREFIX = `https://github.com/${REPO}/releases/download/`;
export const BUNDLE_ID = 'com.pauavila.material';

export type Version = readonly [number, number, number];

/** "v0.8.5" / "0.8.5" → [0, 8, 5]; anything else (including "0.8.5-beta") → null, so a pre-release is never offered. */
export function parseVersion(text: string): Version | null {
  const m = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

export interface ReleaseInfo {
  version: string;
  name: string;
  /** The release page, for "Release notes". */
  pageUrl: string;
  /** First lines of the release text, for the dialog. */
  notes: string;
  assetName: string;
  assetUrl: string;
  size: number;
  /** Lowercase hex, from the asset's `digest` or, failing that, a "SHA-256: …" line in the release text. */
  sha256: string;
}

export interface PickOptions {
  arch: string;
  /** Tests and `MATERIAL_UPDATE_FEED` point this at a local server. */
  assetPrefix?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

function notesOf(body: string): string {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^#{1,6}\s/.test(l) && !/sha-?256/i.test(l))
    .slice(0, 4)
    .join('\n')
    .slice(0, 400);
}

export interface Notice {
  version: string;
  name: string;
  pageUrl: string;
  notes: string;
}

/**
 * Platforms where the app cannot swap itself in (Windows, for now): just the news that a newer release exists, and
 * where to get it. Same rules as pickRelease about drafts, pre-releases and tags.
 */
export function pickNotice(json: unknown): Notice | null {
  if (typeof json !== 'object' || json === null) return null;
  const r = json as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true) return null;
  const tag = str(r.tag_name);
  const parsed = tag ? parseVersion(tag) : null;
  if (!parsed) return null;
  const version = parsed.join('.');
  return {
    version,
    name: str(r.name) ?? `MATERIAL ${version}`,
    pageUrl: str(r.html_url) ?? `https://github.com/${REPO}/releases`,
    notes: notesOf(str(r.body) ?? ''),
  };
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Turn GitHub's "latest release" JSON into what the updater needs, or null if it is not a usable release. */
export function pickRelease(json: unknown, opts: PickOptions): ReleaseInfo | null {
  if (typeof json !== 'object' || json === null) return null;
  const r = json as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true) return null;
  const tag = str(r.tag_name);
  const parsed = tag ? parseVersion(tag) : null;
  if (!tag || !parsed) return null;
  const version = parsed.join('.');
  const wanted = `MATERIAL-${version}-${opts.arch}.zip`;
  const prefix = opts.assetPrefix ?? ASSET_PREFIX;
  const assets = Array.isArray(r.assets) ? (r.assets as unknown[]) : [];
  const asset = assets.find(
    (a): a is Record<string, unknown> =>
      typeof a === 'object' && a !== null && (a as Record<string, unknown>).name === wanted,
  );
  if (!asset) return null;
  const assetUrl = str(asset.browser_download_url);
  const size = typeof asset.size === 'number' ? asset.size : NaN;
  if (!assetUrl || !assetUrl.startsWith(prefix) || !Number.isInteger(size) || size <= 0) return null;

  const body = str(r.body) ?? '';
  const digest = str(asset.digest)?.replace(/^sha256:/i, '').toLowerCase();
  const fromBody = /sha-?256:?\s*`?([0-9a-f]{64})`?/i.exec(body)?.[1]?.toLowerCase();
  const sha256 = digest && HEX64.test(digest) ? digest : fromBody && HEX64.test(fromBody) ? fromBody : null;
  if (!sha256) return null;

  const notes = notesOf(body);
  return {
    version,
    name: str(r.name) ?? `MATERIAL ${version}`,
    pageUrl: str(r.html_url) ?? `https://github.com/${REPO}/releases`,
    notes,
    assetName: wanted,
    assetUrl,
    size,
    sha256,
  };
}

/**
 * The script that runs after MATERIAL has quit: wait for the process to go, swap the bundle, put the old one back
 * if the swap fails, and optionally open the new one. Everything variable arrives as an environment variable
 * (PID, MAX_TICKS in tenths of a second, NEW_APP, TARGET_APP, RELAUNCH), never spliced into this text, so a path
 * with quotes or spaces cannot change what the shell runs.
 */
export const INSTALL_SCRIPT = `
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -gt "$MAX_TICKS" ] && exit 1
  sleep 0.1
done
OLD="$TARGET_APP.updating-old"
rm -rf "$OLD"
mv "$TARGET_APP" "$OLD" || exit 1
if mv "$NEW_APP" "$TARGET_APP"; then
  rm -rf "$OLD"
else
  mv "$OLD" "$TARGET_APP"
  exit 1
fi
if [ "$RELAUNCH" = "1" ]; then
  open "$TARGET_APP"
fi
`;

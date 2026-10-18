import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 18D: electron-builder injects a default NSMicrophoneUsageDescription into
 * every mac Info.plist. MATERIAL never requests audio capture (the main
 * process permission gate denies it unconditionally), so an honest manifest
 * must not claim it. Camera stays — that one is real.
 */
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const plist = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Info.plist',
  );
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Delete :NSMicrophoneUsageDescription', plist]);
  } catch {
    // Key absent — nothing to strip.
  }

  // release/ once held a 0.7.0 .app next to 0.8.4 source and nobody noticed
  // until the video was made with it. Refuse to produce a mismatched bundle,
  // and stamp the commit so the About panel can say which build this is.
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const bundled = execFileSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleShortVersionString', plist],
    { encoding: 'utf8' },
  ).trim();
  if (bundled !== pkg.version) {
    throw new Error(`Packaged version ${bundled} does not match package.json ${pkg.version}`);
  }
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) commit += '-dirty';
  } catch {
    // not a git checkout
  }
  writeFileSync(
    join(plist, '..', 'Resources', 'build-info.json'),
    JSON.stringify({ version: pkg.version, commit }),
  );
}

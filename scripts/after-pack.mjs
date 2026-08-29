import { execFileSync } from 'node:child_process';
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
}

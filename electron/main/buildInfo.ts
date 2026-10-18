import { app } from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface BuildInfo {
  version: string;
  commit: string;
}

/** Written into Contents/Resources by scripts/after-pack.mjs; absent in dev. */
export function readBuildInfo(): BuildInfo {
  try {
    const raw = readFileSync(path.join(process.resourcesPath, 'build-info.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<BuildInfo>;
    if (typeof parsed.version === 'string' && typeof parsed.commit === 'string') {
      return { version: parsed.version, commit: parsed.commit };
    }
  } catch {
    // dev run or unstamped build
  }
  return { version: app.getVersion(), commit: 'dev' };
}

export function configureAboutPanel(): void {
  const info = readBuildInfo();
  app.setAboutPanelOptions({
    applicationName: 'MATERIAL',
    applicationVersion: info.version,
    version: `build ${info.commit}`,
  });
}

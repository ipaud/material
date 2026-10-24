import path from 'node:path';

/**
 * Where to look for ffmpeg/ffprobe. A macOS GUI app does not inherit the shell's PATH, so the usual Homebrew
 * places are listed; on Windows, the places winget, Chocolatey and Scoop put it. The process PATH always comes
 * first, so a user who has it on PATH never needs these lists. Pure, so it can be tested on any OS.
 */
export interface SearchEnv {
  platform: NodeJS.Platform;
  /** process.env.PATH */
  pathVar: string | undefined;
  home: string;
  /** process.env.LOCALAPPDATA, ProgramData, ProgramFiles (Windows only; undefined elsewhere) */
  localAppData?: string | undefined;
  programData?: string | undefined;
  programFiles?: string | undefined;
}

export function binaryName(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

export function searchDirs(env: SearchEnv): string[] {
  const join = env.platform === 'win32' ? path.win32.join : path.posix.join;
  const delimiter = env.platform === 'win32' ? ';' : ':';
  const fromPath = (env.pathVar ?? '').split(delimiter).filter((d) => d.length > 0);
  const extra =
    env.platform === 'win32'
      ? [
          env.localAppData && join(env.localAppData, 'Microsoft', 'WinGet', 'Links'),
          env.programData && join(env.programData, 'chocolatey', 'bin'),
          join(env.home, 'scoop', 'shims'),
          env.programFiles && join(env.programFiles, 'ffmpeg', 'bin'),
          'C:\\ffmpeg\\bin',
        ]
      : [join(env.home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  return [...new Set([...fromPath, ...extra.filter((d): d is string => typeof d === 'string' && d.length > 0)])];
}

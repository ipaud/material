import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { binaryName, searchDirs } from './ffmpegPaths';

const execFileAsync = promisify(execFile);

function findBinary(name: string): string | null {
  const dirs = searchDirs({
    platform: process.platform,
    pathVar: process.env.PATH,
    home: os.homedir(),
    localAppData: process.env.LOCALAPPDATA,
    programData: process.env.ProgramData,
    programFiles: process.env.ProgramFiles,
  });
  const file = binaryName(name, process.platform);
  for (const dir of dirs) {
    const candidate = path.join(dir, file);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

export const ffmpegPath = findBinary('ffmpeg');
export const ffprobePath = findBinary('ffprobe');

let cachedEncoders: string[] | null = null;

/** Detect available encoders relevant to MATERIAL's export pipeline. */
export async function detectEncoders(): Promise<string[]> {
  if (cachedEncoders) return cachedEncoders;
  if (!ffmpegPath) return (cachedEncoders = []);
  try {
    const { stdout } = await execFileAsync(ffmpegPath, ['-hide_banner', '-encoders'], {
      timeout: 10_000,
    });
    const interesting = ['libx264', 'h264_videotoolbox', 'prores_ks', 'prores_videotoolbox', 'png'];
    cachedEncoders = interesting.filter((enc) =>
      new RegExp(`^\\s*V[^\\n]*\\s${enc}\\s`, 'm').test(stdout),
    );
  } catch {
    cachedEncoders = [];
  }
  return cachedEncoders;
}

export async function runFfprobeJson(filePath: string): Promise<unknown> {
  if (!ffprobePath) throw new Error('ffprobe not found on this system');
  const { stdout } = await execFileAsync(
    ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

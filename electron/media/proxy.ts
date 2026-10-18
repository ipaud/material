import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { ffmpegPath } from './ffmpeg';
import { approveMediaPath, validateMediaPath } from '../filesystem/mediaRegistry';

/**
 * H.264 viewing proxies for codecs Chromium cannot play (ProRes, DNxHD…).
 * All-intra (-g 1) so the export's per-frame seeks stay exact and fast. The
 * name hashes path + size + mtime, so an edited original gets a fresh proxy.
 */
export function proxyPathFor(cacheDir: string, original: string): string {
  const { size, mtimeMs } = statSync(original);
  const key = createHash('sha1').update(`${original}|${size}|${mtimeMs}`).digest('hex').slice(0, 16);
  return path.join(cacheDir, `${key}.mp4`);
}

export function buildProxyArgs(original: string, dest: string): string[] {
  return [
    '-y',
    '-i',
    original,
    '-map',
    '0:v:0',
    '-an',
    '-vf',
    'scale=out_color_matrix=bt709:out_range=tv',
    '-c:v',
    'libx264',
    '-crf',
    '14',
    '-preset',
    'veryfast',
    '-g',
    '1',
    '-pix_fmt',
    'yuv420p',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_range',
    'tv',
    '-movflags',
    '+faststart',
    dest,
  ];
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function findProxy(cacheDir: string, original: string): Promise<string | null> {
  validateMediaPath(original);
  const proxy = proxyPathFor(cacheDir, original);
  if (!(await exists(proxy))) return null;
  approveMediaPath(proxy);
  return proxy;
}

const inFlight = new Map<string, Promise<string>>();

/** Transcode once; concurrent callers share the same job. Writes .partial then renames. */
export function createProxy(cacheDir: string, original: string): Promise<string> {
  const { kind } = validateMediaPath(original);
  if (kind !== 'video') return Promise.reject(new Error('Only video files need a proxy'));
  if (!ffmpegPath) return Promise.reject(new Error('FFmpeg not found — cannot make a proxy'));
  const dest = proxyPathFor(cacheDir, original);
  const running = inFlight.get(dest);
  if (running) return running;

  const bin = ffmpegPath;
  const job = (async () => {
    if (await exists(dest)) return dest;
    await fs.mkdir(cacheDir, { recursive: true });
    const partial = `${dest}.partial.mp4`;
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(bin, buildProxyArgs(original, partial), { stdio: ['ignore', 'ignore', 'pipe'] });
      let tail = '';
      proc.stderr.on('data', (c: Buffer) => {
        tail = (tail + c.toString()).slice(-500);
      });
      proc.on('error', reject);
      proc.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`FFmpeg proxy failed (code ${code}): ${tail}`)),
      );
    }).catch(async (err: unknown) => {
      await fs.rm(partial, { force: true });
      throw err;
    });
    await fs.rename(partial, dest);
    return dest;
  })()
    .then((file) => {
      approveMediaPath(file);
      return file;
    })
    .finally(() => inFlight.delete(dest));
  inFlight.set(dest, job);
  return job;
}

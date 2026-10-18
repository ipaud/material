import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectEncoders, ffmpegPath, ffprobePath } from '../electron/media/ffmpeg';
import { buildProxyArgs, createProxy, findProxy } from '../electron/media/proxy';

describe('buildProxyArgs', () => {
  it('is all-intra H.264, video only, Rec.709 tagged', () => {
    const args = buildProxyArgs('/m/a.mov', '/c/a.mp4');
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-g', '1', '-an']));
    expect(args[args.indexOf('-colorspace') + 1]).toBe('bt709');
    expect(args[args.length - 1]).toBe('/c/a.mp4');
  });
});

const hasProres = ffmpegPath && ffprobePath && (await detectEncoders()).includes('prores_ks');
(hasProres ? describe : describe.skip)('createProxy (real ffmpeg)', () => {
  it('turns a ProRes .mov into a cached H.264 proxy, reused on the second call', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mat-proxy-'));
    const src = path.join(dir, 'clip.mov');
    execFileSync(ffmpegPath as string, [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=25:duration=0.4',
      '-c:v', 'prores_ks', '-pix_fmt', 'yuv422p10le', src,
    ]);
    const cache = path.join(dir, 'cache');
    expect(await findProxy(cache, src)).toBeNull();
    const proxy = await createProxy(cache, src);
    expect(await findProxy(cache, src)).toBe(proxy);
    expect(readdirSync(cache)).toEqual([path.basename(proxy)]);
    const codec = execFileSync(ffprobePath as string, [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name',
      '-of', 'csv=p=0', proxy,
    ]).toString().trim();
    expect(codec).toBe('h264');
  });
});

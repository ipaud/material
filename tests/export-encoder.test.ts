import { describe, expect, it } from 'vitest';
import { buildFfmpegArgs } from '../electron/export/encoder';
import type { ExportConfig } from '../shared/ipc';

function config(over: Partial<ExportConfig> = {}): ExportConfig {
  return {
    format: 'h264',
    width: 1920,
    height: 1080,
    fps: 25,
    outPath: '/tmp/out.mov',
    alpha: false,
    audioPath: null,
    audioStartSec: 0,
    durationSec: 5,
    ...over,
  };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

describe('export colour tagging', () => {
  for (const format of ['h264', 'prores422', 'prores4444'] as const) {
    it(`${format} converts with the Rec.709 matrix and tags the stream`, () => {
      const args = buildFfmpegArgs(config({ format }));
      expect(flag(args, '-vf')).toContain('out_color_matrix=bt709');
      expect(flag(args, '-colorspace')).toBe('bt709');
      expect(flag(args, '-color_primaries')).toBe('bt709');
      expect(flag(args, '-color_trc')).toBe('bt709');
      expect(flag(args, '-color_range')).toBe('tv');
    });
  }

  it('png sequences stay untagged RGB', () => {
    const args = buildFfmpegArgs(config({ format: 'png-sequence', outPath: '/tmp/seq' }));
    expect(args).not.toContain('-colorspace');
    expect(args).not.toContain('-vf');
  });
});

describe('export output path', () => {
  it('writes movies to a temp name next to the final path, never the final path', () => {
    const args = buildFfmpegArgs(config(), '/tmp/out.mov.partial.mov');
    expect(args[args.length - 1]).toBe('/tmp/out.mov.partial.mov');
    expect(args).not.toContain('/tmp/out.mov');
  });
});

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ffmpegPath, ffprobePath } from '../electron/media/ffmpeg';
import { cancelExport, finishExport, startExport, writeExportFrame } from '../electron/export/encoder';

const live = ffmpegPath && ffprobePath ? describe : describe.skip;

live('export lifecycle (real ffmpeg)', () => {
  const W = 64;
  const H = 64;
  const frame = new Uint8Array(W * H * 4).fill(128);
  const win = () => null;
  const cfg = (outPath: string) => ({
    format: 'h264',
    width: W,
    height: H,
    fps: 25,
    outPath,
    alpha: false,
    audioPath: null,
    audioStartSec: 0,
    durationSec: 0.2,
  });

  it('finish renames the temp file onto the final path and tags Rec.709', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mat-exp-'));
    const out = path.join(dir, 'a.mp4');
    const { sessionId } = await startExport(cfg(out), win);
    for (let i = 0; i < 5; i++) await writeExportFrame(sessionId, frame, win);
    await finishExport(sessionId, win);
    expect(readdirSync(dir)).toEqual(['a.mp4']);
    const probe = execFileSync(ffprobePath as string, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=color_space,color_primaries,color_transfer',
      '-of', 'csv=p=0', out,
    ]).toString().trim();
    expect(probe).toBe('bt709,bt709,bt709');
  });

  it('cancel leaves no final file and no partial', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mat-exp-'));
    const out = path.join(dir, 'b.mp4');
    const { sessionId } = await startExport(cfg(out), win);
    await writeExportFrame(sessionId, frame, win);
    await cancelExport(sessionId);
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a pre-existing file survives a failed export', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mat-exp-'));
    const out = path.join(dir, 'c.mp4');
    execFileSync('/bin/sh', ['-c', `echo keep > ${out}`]);
    const { sessionId } = await startExport(cfg(out), win);
    await writeExportFrame(sessionId, frame, win);
    await cancelExport(sessionId);
    expect(readdirSync(dir)).toEqual(['c.mp4']);
  });
});

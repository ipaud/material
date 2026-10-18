import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BrowserWindow } from 'electron';
import { detectEncoders, ffmpegPath } from '../media/ffmpeg';
import { IPC, type ExportConfig, type ExportProgressEvent } from '../../shared/ipc';
import { isApprovedMediaPath } from '../filesystem/mediaRegistry';
import { logExport } from './exportLog';

export const exportConfigSchema = z.object({
  format: z.enum(['png-sequence', 'h264', 'prores422', 'prores4444']),
  width: z.number().int().min(16).max(8192),
  height: z.number().int().min(16).max(8192),
  fps: z.number().min(1).max(120),
  outPath: z.string().min(1),
  alpha: z.boolean(),
  audioPath: z.string().nullable(),
  audioStartSec: z.number().min(0),
  durationSec: z.number().positive(),
});

interface ExportSession {
  id: string;
  config: ExportConfig;
  proc: ChildProcessByStdio<Writable, null, Readable>;
  /** Where ffmpeg writes; renamed onto config.outPath only after a clean exit. */
  tempPath: string;
  /** Set once ffmpeg exits (any reason); writes after this must fail fast. */
  exitCode: number | null;
  exited: Promise<number>;
  framesWritten: number;
  stderrTail: string[];
  cancelled: boolean;
}

const sessions = new Map<string, ExportSession>();

function sendProgress(win: BrowserWindow | null, event: ExportProgressEvent): void {
  win?.webContents.send(IPC.exportProgress, event);
}

/** Sibling temp name that keeps the extension so ffmpeg still picks the muxer. */
export function partialPathFor(outPath: string): string {
  const ext = path.extname(outPath);
  return `${outPath.slice(0, outPath.length - ext.length)}.partial${ext}`;
}

/** Rec.709 tags: swscale would otherwise convert with BT.601 and leave the file untagged. */
const COLOR_ARGS = [
  '-vf',
  'scale=out_color_matrix=bt709:out_range=tv,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv',
  '-colorspace',
  'bt709',
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-color_range',
  'tv',
];

export function buildFfmpegArgs(config: ExportConfig, outFile: string = config.outPath): string[] {
  const args = [
    '-y',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    `${config.width}x${config.height}`,
    '-r',
    String(config.fps),
    '-i',
    '-',
  ];
  if (config.format === 'png-sequence') {
    // PNG sequence into the chosen directory; RGBA is preserved as-is.
    args.push('-c:v', 'png', path.join(config.outPath, 'frame_%05d.png'));
    return args;
  }

  // Movie formats can mux the project's audio, trimmed to the export range.
  if (config.audioPath) {
    args.push(
      '-ss',
      String(config.audioStartSec),
      '-t',
      String(config.durationSec),
      '-i',
      config.audioPath,
    );
  }

  args.push(...COLOR_ARGS);

  if (config.format === 'h264') {
    args.push(
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '18',
      '-preset',
      'medium',
      '-movflags',
      '+faststart',
    );
  } else if (config.format === 'prores422') {
    // ProRes 422 HQ — no alpha channel in this profile.
    args.push('-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-vendor', 'apl0');
  } else {
    // ProRes 4444, the profile that actually carries alpha.
    args.push(
      '-c:v',
      'prores_ks',
      '-profile:v',
      '4444',
      '-pix_fmt',
      config.alpha ? 'yuva444p10le' : 'yuv444p10le',
      '-vendor',
      'apl0',
      '-alpha_bits',
      config.alpha ? '16' : '0',
    );
  }

  if (config.audioPath) {
    args.push(
      '-c:a',
      config.format === 'h264' ? 'aac' : 'pcm_s16le',
      ...(config.format === 'h264' ? ['-b:a', '192k'] : []),
      '-shortest',
    );
  }
  args.push(outFile);
  return args;
}

export async function startExport(
  rawConfig: unknown,
  getWindow: () => BrowserWindow | null,
): Promise<{ sessionId: string }> {
  if (!ffmpegPath) throw new Error('FFmpeg not found — animation export unavailable');
  const config = exportConfigSchema.parse(rawConfig);
  if (config.audioPath && !isApprovedMediaPath(config.audioPath)) {
    throw new Error('Audio file has not been imported');
  }
  if (!path.isAbsolute(config.outPath)) throw new Error('Export path must be absolute');
  if (config.format === 'png-sequence') {
    await fs.mkdir(config.outPath, { recursive: true });
  }
  if (config.format.startsWith('prores')) {
    // Never offer a codec this machine's FFmpeg cannot actually produce.
    const encoders = await detectEncoders();
    if (!encoders.includes('prores_ks')) {
      throw new Error('ProRes encoder (prores_ks) is not available in this FFmpeg build');
    }
  }

  const tempPath = config.format === 'png-sequence' ? config.outPath : partialPathFor(config.outPath);
  const proc = spawn(ffmpegPath, buildFfmpegArgs(config, tempPath), {
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  const session: ExportSession = {
    id: randomUUID(),
    config,
    proc,
    tempPath,
    exitCode: null,
    exited: new Promise<number>((resolve) => {
      proc.once('close', (c) => resolve(c ?? -1));
    }),
    framesWritten: 0,
    stderrTail: [],
    cancelled: false,
  };
  logExport(
    `export ${session.id} start ${config.format} ${config.width}x${config.height}@${config.fps} -> ${config.outPath}`,
  );
  void session.exited.then((code) => {
    session.exitCode = code;
    logExport(`export ${session.id} ffmpeg exit code=${code} frames=${session.framesWritten}`);
  });
  // ffmpeg dying mid-export surfaces as EPIPE on stdin; the write path reports it.
  proc.stdin.on('error', () => undefined);
  proc.stderr.on('data', (chunk: Buffer) => {
    const line = chunk.toString();
    session.stderrTail.push(line);
    if (session.stderrTail.length > 30) session.stderrTail.shift();
  });
  proc.on('error', (err) => {
    sendProgress(getWindow(), {
      sessionId: session.id,
      phase: 'error',
      framesWritten: session.framesWritten,
      message: err.message,
    });
    sessions.delete(session.id);
    void fs.rm(session.tempPath, { force: true });
  });
  sessions.set(session.id, session);
  return { sessionId: session.id };
}

export async function writeExportFrame(
  rawSessionId: unknown,
  rawFrame: unknown,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  const sessionId = z.string().parse(rawSessionId);
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Export session not found');
  if (!(rawFrame instanceof Uint8Array)) throw new Error('Frame payload must be bytes');
  const expected = session.config.width * session.config.height * 4;
  if (rawFrame.byteLength !== expected) {
    throw new Error(`Frame size mismatch: got ${rawFrame.byteLength}, expected ${expected}`);
  }
  const buffer = Buffer.from(rawFrame.buffer, rawFrame.byteOffset, rawFrame.byteLength);
  if (session.exitCode !== null) throw await ffmpegDied(session);
  await new Promise<void>((resolve, reject) => {
    const { stdin } = session.proc;
    const fail = (): void => reject(new Error('ffmpeg closed its input'));
    const ok = stdin.write(buffer, (err) => (err ? reject(err) : undefined));
    if (ok) {
      resolve();
      return;
    }
    stdin.once('drain', () => {
      stdin.off('close', fail);
      resolve();
    });
    stdin.once('close', fail);
  }).catch(async (err: unknown) => {
    throw session.exitCode !== null || session.cancelled ? await ffmpegDied(session) : err;
  });
  session.framesWritten++;
  if (session.framesWritten % 100 === 0) {
    logExport(`export ${sessionId} frame=${session.framesWritten}`);
  }
  if (session.framesWritten % 10 === 0) {
    sendProgress(getWindow(), {
      sessionId,
      phase: 'encoding',
      framesWritten: session.framesWritten,
    });
  }
}

export async function finishExport(
  rawSessionId: unknown,
  getWindow: () => BrowserWindow | null,
): Promise<{ outPath: string }> {
  const sessionId = z.string().parse(rawSessionId);
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Export session not found');
  sendProgress(getWindow(), {
    sessionId,
    phase: 'finalizing',
    framesWritten: session.framesWritten,
  });
  session.proc.stdin.end();
  const code = await session.exited;
  sessions.delete(sessionId);
  if (session.cancelled) {
    sendProgress(getWindow(), {
      sessionId,
      phase: 'cancelled',
      framesWritten: session.framesWritten,
    });
    await discardPartial(session);
    throw new Error('Export cancelled');
  }
  if (code !== 0) {
    await discardPartial(session);
    const detail = session.stderrTail.join('').slice(-500);
    sendProgress(getWindow(), {
      sessionId,
      phase: 'error',
      framesWritten: session.framesWritten,
      message: `FFmpeg exited with code ${code}`,
    });
    throw new Error(`FFmpeg failed (code ${code}): ${detail}`);
  }
  logExport(`export ${sessionId} finished frames=${session.framesWritten}`);
  if (session.tempPath !== session.config.outPath) {
    await fs.rename(session.tempPath, session.config.outPath);
  }
  sendProgress(getWindow(), {
    sessionId,
    phase: 'done',
    framesWritten: session.framesWritten,
    outPath: session.config.outPath,
  });
  return { outPath: session.config.outPath };
}

export async function cancelExport(rawSessionId: unknown): Promise<void> {
  const sessionId = z.string().parse(rawSessionId);
  const session = sessions.get(sessionId);
  if (!session) return;
  session.cancelled = true;
  logExport(`export ${sessionId} cancelled frames=${session.framesWritten}`);
  session.proc.kill('SIGKILL');
  sessions.delete(sessionId);
  await session.exited; // the file is only safe to delete once ffmpeg is gone
  await discardPartial(session);
}

/** Kill every live export and drop partial files (app quit, renderer crash). */
export async function abortAllExports(): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => cancelExport(id)));
}

/** Movies only: sequences keep the frames already written. */
async function discardPartial(session: ExportSession): Promise<void> {
  if (session.config.format === 'png-sequence') return;
  await session.exited;
  await fs.rm(session.tempPath, { force: true });
}

async function ffmpegDied(session: ExportSession): Promise<Error> {
  const code = await session.exited;
  const detail = session.stderrTail.join('').slice(-500);
  await discardPartial(session);
  return new Error(
    session.cancelled ? 'Export cancelled' : `FFmpeg stopped (code ${code}): ${detail}`,
  );
}

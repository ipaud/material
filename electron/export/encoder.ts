import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BrowserWindow } from 'electron';
import { ffmpegPath } from '../media/ffmpeg';
import { IPC, type ExportConfig, type ExportProgressEvent } from '../../shared/ipc';
import { isApprovedMediaPath } from '../filesystem/mediaRegistry';

export const exportConfigSchema = z.object({
  format: z.enum(['png-sequence', 'h264']),
  width: z.number().int().min(16).max(8192),
  height: z.number().int().min(16).max(8192),
  fps: z.number().min(1).max(120),
  outPath: z.string().min(1),
  audioPath: z.string().nullable(),
  audioStartSec: z.number().min(0),
  durationSec: z.number().positive(),
});

interface ExportSession {
  id: string;
  config: ExportConfig;
  proc: ChildProcessByStdio<Writable, null, Readable>;
  framesWritten: number;
  stderrTail: string[];
  cancelled: boolean;
}

const sessions = new Map<string, ExportSession>();

function sendProgress(win: BrowserWindow | null, event: ExportProgressEvent): void {
  win?.webContents.send(IPC.exportProgress, event);
}

function buildFfmpegArgs(config: ExportConfig): string[] {
  const args = [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${config.width}x${config.height}`,
    '-r', String(config.fps),
    '-i', '-',
  ];
  if (config.format === 'h264') {
    if (config.audioPath) {
      args.push('-ss', String(config.audioStartSec), '-t', String(config.durationSec), '-i', config.audioPath);
    }
    args.push(
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', '18',
      '-preset', 'medium',
      '-movflags', '+faststart',
    );
    if (config.audioPath) {
      args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
    }
    args.push(config.outPath);
  } else {
    // PNG sequence into the chosen directory.
    args.push('-c:v', 'png', path.join(config.outPath, 'frame_%05d.png'));
  }
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

  const proc = spawn(ffmpegPath, buildFfmpegArgs(config), {
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  const session: ExportSession = {
    id: randomUUID(),
    config,
    proc,
    framesWritten: 0,
    stderrTail: [],
    cancelled: false,
  };
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
  await new Promise<void>((resolve, reject) => {
    const ok = session.proc.stdin.write(buffer, (err) => (err ? reject(err) : undefined));
    if (ok) resolve();
    else session.proc.stdin.once('drain', resolve);
  });
  session.framesWritten++;
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
  const code = await new Promise<number>((resolve) => {
    session.proc.on('close', (c) => resolve(c ?? -1));
  });
  sessions.delete(sessionId);
  if (session.cancelled) {
    sendProgress(getWindow(), { sessionId, phase: 'cancelled', framesWritten: session.framesWritten });
    throw new Error('Export cancelled');
  }
  if (code !== 0) {
    const detail = session.stderrTail.join('').slice(-500);
    sendProgress(getWindow(), {
      sessionId,
      phase: 'error',
      framesWritten: session.framesWritten,
      message: `FFmpeg exited with code ${code}`,
    });
    throw new Error(`FFmpeg failed (code ${code}): ${detail}`);
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
  session.proc.kill('SIGKILL');
  sessions.delete(sessionId);
  // Best-effort cleanup of partial h264 output.
  if (session.config.format === 'h264') {
    await fs.rm(session.config.outPath, { force: true });
  }
}

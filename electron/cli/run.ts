import type { BrowserWindow } from 'electron';
import { probeMedia } from '../media/probe';
import type { CliCommand } from './args';
import { EXIT } from './validate';

type Rendering = Extract<CliCommand, { command: 'render' }>;
const POLL_MS = 500;

/** One JSON object per line on stdout; nothing else ever goes there. */
export function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bridgeReady(win: BrowserWindow): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const ok = await win.webContents.executeJavaScript('typeof window.__materialCli === "object"');
    if (ok === true) return;
    await sleep(100);
  }
  throw new Error('The renderer never exposed the CLI bridge');
}

interface Status {
  phase: string;
  frame: number;
  totalFrames: number;
}

export async function runRender(win: BrowserWindow, cmd: Rendering): Promise<number> {
  if (cmd.audio) await probeMedia(cmd.audio); // validates and approves it for the encoder
  await bridgeReady(win);
  const job = { project: cmd.project, out: cmd.out, codec: cmd.codec, audio: cmd.audio, fps: cmd.fps, range: cmd.range };
  const work = win.webContents.executeJavaScript(
    `window.__materialCli.render(${JSON.stringify(job)})`,
  ) as Promise<{ out: string; frames: number }>;
  let finished = false;
  void work.then(
    () => (finished = true),
    () => (finished = true),
  );

  let lastFrame = -1;
  const reporter = (async () => {
    while (!finished) {
      await sleep(POLL_MS);
      if (finished || !cmd.jsonProgress) continue;
      const s = (await win.webContents.executeJavaScript('window.__materialCli.status()')) as Status;
      if (s.phase === 'running' && s.frame !== lastFrame) {
        lastFrame = s.frame;
        emit({ event: 'progress', frame: s.frame, totalFrames: s.totalFrames });
      }
    }
  })();

  try {
    const result = await work;
    await reporter;
    emit({ event: 'done', out: result.out, frames: result.frames });
    return EXIT.ok;
  } catch (err) {
    await reporter.catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    emit({ event: 'error', message });
    process.stderr.write(`${message}\n`);
    return EXIT.failed;
  }
}

export async function runAnalyze(
  win: BrowserWindow,
  cmd: Extract<CliCommand, { command: 'analyze-audio' }>,
): Promise<number> {
  try {
    await probeMedia(cmd.audio); // validates the path and approves it for the renderer
    await bridgeReady(win);
    const result = await win.webContents.executeJavaScript(
      `window.__materialCli.analyzeAudio(${JSON.stringify(cmd.audio)}, ${JSON.stringify(cmd.threshold)})`,
    );
    emit({ event: 'result', ...(result as Record<string, unknown>) });
    return EXIT.ok;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ event: 'error', message });
    process.stderr.write(`${message}\n`);
    return EXIT.failed;
  }
}

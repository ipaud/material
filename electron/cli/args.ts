import path from 'node:path';

export type CliCodec = 'prores422hq' | 'prores4444' | 'h264';

export type CliCommand =
  | {
      command: 'render';
      project: string;
      out: string;
      codec: CliCodec;
      fps: number | null;
      range: [number, number] | null;
      jsonProgress: boolean;
    }
  | { command: 'validate'; project: string }
  | { command: 'analyze-audio'; audio: string }
  | { command: 'error'; message: string };

const CODECS: readonly CliCodec[] = ['prores422hq', 'prores4444', 'h264'];
const COMMANDS = ['render', 'validate', 'analyze-audio'];

/** Split `--opt=value` into two tokens so both spellings parse the same way. */
function tokens(argv: readonly string[]): string[] {
  return argv.flatMap((a) => {
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    return eq === -1 ? [a] : [a.slice(0, eq), a.slice(eq + 1)];
  });
}

const fail = (message: string): CliCommand => ({ command: 'error', message });

/**
 * argv is everything AFTER the executable (and the app path in dev). Returns
 * null for a normal GUI launch so the caller can fall through untouched.
 */
export function parseCli(argv: readonly string[], cwd: string = process.cwd()): CliCommand | null {
  const abs = (p: string) => path.resolve(cwd, p);
  const [command, ...rest] = tokens(argv);
  if (!command || !COMMANDS.includes(command)) return null;

  const positional: string[] = [];
  const opts = new Map<string, string>();
  let jsonProgress = false;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i] as string;
    if (t === '--json-progress') jsonProgress = true;
    else if (t === '--json') continue; // analyze-audio is always JSON
    else if (t === '--out' || t === '--codec' || t === '--fps' || t === '--range') {
      const value = rest[++i];
      if (value === undefined) return fail(`${t} needs a value`);
      opts.set(t, value);
    } else if (t.startsWith('--')) return fail(`Unknown option ${t}`);
    else positional.push(t);
  }

  const file = positional[0];
  if (command === 'analyze-audio') {
    if (!file) return fail('analyze-audio needs an audio file');
    return { command, audio: abs(file) };
  }
  if (!file) return fail(`${command} needs a project file`);
  if (command === 'validate') return { command, project: abs(file) };

  const out = opts.get('--out');
  if (!out) return fail('render needs --out <file>');
  const codec = (opts.get('--codec') ?? 'prores422hq') as CliCodec;
  if (!CODECS.includes(codec)) return fail(`Unknown codec ${codec} (use ${CODECS.join(', ')})`);
  let fps: number | null = null;
  if (opts.has('--fps')) {
    fps = Number(opts.get('--fps'));
    if (!Number.isFinite(fps) || fps < 1 || fps > 120) return fail('--fps must be 1–120');
  }
  let range: [number, number] | null = null;
  if (opts.has('--range')) {
    const parts = (opts.get('--range') as string).split(':').map(Number);
    const [a, b] = parts;
    if (parts.length !== 2 || a === undefined || b === undefined || !(a >= 0) || !(b > a)) {
      return fail('--range must be start:end in seconds, with end after start');
    }
    range = [a, b];
  }
  return { command: 'render', project: abs(file), out: abs(out), codec, fps, range, jsonProgress };
}

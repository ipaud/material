import type { ShaderParamDef } from '@shared/schemas/shaderPack';
import { composeFragment, preludeLineCount, staticShaderIssues } from './contract';

/**
 * v0.5A — compiling pack GLSL without letting a typo take the app down.
 *
 * three compiles lazily, on the first render that uses a material, and reports
 * failures by writing to the console. That is the wrong shape for user content:
 * by the time it happens the frame is already being drawn, and the message is a
 * driver log against a string the author never wrote.
 *
 * So the host compiles the fragment ITSELF first, with raw WebGL, against a
 * source it assembled and whose line offsets it therefore knows exactly. Only
 * a shader that survives that becomes a ShaderMaterial.
 */

export interface ShaderCompileError {
  /** 1-based line in the AUTHOR's file, when the log gave us one. */
  line: number | null;
  message: string;
}

export interface ShaderCompileResult {
  ok: boolean;
  errors: ShaderCompileError[];
  /** The exact text handed to the compiler — for diagnostics, not for display. */
  composed: string;
}

/** `ERROR: 0:37: 'x' : undeclared identifier` → line 37. */
const LOG_LINE = /^(?:ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/;

function parseLog(log: string, offset: number): ShaderCompileError[] {
  const out: ShaderCompileError[] = [];
  for (const raw of log.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = LOG_LINE.exec(line);
    if (m) {
      const reported = Number(m[1]);
      // Below the offset means the failure is in the host prelude, which the
      // author cannot fix and should not be blamed for.
      const userLine = reported - offset;
      out.push({ line: userLine > 0 ? userLine : null, message: (m[2] ?? line).trim() });
    } else if (/^(ERROR|WARNING)/.test(line)) {
      out.push({ line: null, message: line });
    }
  }
  if (out.length === 0) out.push({ line: null, message: log.trim() || 'shader failed to compile' });
  return out;
}

/**
 * Compile a candidate fragment shader and report what went wrong, in the
 * author's own line numbering. Leaves no GL object behind either way.
 */
export function validateFragment(
  gl: WebGL2RenderingContext,
  params: readonly ShaderParamDef[],
  userSource: string,
): ShaderCompileResult {
  const composed = composeFragment(params, userSource);
  const staticIssues = staticShaderIssues(userSource);
  if (staticIssues.length > 0) {
    return { ok: false, errors: staticIssues.map((message) => ({ line: null, message })), composed };
  }

  const withVersion = `#version 300 es\n${composed}`;
  // +1 for the #version line the host adds here.
  const offset = preludeLineCount(params) + 1;

  const shader = gl.createShader(gl.FRAGMENT_SHADER);
  if (!shader) {
    return {
      ok: false,
      errors: [{ line: null, message: 'could not allocate a shader object' }],
      composed,
    };
  }
  try {
    gl.shaderSource(shader, withVersion);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) === true) {
      return { ok: true, errors: [], composed };
    }
    return { ok: false, errors: parseLog(gl.getShaderInfoLog(shader) ?? '', offset), composed };
  } finally {
    gl.deleteShader(shader);
  }
}

/** Human-readable, one line per problem, naming the author's own lines. */
export function formatCompileErrors(
  shaderName: string,
  errors: readonly ShaderCompileError[],
): string {
  const body = errors
    .map((e) => (e.line === null ? `  ${e.message}` : `  line ${e.line}: ${e.message}`))
    .join('\n');
  return `${shaderName}\n${body}`;
}

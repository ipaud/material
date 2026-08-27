import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_SVG_BYTES = 4 * 1024 * 1024;

/**
 * Sanitize untrusted SVG text with a conservative strip-list.
 * Defense in depth: the renderer additionally rasterizes SVG through an
 * <img> element, where browsers already disable scripting and external
 * loads — this pass removes the dangerous constructs outright.
 */
export function sanitizeSvg(svgText: string): string {
  let out = svgText;
  // Remove script/foreignObject elements entirely (with content).
  out = out.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
  out = out.replace(/<script\b[^>]*\/>/gi, '');
  out = out.replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, '');
  // Remove inline event handlers (onload, onclick, ...).
  out = out.replace(/\son\w+\s*=\s*"[^"]*"/gi, '');
  out = out.replace(/\son\w+\s*=\s*'[^']*'/gi, '');
  // Neutralize javascript: and data:text/html URLs.
  out = out.replace(/(href|xlink:href)\s*=\s*(["'])\s*(javascript|data:text\/html)[^"']*\2/gi, '');
  // Strip external references (http(s), file) in href/src/url().
  out = out.replace(/(href|xlink:href|src)\s*=\s*(["'])\s*(https?|file):[^"']*\2/gi, '');
  out = out.replace(/url\(\s*(["']?)\s*(https?|file):[^)]*\)/gi, 'none');
  return out;
}

export async function readSanitizedSvg(filePath: string): Promise<string> {
  if (path.extname(filePath).toLowerCase() !== '.svg') {
    throw new Error('Not an SVG file');
  }
  const stats = await fs.stat(filePath);
  if (stats.size > MAX_SVG_BYTES) {
    throw new Error('SVG file is too large (max 4 MB)');
  }
  const text = await fs.readFile(filePath, 'utf8');
  if (!/<svg[\s>]/i.test(text)) {
    throw new Error('File does not contain an <svg> element');
  }
  return sanitizeSvg(text);
}

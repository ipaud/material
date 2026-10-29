// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Every .tsx file under src. */
function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

/** The opening `<select …>` tag, skipping `>` inside JSX braces such as `(e) => …`. */
function openingTags(source: string): { tag: string; line: number }[] {
  const tags: { tag: string; line: number }[] = [];
  for (let at = source.indexOf('<select'); at !== -1; at = source.indexOf('<select', at + 1)) {
    let depth = 0;
    let end = at;
    for (let i = at + '<select'.length; i < source.length; i++) {
      const c = source[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) { end = i; break; }
    }
    tags.push({ tag: source.slice(at, end + 1), line: source.slice(0, at).split('\n').length });
  }
  return tags;
}

describe('every select has an accessible name', () => {
  it('carries aria-label or aria-labelledby (axe select-name, WCAG 4.1.2)', () => {
    // The 0.9.3 axe audit found eight unnamed selects in BUILD alone; a screen
    // reader announced them only as "pop-up button".
    const unnamed = tsxFiles(join(process.cwd(), 'src')).flatMap((file) =>
      openingTags(readFileSync(file, 'utf8'))
        .filter(({ tag }) => !/aria-label(ledby)?=/.test(tag))
        .map(({ line }) => `${file.replace(process.cwd() + '/', '')}:${line}`),
    );
    expect(unnamed).toEqual([]);
  });
});

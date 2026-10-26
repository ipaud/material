import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function channelToLinear(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminance([red, green, blue]: [number, number, number]): number {
  return 0.2126 * channelToLinear(red) + 0.7152 * channelToLinear(green) + 0.0722 * channelToLinear(blue);
}

function contrast(foreground: [number, number, number], background: [number, number, number]): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function hexRgb(hex: string): [number, number, number] {
  return hex.match(/[\da-f]{2}/gi)!.map((channel) => Number.parseInt(channel, 16)) as [number, number, number];
}

describe('text and signal contrast', () => {
  it('meets WCAG AA for every text token on every base surface', () => {
    const tokens = readFileSync(resolve(__dirname, '../src/styles/tokens.css'), 'utf8');
    const textTokens = [...tokens.matchAll(/--(text-[012]):\s*rgba\(255,\s*255,\s*255,\s*([\d.]+)\)/g)];
    const surfaces = [...tokens.matchAll(/--surface-\d:\s*(#[\da-f]{6})/gi)].map((match) => match[1]!);

    expect(textTokens).toHaveLength(3);
    expect(surfaces).toHaveLength(4);
    for (const [, token, alphaValue] of textTokens) {
      const alpha = Number(alphaValue);
      expect(Number.isFinite(alpha), `${token} alpha`).toBe(true);
      for (const surface of surfaces) {
        const background = hexRgb(surface);
        const foreground = background.map((channel) => Math.round(255 * alpha + channel * (1 - alpha))) as [number, number, number];
        expect(contrast(foreground, background), `${token} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps status and action text colors at WCAG AA on every base surface', () => {
    const tokens = readFileSync(resolve(__dirname, '../src/styles/tokens.css'), 'utf8');
    const colors = [...tokens.matchAll(/--(accent|mod|danger|ok):\s*(#[\da-f]{6})/gi)];
    const surfaces = [...tokens.matchAll(/--surface-\d:\s*(#[\da-f]{6})/gi)].map((match) => match[1]!);

    expect(colors).toHaveLength(4);
    for (const [, token, color] of colors) {
      for (const surface of surfaces) {
        expect(contrast(hexRgb(color!), hexRgb(surface!)), `${token} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    const darkestSurface = surfaces[0]!;
    for (const [, token, color] of colors) {
      expect(contrast(hexRgb(darkestSurface), hexRgb(color!)), `${darkestSurface} text on ${token} fill`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('uses a defined text token for the empty-state source hint', () => {
    const appStyles = readFileSync(resolve(__dirname, '../src/app/app.css'), 'utf8');
    const tokens = readFileSync(resolve(__dirname, '../src/styles/tokens.css'), 'utf8');
    expect(appStyles).toMatch(/\.empty-state-source-hint\s*\{[^}]*color:\s*var\(--text-2\)/s);
    expect(tokens).toMatch(/--text-2:\s*rgba\(/);
  });
});

describe('narrow viewport accessibility', () => {
  it('wraps the titlebar and keeps workspace navigation horizontally reachable', () => {
    const styles = readFileSync(resolve(__dirname, '../src/app/app.css'), 'utf8');
    const narrow = styles.split('@media (max-width: 480px)')[1] ?? '';
    expect(narrow).toContain('grid-template-rows: auto minmax(0, 1fr)');
    expect(narrow).toMatch(/\.titlebar\s*\{[^}]*flex-wrap:\s*wrap/s);
    expect(narrow).toMatch(/\.workspace-nav\s*\{[^}]*overflow-x:\s*auto/s);
  });

  it('keeps short high-zoom workspaces scrollable without covering viewport controls', () => {
    const styles = readFileSync(resolve(__dirname, '../src/app/app.css'), 'utf8');
    const narrow = styles.split('@media (max-width: 480px)')[1] ?? '';
    expect(narrow).toMatch(/\.workspace\s*\{[^}]*overflow-y:\s*auto/s);
    expect(narrow).toMatch(/\.workspace-build\s*\{[^}]*grid-template-rows:\s*auto minmax\(280px, 1fr\) auto auto/s);
    expect(narrow).toMatch(/\.empty-state\s*\{[^}]*max-height:\s*calc\(100% - 56px\)/s);
  });

  it('wraps shared empty-state copy within high-zoom narrow workspace width', () => {
    const styles = readFileSync(resolve(__dirname, '../src/app/app.css'), 'utf8');
    const narrow = styles.split('@media (max-width: 480px)')[1] ?? '';
    expect(narrow).toMatch(/\.ws-none\s*\{[^}]*min-width:\s*0/s);
    expect(narrow).toMatch(/\.ws-none\s*\{[^}]*max-width:\s*calc\(100% - 32px\)/s);
    expect(narrow).toMatch(/\.ws-none\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  });

  it('uses a two-pixel global focus indicator', () => {
    const styles = readFileSync(resolve(__dirname, '../src/styles/global.css'), 'utf8');
    expect(styles).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid/s);
  });

  it('stacks Explore and Output rails below workspace width breakpoint', () => {
    const explore = readFileSync(resolve(__dirname, '../src/explore/explore.css'), 'utf8');
    const output = readFileSync(resolve(__dirname, '../src/output/output.css'), 'utf8');
    expect(explore).toMatch(/@media \(max-width: 760px\)\s*\{[^}]*\.explore-main\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
    expect(output).toMatch(/@media \(max-width: 760px\)\s*\{[^}]*\.output-main\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  });

  it('reflows OUTPUT export actions at high-zoom narrow widths', () => {
    const output = readFileSync(resolve(__dirname, '../src/output/output.css'), 'utf8');
    const narrow = output.split('@media (max-width: 480px)').at(-1) ?? '';
    expect(narrow).toMatch(/\.workspace\.workspace-output\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/s);
    expect(narrow).toMatch(/\.output-main\s*\{[^}]*flex:\s*0 0 auto[^}]*min-height:\s*max-content[^}]*overflow:\s*visible/s);
    expect(narrow).toMatch(/\.workspace\.workspace-output \.output-rail\s*\{[^}]*min-height:\s*max-content[^}]*max-height:\s*none[^}]*overflow:\s*visible/s);
    expect(narrow).toMatch(/\.workspace\.workspace-output \.output-bar\s*\{[^}]*flex:\s*0 0 auto[^}]*height:\s*auto[^}]*flex-wrap:\s*wrap/s);
    expect(narrow).toMatch(/\.workspace\.workspace-output \.output-bar-note\s*\{[^}]*flex:\s*0 0 100%[^}]*margin-left:\s*0/s);
    expect(narrow).toMatch(/\.output-bar-spacer\s*\{[^}]*display:\s*none/s);
  });

  it('wraps Explore actions instead of clipping them on narrow viewports', () => {
    const explore = readFileSync(resolve(__dirname, '../src/explore/explore.css'), 'utf8');
    const narrow = explore.split('@media (max-width: 760px)').at(-1) ?? '';
    expect(narrow).toMatch(/\.explore-actions\s*\{[^}]*flex-wrap:\s*wrap/s);
    expect(narrow).toMatch(/\.explore-actions-spacer\s*\{[^}]*display:\s*none/s);
  });

  it('restores visible focus on form controls with local outline resets', () => {
    const styles = readFileSync(resolve(__dirname, '../src/styles/global.css'), 'utf8');
    for (const selector of ['.macro-name-input', '.timeline-num', '.param-input', '.select', '.preset-name-input', '.look-rename']) {
      expect(styles).toContain(`${selector}:focus-visible`);
    }
  });
});

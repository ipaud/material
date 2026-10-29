// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const css = (path: string) => readFileSync(path, 'utf8');

describe('pointer targets are at least 24×24 CSS px (WCAG 2.2 AA 2.5.8)', () => {
  // The 0.9.3 axe audit found 47 undersized targets across BUILD, EXPLORE and
  // PLAY (22px slider rows, 13–18px buttons and selects, a 7px toggle dot).
  it('defines the minimum once', () => {
    expect(css('src/styles/tokens.css')).toMatch(/--hit-min:\s*24px/);
  });

  it('parameter rows and slider tracks use it', () => {
    const slider = css('src/components/parameter-slider.css');
    expect(/\.param-row\s*\{[^}]*height:\s*var\(--hit-min\)/.exec(slider)).not.toBeNull();
    expect(/\.param-track\s*\{[^}]*height:\s*var\(--hit-min\)/.exec(slider)).not.toBeNull();
  });

  it('the mapping enable dot sits inside a full-size button', () => {
    const rule = /\.mod-enable\s*\{([^}]*)\}/.exec(css('src/inspector/modulation.css'))?.[1] ?? '';
    expect(rule).toMatch(/width:\s*var\(--hit-min\)/);
    expect(rule).toMatch(/height:\s*var\(--hit-min\)/);
  });

  it('shared controls get a minimum height whatever their own height says', () => {
    const block = /WCAG 2\.2 AA 2\.5\.8[\s\S]*?\{\s*min-height:\s*var\(--hit-min\);\s*\}/.exec(css('src/styles/global.css'))?.[0] ?? '';
    for (const cls of ['.select', '.vp-btn', '.inspector-section-header', '.perf-layer-fader', '.perf-layer-head']) {
      expect(block, cls).toContain(cls);
    }
  });
});

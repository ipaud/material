import { describe, expect, test } from 'vitest';
import { sanitizeSvg } from '@electron/media/svg';

describe('SVG sanitization', () => {
  test('strips script elements', () => {
    const dirty = '<svg><script>alert(1)</script><rect width="10" height="10"/></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain('<script');
    expect(clean).toContain('<rect');
  });

  test('strips inline event handlers', () => {
    const dirty = '<svg onload="evil()"><circle onclick=\'x()\' r="5"/></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(/on\w+=/);
    expect(clean).toContain('<circle');
  });

  test('removes javascript: hrefs', () => {
    const dirty = '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>';
    expect(sanitizeSvg(dirty)).not.toContain('javascript:');
  });

  test('removes external references', () => {
    const dirty =
      '<svg><image href="https://evil.example/x.png"/><use xlink:href="file:///etc/passwd"/></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain('https://');
    expect(clean).not.toContain('file://');
  });

  test('removes foreignObject', () => {
    const dirty = '<svg><foreignObject><body>html</body></foreignObject><rect/></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain('foreignObject');
    expect(clean).toContain('<rect');
  });

  test('keeps safe content intact', () => {
    const safe = '<svg viewBox="0 0 24 24"><path d="M12 2 L22 22 L2 22 Z" fill="#fff"/></svg>';
    expect(sanitizeSvg(safe)).toBe(safe);
  });
});

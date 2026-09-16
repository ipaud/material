import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { srgbEotf, srgbOetf } from '@/rendering/sampling';
import { GLSL_SRGB_OETF } from '@/rendering/shaders/chunks';

/**
 * v0.8.3 — the preview shows what the export writes.
 *
 * Measured before the fix: a 128/64 grey PNG through an identity technique
 * exported as 128/64 and previewed as 55/13 — the linear values. Every
 * intermediate target is SRGB8 (hardware decode on sample, encode on write),
 * so shaders handle linear light and targets store sRGB bytes; export reads
 * the bytes. The canvas is the one destination that is not an SRGB8 target,
 * and the raw blit put linear light on screen. One transfer at the canvas
 * write, and nowhere else, is the fix. After: preview 128/64, and through a
 * second layer at 0.5 screen both paths read 149/78 — the linear blend,
 * encoded.
 */
const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('the sRGB transfer', () => {
  it('round-trips the 8-bit codes the measurement used', () => {
    for (const code of [0, 13, 55, 64, 128, 149, 188, 255]) {
      expect(Math.round(srgbOetf(srgbEotf(code / 255)) * 255)).toBe(code);
    }
  });

  it('is the transfer the measurement showed — 128 previewed as 55', () => {
    expect(Math.round(srgbEotf(128 / 255) * 255)).toBe(55);
    expect(Math.round(srgbEotf(64 / 255) * 255)).toBe(13);
  });

  it('predicts the layered measurement: 128 over 128 at half screen → 149', () => {
    const l = srgbEotf(128 / 255);
    const screen = 1 - (1 - l) * (1 - l);
    expect(Math.round(srgbOetf(l + 0.5 * (screen - l)) * 255)).toBe(149);
  });

  it('the GLSL chunk is the same curve', () => {
    for (const k of ['12.92', '1.055', '0.055', '0.0031308', '1.0 / 2.4']) expect(GLSL_SRGB_OETF).toContain(k);
    expect(GLSL_SRGB_OETF).toMatch(/vec3 srgbOetf\(vec3 c\)/);
  });
});

describe('exactly one encode, at the canvas', () => {
  const engine = read('src/rendering/RenderEngine.ts');
  const transition = read('src/rendering/transition/TransitionCompositor.ts');

  it('the preview frame blits with encode; the export still does not', () => {
    const preview = engine.slice(engine.indexOf('private renderFrame()'), engine.indexOf('private blit('));
    expect(preview).toMatch(/this\.blit\(renderer, composed, \/\* encode \*\/ true\)/);
    const still = engine.slice(engine.indexOf('renderStill('));
    expect(still).toMatch(/this\.blit\(renderer, composed\);/);
    expect(still).not.toMatch(/encode \*\/ true/);
  });

  it('the single-opaque fast path no longer draws onto the canvas', () => {
    const preview = engine.slice(engine.indexOf('private renderFrame()'), engine.indexOf('private blit('));
    expect(preview).toMatch(/renderSingleOpaqueToOwnTarget\(renderer\)/);
    expect(preview).not.toMatch(/renderSingleOpaqueToCanvas/);
  });

  it('a preview transition encodes; an export transition does not', () => {
    const preview = engine.slice(engine.indexOf('private renderFrame()'), engine.indexOf('private blit('));
    expect(preview).toMatch(/this\.compWidth \/ Math\.max\(this\.compHeight, 1\),\s*\/\* encode \*\/ true,/);
    const still = engine.slice(engine.indexOf('renderStill('));
    expect(still).toMatch(/width \/ Math\.max\(height, 1\),\s*\);/);
    expect(transition).toMatch(/u\.uEncode!\.value = encode \? 1 : 0;/);
  });

  it('the blit encodes only when asked, so SRGB8 destinations are not double-encoded', () => {
    expect(engine).toMatch(/uEncode > 0\.5 \? srgbOetf\(c\.rgb\) : c\.rgb/);
    expect(engine).toMatch(/this\.blitMaterial\.uniforms\.uEncode!\.value = encode \? 1 : 0;/);
  });
});

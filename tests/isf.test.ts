import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ISF_PRELUDE, ISF_PRELUDE_LINES, convertIsf, extractIsfHeader, isfShaderEntry } from '@shared/isf/isf';
import { shaderParamSchema, shaderEntrySchema } from '@shared/schemas/shaderPack';
import { staticShaderIssues } from '@/shaders/contract';

/**
 * v0.5D — the ISF subset, and everything it deliberately refuses.
 *
 * The rule these defend: MATERIAL hosts SINGLE-PASS IMAGE FILTERS. Every
 * unsupported feature is detected and named, because "this shader did not
 * load" is not something a user can act on, and quietly loading a multipass
 * shader as if it were single-pass would be worse than refusing it.
 */

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'isf', name), 'utf8');

describe('supported: single-pass image filters', () => {
  it('accepts a minimal identity filter', () => {
    const r = convertIsf(fixture('identity.fs'), 'Identity');
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.description).toContain('Passes the frame');
    expect(r.credit).toBe('MATERIAL test fixture');
    // The body is passed through untouched; only a prelude is prepended.
    expect(r.fragment).toContain('gl_FragColor = IMG_THIS_PIXEL(inputImage);');
    expect(r.fragment.startsWith(ISF_PRELUDE)).toBe(true);
  });

  it('maps every supported input type onto a host control', () => {
    const r = convertIsf(fixture('controls.fs'), 'Controls');
    expect(r.errors).toEqual([]);
    const byId = Object.fromEntries(r.params.map((p) => [p.id, p]));

    expect(byId.level).toMatchObject({ type: 'float', min: 0, max: 2, default: 0.75, label: 'Level' });
    expect(byId.invert).toMatchObject({ type: 'bool', default: false });

    const mode = byId.mode as Extract<(typeof r.params)[number], { type: 'enum' }>;
    expect(mode.type).toBe('enum');
    // ISF `long` carries the shader's OWN numbers, which are not indices —
    // 0, 3, 7 here. The project stores a stable id; the uniform gets the number.
    expect(mode.options.map((o) => o.glslValue)).toEqual([0, 3, 7]);
    expect(mode.options.map((o) => o.label)).toEqual(['Off', 'Soft', 'Hard']);
    expect(mode.default).toBe(mode.options[1]!.value);

    // And every one of them survives the host's own schema.
    for (const p of r.params) expect(shaderParamSchema.safeParse(p).success).toBe(true);
  });

  it('produces a pack entry the manifest schema accepts', () => {
    const r = convertIsf(fixture('controls.fs'), 'Controls');
    const entry = isfShaderEntry(r, 'controls', 'shaders/isf.frag');
    const parsed = shaderEntrySchema.safeParse(entry);
    expect(parsed.success ? '' : JSON.stringify(parsed.error?.issues)).toBe('');
  });

  it('the converted source passes the host static checks', () => {
    for (const name of ['identity.fs', 'controls.fs', 'time-pulse.fs']) {
      const r = convertIsf(fixture(name), name);
      // The prelude declares the host identifiers, so only the ISF BODY is
      // checked — a shader must not be blamed for the host's own declarations.
      const body = r.fragment.slice(ISF_PRELUDE.length);
      expect(staticShaderIssues(body), name).toEqual([]);
    }
  });

  it('TIME and RENDERSIZE resolve to the host contract, not a wall clock', () => {
    expect(ISF_PRELUDE).toContain('#define TIME uMaterial_time');
    expect(ISF_PRELUDE).toContain('#define RENDERSIZE uMaterial_resolution');
    expect(ISF_PRELUDE).toContain('#define isf_FragNormCoord vUv');
    expect(ISF_PRELUDE).toContain('#define inputImage uMaterial_source');
    const r = convertIsf(fixture('time-pulse.fs'), 'Pulse');
    expect(r.ok).toBe(true);
  });

  it('renames a non-standard primary image input onto the source', () => {
    const source = `/*{ "ISFVSN": "2", "INPUTS": [ { "NAME": "srcTex", "TYPE": "image" } ] }*/
void main() { gl_FragColor = IMG_THIS_PIXEL(srcTex); }`;
    const r = convertIsf(source, 'Renamed');
    expect(r.ok).toBe(true);
    expect(r.fragment).toContain('#define srcTex uMaterial_source');
  });
});

describe('unsupported ISF features are refused BY NAME (§105)', () => {
  const cases: [string, string][] = [
    ['multipass.fs', 'MULTIPASS'],
    ['persistent.fs', 'PERSISTENT_BUFFER'],
    ['generator.fs', 'GENERATOR'],
    ['two-images.fs', 'MULTIPLE_IMAGE_INPUTS'],
    ['audio.fs', "ISF type 'audioFFT'"],
  ];
  for (const [file, expected] of cases) {
    it(`${file} → ${expected}`, () => {
      const r = convertIsf(fixture(file), file);
      expect(r.ok).toBe(false);
      expect(r.errors.join(' | ')).toContain(expected);
    });
  }

  it('there is no partial multipass support hiding anywhere', () => {
    // A shader that declares PASSES must be refused, not quietly rendered as
    // its first pass — which would look like it worked.
    const r = convertIsf(fixture('multipass.fs'), 'Multi');
    expect(r.ok).toBe(false);
    expect(ISF_PRELUDE).toContain('const int PASSINDEX = 0;');
    expect(ISF_PRELUDE.includes('PASSES')).toBe(false);
  });

  it('a file with no ISF header is refused clearly', () => {
    const r = convertIsf('void main() { gl_FragColor = vec4(1.0); }', 'Bare');
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('no ISF metadata');
  });

  it('malformed ISF JSON reports the parser message, not a crash', () => {
    const r = convertIsf('/*{ "INPUTS": [ }*/\nvoid main() {}', 'Broken');
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('not valid JSON');
  });

  it('a long input with fewer than two values is refused', () => {
    const source = `/*{ "INPUTS": [ { "NAME": "inputImage", "TYPE": "image" }, { "NAME": "m", "TYPE": "long", "VALUES": [1] } ] }*/
void main() { gl_FragColor = vec4(1.0); }`;
    expect(convertIsf(source, 'x').errors.join(' ')).toContain('at least two VALUES');
  });

  it('color and point2D are refused, named, until a host control exists', () => {
    for (const type of ['color', 'point2D', 'event']) {
      const source = `/*{ "INPUTS": [ { "NAME": "inputImage", "TYPE": "image" }, { "NAME": "x", "TYPE": "${type}" } ] }*/
void main() { gl_FragColor = vec4(1.0); }`;
      expect(convertIsf(source, 'x').errors.join(' ')).toContain(`ISF type '${type}'`);
    }
  });
});

describe('line numbering survives conversion (§109)', () => {
  it('the header is replaced by blank lines, so body lines keep their number', () => {
    const extracted = extractIsfHeader(fixture('identity.fs'))!;
    const original = fixture('identity.fs').split('\n');
    const body = extracted.body.split('\n');
    const mainLine = original.findIndex((l) => l.includes('void main'));
    expect(body[mainLine]).toContain('void main');
  });

  it('the prelude length is known, so an error can be mapped back', () => {
    expect(ISF_PRELUDE_LINES).toBe(ISF_PRELUDE.split('\n').length - 1);
    expect(ISF_PRELUDE_LINES).toBeGreaterThan(10);
  });
});

describe('structural — an imported ISF is just a pack shader (§110)', () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

  it('import converts once and installs, rather than adapting per frame', () => {
    const fs = read('electron', 'filesystem', 'shaderPacks.ts');
    expect(fs).toContain('convertIsf');
    expect(fs).toContain('installIsfFrom');
    // It goes through the same manifest validation as any other pack.
    expect(fs).toContain('shaderPackManifestSchema.safeParse(manifest)');
  });

  it('the renderer has no ISF code path at all', () => {
    // Matched as a word, because `Number.isFinite` contains those letters and
    // a crude substring check made this pass for the wrong reason once.
    for (const f of ['CustomShaderRenderer.ts', 'contract.ts', 'packRegistry.ts']) {
      const src = read('src', 'shaders', f);
      expect(/\bISF\b/i.test(src), `${f} should not know about ISF`).toBe(false);
      expect(src.includes('shared/isf'), `${f} imports the ISF adapter`).toBe(false);
    }
  });
});

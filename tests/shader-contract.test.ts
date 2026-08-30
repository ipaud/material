import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PACK_LIMITS,
  SHADER_CONTRACT_VERSION,
  customTechniqueId,
  parseCustomTechniqueId,
  shaderPackManifestSchema,
  shaderParamSchema,
  type ShaderParamDef,
} from '@shared/schemas/shaderPack';
import {
  HOST_UNIFORMS,
  composeFragment,
  paramUniformName,
  preludeLineCount,
  staticShaderIssues,
} from '@/shaders/contract';
import { customTechniqueDefinition, missingShaderDefinition } from '@/shaders/customTechnique';
import { allParams, defaultParams } from '@/techniques/types';
import { shaderHash } from '@/shaders/shaderHash';

/**
 * v0.5A — Shader Contract v1, as tests.
 *
 * The product principle these defend: a shader pack extends the visual
 * vocabulary WITHOUT being handed the application. Everything below is a way
 * of saying that precisely enough to fail when it stops being true.
 */

const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

const floatParam = (over: Partial<Extract<ShaderParamDef, { type: 'float' }>> = {}) =>
  shaderParamSchema.parse({
    type: 'float',
    id: 'amount',
    label: 'Amount',
    min: 0,
    max: 1,
    default: 0.5,
    ...over,
  });

describe('the contract is data and GLSL — never code (§14)', () => {
  it('the manifest schema has no place to put executable content', () => {
    const shape = JSON.stringify(shaderPackManifestSchema.shape);
    for (const forbidden of ['script', 'main', 'entry', 'module', 'exec', 'command', 'html']) {
      expect(shape.toLowerCase().includes(`"${forbidden}"`), `manifest exposes ${forbidden}`).toBe(false);
    }
  });

  it('a manifest carrying unknown fields is accepted, but they are dropped', () => {
    // Forward compatibility without a foothold: a future pack still loads, and
    // whatever it added does not survive into anything the app executes.
    const parsed = shaderPackManifestSchema.parse({
      format: 1,
      materialShaderVersion: 1,
      id: 'com.example.pack',
      name: 'Pack',
      version: '1.0.0',
      onLoad: 'alert(1)',
      shaders: [{ id: 'a', name: 'A', file: 'a.frag' }],
    });
    expect('onLoad' in parsed).toBe(false);
  });

  it('rejects a pack whose shader file escapes the pack root (§53)', () => {
    for (const file of ['../secrets.frag', '/etc/passwd', 'a/../../b.frag', './x/../../y.frag']) {
      const result = shaderPackManifestSchema.safeParse({
        format: 1,
        materialShaderVersion: 1,
        id: 'com.example.pack',
        name: 'Pack',
        version: '1.0.0',
        shaders: [{ id: 'a', name: 'A', file }],
      });
      expect(result.success, `${file} must be rejected`).toBe(false);
    }
  });

  it('rejects ids that are not legal GLSL identifiers', () => {
    for (const id of ['1abc', 'has space', 'has-dash', 'ünïcode', '', 'a'.repeat(49)]) {
      expect(shaderParamSchema.safeParse({ type: 'bool', id, label: 'x', default: true }).success).toBe(false);
    }
  });

  it('rejects a manifest written against a different contract version', () => {
    const bad = shaderPackManifestSchema.safeParse({
      format: 1,
      materialShaderVersion: SHADER_CONTRACT_VERSION + 1,
      id: 'com.example.pack',
      name: 'Pack',
      version: '1.0.0',
      shaders: [{ id: 'a', name: 'A', file: 'a.frag' }],
    });
    expect(bad.success).toBe(false);
  });

  it('bounds pack size so an accidental monster cannot be loaded', () => {
    expect(PACK_LIMITS.maxShaderBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(PACK_LIMITS.maxShadersPerPack).toBeLessThanOrEqual(64);
    expect(PACK_LIMITS.maxParamsPerShader).toBeLessThanOrEqual(32);
  });
});

describe('uniform namespaces cannot collide (§20, §21)', () => {
  it('host uniforms all sit under the reserved prefix', () => {
    for (const u of HOST_UNIFORMS) expect(u.startsWith('uMaterial_')).toBe(true);
  });

  it('a parameter becomes a namespaced uniform, never its raw label', () => {
    expect(paramUniformName('warp')).toBe('uParam_warp');
    const prelude = composeFragment([floatParam({ id: 'warp' })], '');
    expect(prelude).toContain('uniform float uParam_warp;');
    expect(prelude).not.toMatch(/uniform float warp;/);
  });

  it('redeclaring a host identifier is refused with a readable reason', () => {
    const issues = staticShaderIssues('uniform sampler2D uMaterial_source;\nvoid main() {}');
    expect(issues.join(' ')).toContain('uMaterial_source');
  });

  it('a pack cannot pick its own GLSL version', () => {
    expect(staticShaderIssues('#version 100\nvoid main() {}').join(' ')).toContain('#version');
  });

  it('obvious unbounded loops are refused before the driver ever sees them', () => {
    expect(staticShaderIssues('void main() { while (true) {} }').join(' ')).toContain('while(true)');
    expect(staticShaderIssues('void main() { for(;;) {} }').join(' ')).toContain('for(;;)');
  });

  it('a shader with no main is refused', () => {
    expect(staticShaderIssues('float f() { return 1.0; }').join(' ')).toContain('no void main()');
  });

  it('comments cannot smuggle a reserved declaration past the check', () => {
    // ...and equally, a mention inside a comment must not be a false positive.
    expect(staticShaderIssues('// uniform sampler2D uMaterial_source;\nvoid main() {}')).toEqual([]);
  });
});

describe('compile errors are reported in the author own line numbers (§16)', () => {
  it('the prelude line count is exact, so the offset is exact', () => {
    const params = [floatParam()];
    const composed = composeFragment(params, 'LINE_ONE\nLINE_TWO\n');
    const lines = composed.split('\n');
    expect(lines[preludeLineCount(params)]).toBe('LINE_ONE');
    expect(lines[preludeLineCount(params) + 1]).toBe('LINE_TWO');
  });
});

describe('a pack shader is an ordinary technique (§26)', () => {
  const shader = {
    packId: 'com.example.pack',
    packName: 'Pack',
    packVersion: '1.0.0',
    entry: {
      id: 'demo',
      name: 'Demo',
      description: 'd',
      file: 'demo.frag',
      params: [
        floatParam({ id: 'amount', label: 'Amount' }),
        shaderParamSchema.parse({ type: 'int', id: 'steps', label: 'Steps', min: 2, max: 8, default: 4, group: 'Color' }),
        shaderParamSchema.parse({ type: 'bool', id: 'mono', label: 'Mono', default: false, group: 'Color' }),
        shaderParamSchema.parse({
          type: 'enum',
          id: 'mode',
          label: 'Mode',
          group: 'Motion',
          default: 'a',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
        }),
      ],
      presets: [],
    },
    fragment: 'void main() { fragColor = vec4(1.0); }',
    hash: 'abc-def',
  };

  it('produces a TechniqueDefinition the rest of the app already understands', () => {
    const def = customTechniqueDefinition(shader);
    expect(def.id).toBe('custom:com.example.pack:demo');
    expect(typeof def.createRenderer).toBe('function');
    // Order follows the PRODUCT's group order, not the manifest's — so two
    // packs that declare the same parameters lay out the same way.
    const ids = allParams(def).map((p) => p.id);
    expect(ids).toEqual(['amount', 'mode', 'steps', 'mono']);
    // Defaults come out of the same helper every native technique uses, which
    // is why the inspector, Explore and Looks need no shader-specific code.
    expect(defaultParams(def)).toEqual({ amount: 0.5, steps: 4, mono: false, mode: 'a' });
  });

  it('groups parameters into the product own sections, not arbitrary ones', () => {
    const def = customTechniqueDefinition(shader);
    expect(def.sections.map((s) => s.label)).toEqual(['Structure', 'Motion', 'Color']);
  });

  it('clamps a hostile numeric range into something a control can express (§69)', () => {
    const wild = customTechniqueDefinition({
      ...shader,
      entry: {
        ...shader.entry,
        params: [floatParam({ id: 'x', min: -1e20, max: 1e20, default: 1e19 })],
      },
    });
    const p = allParams(wild)[0] as { min: number; max: number; default: number };
    expect(Number.isFinite(p.min) && Math.abs(p.min) <= 1e6).toBe(true);
    expect(Math.abs(p.max)).toBeLessThanOrEqual(1e6);
    expect(p.default).toBeLessThanOrEqual(p.max);
    expect(p.default).toBeGreaterThanOrEqual(p.min);
  });

  it('an enum stores its option VALUE, never its label (§82)', () => {
    const def = customTechniqueDefinition(shader);
    const mode = allParams(def).find((p) => p.id === 'mode') as { options: { value: string }[] };
    expect(mode.options.map((o) => o.value)).toEqual(['a', 'b']);
    expect(defaultParams(def).mode).toBe('a');
  });
});

describe('identity and missing dependencies (§29, §31)', () => {
  it('technique ids round-trip, including dotted pack ids', () => {
    const id = customTechniqueId('com.example.my-pack', 'softWarp');
    expect(parseCustomTechniqueId(id)).toEqual({ packId: 'com.example.my-pack', shaderId: 'softWarp' });
    expect(parseCustomTechniqueId('mosaic')).toBeNull();
    expect(parseCustomTechniqueId('custom:')).toBeNull();
    expect(parseCustomTechniqueId('custom:onlypack')).toBeNull();
  });

  it('the hash covers the parameter contract, not just the source', () => {
    const entry = { id: 'a', name: 'A', description: '', file: 'a.frag', params: [floatParam()], presets: [] };
    const base = shaderHash(entry, 'void main(){}');
    expect(shaderHash(entry, 'void main(){ }')).not.toBe(base);
    // Same source, different range: a saved project's stored value now means
    // something else, and the hash has to say so.
    expect(shaderHash({ ...entry, params: [floatParam({ max: 4 })] }, 'void main(){}')).not.toBe(base);
  });

  it('a missing pack yields a pass-through that says what is missing', () => {
    const def = missingShaderDefinition('custom:not.installed:ghost');
    expect(def.name).toBe('Missing Shader Pack');
    expect(def.missing).toBe(true);
    // Not a substitute effect: it shows the frame, and no parameters, so a
    // project's stored values are neither reinterpreted nor discarded.
    expect(allParams(def)).toEqual([]);
  });
});

describe('structural — the host adds no new capability surface (§138)', () => {
  it('shader code cannot reach the filesystem, IPC, Node or the DOM', () => {
    for (const f of ['contract.ts', 'CustomShaderRenderer.ts', 'compileShader.ts', 'customTechnique.ts', 'packRegistry.ts']) {
      const src = read('src', 'shaders', f);
      for (const forbidden of ['ipcRenderer', 'window.material', 'require(', 'eval(', 'new Function', 'fetch(']) {
        expect(src.includes(forbidden), `${f} must not use ${forbidden}`).toBe(false);
      }
    }
  });

  it('MATERIAL owns the vertex shader — a pack supplies fragment only (§12)', () => {
    const contract = read('src', 'shaders', 'contract.ts');
    expect(contract).toContain('export const HOST_VERTEX');
    const renderer = read('src', 'shaders', 'CustomShaderRenderer.ts');
    expect(renderer).toContain('vertexShader: HOST_VERTEX');
    // There must be no path that takes vertex source from pack data.
    expect(renderer.includes('entry.vertex')).toBe(false);
    expect(read('shared', 'schemas', 'shaderPack.ts').includes('vertex')).toBe(false);
  });

  it('no compiled program or pixel crosses the Output channel (§27)', () => {
    const channel = read('shared', 'outputChannel.ts');
    expect(channel).toContain('customShaders');
    for (const forbidden of ['ShaderMaterial', 'WebGLProgram', 'Uint8Array', 'ImageData']) {
      expect(channel.includes(forbidden), `channel must not carry ${forbidden}`).toBe(false);
    }
  });

  it('the replica compiles locally and caches by hash (§28)', () => {
    const replica = read('src', 'output-window', 'replica.ts');
    expect(replica).toContain('syncCustomShaders');
    expect(replica).toContain('shaderSignatures');
    // Still no evaluation of creative state on the Output side.
    for (const forbidden of ['applyModulations', 'calibrationStore', 'evalSources']) {
      expect(replica.includes(forbidden), `replica must not use ${forbidden}`).toBe(false);
    }
  });

  it('time comes from composition time, never a wall clock (§8)', () => {
    const renderer = read('src', 'shaders', 'CustomShaderRenderer.ts');
    expect(renderer).toContain('u.uMaterial_time!.value = ctx.timeSec');
    expect(renderer.includes('Date.now')).toBe(false);
    expect(renderer.includes('performance.now')).toBe(false);
    expect(renderer.includes('Math.random')).toBe(false);
  });
});

describe('the bundled starter pack is authored against the shipped contract', () => {
  it('its manifest validates under the same schema an imported pack uses', () => {
    const manifest = JSON.parse(read('resources', 'shader-packs', 'material-starter', 'material-pack.json'));
    const parsed = shaderPackManifestSchema.safeParse(manifest);
    expect(parsed.success ? '' : JSON.stringify(parsed.error?.issues)).toBe('');
    expect(parsed.success && parsed.data.shaders.length).toBeGreaterThanOrEqual(5);
  });

  it('every declared shader file exists and declares no host identifier', () => {
    const manifest = shaderPackManifestSchema.parse(
      JSON.parse(read('resources', 'shader-packs', 'material-starter', 'material-pack.json')),
    );
    for (const entry of manifest.shaders) {
      const source = read('resources', 'shader-packs', 'material-starter', entry.file);
      expect(source.length).toBeGreaterThan(0);
      expect(staticShaderIssues(source), `${entry.id}`).toEqual([]);
      // Every uniform it reads must be one the host actually provides.
      for (const used of source.match(/uParam_[A-Za-z0-9_]+/g) ?? []) {
        const id = used.slice('uParam_'.length);
        expect(entry.params.some((p) => p.id === id), `${entry.id} uses undeclared ${used}`).toBe(true);
      }
    }
  });

  it('every preset only names parameters the shader declares (§78)', () => {
    const manifest = shaderPackManifestSchema.parse(
      JSON.parse(read('resources', 'shader-packs', 'material-starter', 'material-pack.json')),
    );
    for (const entry of manifest.shaders) {
      for (const preset of entry.presets) {
        for (const key of Object.keys(preset.params)) {
          expect(entry.params.some((p) => p.id === key), `${entry.id}/${preset.id}: unknown ${key}`).toBe(true);
        }
      }
    }
  });
});

describe('parameter definitions are checked as a WHOLE, not field by field (§118)', () => {
  const base = { id: 'x', label: 'X', min: 0, max: 1, default: 0.5 };

  it('refuses min greater than max', () => {
    // Found by an adversarial pack fixture in B and fixed here, in the
    // contract, rather than in the loader that happened to notice.
    const r = shaderParamSchema.safeParse({ ...base, type: 'float', min: 1, max: 0 });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('greater than max');
  });

  it('refuses a default outside its own range', () => {
    expect(shaderParamSchema.safeParse({ ...base, type: 'float', default: 5 }).success).toBe(false);
    expect(shaderParamSchema.safeParse({ ...base, type: 'float', default: -1 }).success).toBe(false);
    expect(shaderParamSchema.safeParse({ ...base, type: 'int', min: 2, max: 8, default: 9 }).success).toBe(false);
  });

  it('refuses an enum default that is not one of its options', () => {
    const r = shaderParamSchema.safeParse({
      type: 'enum',
      id: 'mode',
      label: 'Mode',
      default: 'c',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('not one of the options');
  });

  it('still accepts a well-formed parameter of every supported type', () => {
    expect(shaderParamSchema.safeParse({ ...base, type: 'float' }).success).toBe(true);
    expect(shaderParamSchema.safeParse({ id: 'n', label: 'N', type: 'int', min: 1, max: 4, default: 2 }).success).toBe(true);
    expect(shaderParamSchema.safeParse({ id: 'b', label: 'B', type: 'bool', default: true }).success).toBe(true);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import type * as PackModuleNS from '@electron/filesystem/shaderPacks';
import { PROJECT_FORMAT_VERSION } from '@shared/constants/app';

/**
 * v0.5B — pack loading and, mostly, pack REFUSING.
 *
 * The filesystem module runs in the main process and imports `electron`, which
 * does not exist here, so these tests exercise the same logic against a stub of
 * `app.getPath`. What is under test is the part that matters: which paths a
 * manifest can cause to be opened, and what happens when one tries to escape.
 */

const root = mkdtempSync(join(tmpdir(), 'material-packs-'));
const userData = join(root, 'userData');
mkdirSync(userData, { recursive: true });

// The module is imported lazily inside beforeAll (after Electron is stubbed),
// so its type comes from a type-only import rather than an inline one.
let packs: typeof PackModuleNS;

beforeAll(async () => {
  // Stub Electron before the module under test is imported.
  const electron = {
    app: { getPath: (_name: string) => userData },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  };
  const { vi } = await import('vitest');
  vi.doMock('electron', () => electron);
  packs = await import('@electron/filesystem/shaderPacks');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const manifest = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    format: 1,
    materialShaderVersion: 1,
    id: 'com.test.pack',
    name: 'Test Pack',
    version: '1.0.0',
    shaders: [{ id: 'demo', name: 'Demo', file: 'shaders/demo.frag' }],
    ...over,
  });

function makePack(name: string, manifestText: string, files: Record<string, string> = {}): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'shaders'), { recursive: true });
  writeFileSync(join(dir, 'material-pack.json'), manifestText, 'utf8');
  for (const [rel, body] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, body, 'utf8');
  }
  return dir;
}

const GOOD_FRAG = 'void main() { fragColor = texture(uMaterial_source, vUv); }';

describe('a valid pack installs into managed storage (§51)', () => {
  it('copies only the files the manifest declares', async () => {
    const dir = makePack('valid', manifest(), {
      'shaders/demo.frag': GOOD_FRAG,
      // Nothing should carry this across: installing is not mirroring.
      'README.md': 'hello',
      'stray/binary.bin': 'not a shader',
    });
    const result = await packs.installShaderPackFrom(dir);
    expect(result.error ?? '').toBe('');
    expect(result.ok).toBe(true);
    const installed = join(userData, 'shader-packs', 'com.test.pack');
    expect(existsSync(join(installed, 'material-pack.json'))).toBe(true);
    expect(existsSync(join(installed, 'shaders', 'demo.frag'))).toBe(true);
    expect(existsSync(join(installed, 'README.md'))).toBe(false);
    expect(existsSync(join(installed, 'stray'))).toBe(false);
  });

  it('appears in the installed list with its shader source read', async () => {
    const list = await packs.listShaderPacks();
    const pack = list.find((p) => p.id === 'com.test.pack');
    expect(pack).toBeDefined();
    expect(pack!.shaders).toHaveLength(1);
    expect(pack!.shaders[0]!.fragment).toContain('uMaterial_source');
    expect(pack!.shaders[0]!.hash).toMatch(/^[0-9a-f]{8}-[0-9a-f]{8}$/);
  });

  it('reinstalling REPLACES, so a deleted shader does not linger', async () => {
    const dir = makePack('valid2', manifest({ version: '2.0.0' }), { 'shaders/demo.frag': GOOD_FRAG });
    await packs.installShaderPackFrom(dir);
    const installed = join(userData, 'shader-packs', 'com.test.pack');
    // The v1 tree had exactly these entries; a stale extra would show here.
    expect(readdirSync(installed).sort()).toEqual(['material-pack.json', 'shaders']);
    const list = await packs.listShaderPacks();
    expect(list.find((p) => p.id === 'com.test.pack')!.version).toBe('2.0.0');
  });
});

describe('path security (§53)', () => {
  it('refuses a shader path that climbs out of the pack', async () => {
    writeFileSync(join(root, 'outside.frag'), GOOD_FRAG, 'utf8');
    const dir = makePack('escape', manifest({
      id: 'com.test.escape',
      shaders: [{ id: 'demo', name: 'Demo', file: '../outside.frag' }],
    }));
    const result = await packs.installShaderPackFrom(dir);
    // The manifest schema rejects `..` outright, so this never reaches the disk.
    expect(result.ok).toBe(false);
    expect(existsSync(join(userData, 'shader-packs', 'com.test.escape'))).toBe(false);
  });

  it('refuses an absolute shader path', async () => {
    const dir = makePack('abs', manifest({
      id: 'com.test.abs',
      shaders: [{ id: 'demo', name: 'Demo', file: '/etc/hosts' }],
    }));
    expect((await packs.installShaderPackFrom(dir)).ok).toBe(false);
  });

  it('refuses a SYMLINK that points outside the pack', async () => {
    // The lexical check passes here — the path really is relative and really
    // is inside the folder. Only resolving the link catches it.
    const secret = join(root, 'secret.frag');
    writeFileSync(secret, 'void main() { fragColor = vec4(1.0); }', 'utf8');
    const dir = makePack('symlink', manifest({
      id: 'com.test.symlink',
      shaders: [{ id: 'demo', name: 'Demo', file: 'shaders/link.frag' }],
    }));
    symlinkSync(secret, join(dir, 'shaders', 'link.frag'));
    const result = await packs.installShaderPackFrom(dir);
    expect(result.ok).toBe(false);
    expect(result.error ?? '').toContain('outside the pack');
  });

  it('refuses to remove anything outside the managed root', async () => {
    for (const id of ['../..', '/etc', 'com.test.pack/../../..', '..%2F..']) {
      const result = await packs.removeShaderPack(id);
      expect(result.ok, `${id} must be refused`).toBe(false);
    }
    // The real pack is still there.
    expect(existsSync(join(userData, 'shader-packs', 'com.test.pack'))).toBe(true);
  });
});

describe('malformed packs are refused, never crash (§54, §118)', () => {
  const cases: [string, string][] = [
    ['not JSON at all', '{ this is not json'],
    ['missing id', JSON.stringify({ format: 1, materialShaderVersion: 1, name: 'x', version: '1.0.0', shaders: [] })],
    ['no shaders', manifest({ id: 'com.test.empty', shaders: [] })],
    ['wrong contract version', manifest({ id: 'com.test.future', materialShaderVersion: 99 })],
    ['bad semver', manifest({ id: 'com.test.semver', version: 'one' })],
    [
      'duplicate shader ids',
      manifest({
        id: 'com.test.dupe',
        shaders: [
          { id: 'demo', name: 'A', file: 'shaders/demo.frag' },
          { id: 'demo', name: 'B', file: 'shaders/demo.frag' },
        ],
      }),
    ],
    [
      'min greater than max',
      manifest({
        id: 'com.test.range',
        shaders: [{
          id: 'demo', name: 'Demo', file: 'shaders/demo.frag',
          params: [{ id: 'x', label: 'X', type: 'float', min: 1, max: 0, default: 5 }],
        }],
      }),
    ],
    [
      'NaN default',
      manifest({
        id: 'com.test.nan',
        shaders: [{
          id: 'demo', name: 'Demo', file: 'shaders/demo.frag',
          params: [{ id: 'x', label: 'X', type: 'float', min: 0, max: 1, default: null }],
        }],
      }),
    ],
    [
      'enum with one option',
      manifest({
        id: 'com.test.enum',
        shaders: [{
          id: 'demo', name: 'Demo', file: 'shaders/demo.frag',
          params: [{ id: 'x', label: 'X', type: 'enum', default: 'a', options: [{ value: 'a', label: 'A' }] }],
        }],
      }),
    ],
  ];

  for (const [label, text] of cases) {
    it(`refuses: ${label}`, async () => {
      const dir = makePack(`bad-${label.replace(/\W+/g, '-')}`, text, { 'shaders/demo.frag': GOOD_FRAG });
      const result = await packs.installShaderPackFrom(dir);
      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe('string');
      expect((result.error ?? '').length).toBeGreaterThan(0);
    });
  }

  it('refuses a manifest that declares a file which is not there', async () => {
    const dir = makePack('missing-file', manifest({ id: 'com.test.missing' }));
    const result = await packs.installShaderPackFrom(dir);
    expect(result.ok).toBe(false);
    expect(result.error ?? '').toContain('no usable shaders');
  });

  it('a broken pack in the folder does not stop the others loading (§134)', async () => {
    const broken = join(userData, 'shader-packs', 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'material-pack.json'), '{{{', 'utf8');
    const list = await packs.listShaderPacks();
    // The good pack is still there, and the broken one reports why.
    expect(list.find((p) => p.id === 'com.test.pack')?.shaders).toHaveLength(1);
    const bad = list.find((p) => p.id === 'broken');
    expect(bad?.shaders).toHaveLength(0);
    expect(bad?.warnings.join(' ')).toContain('valid JSON');
  });

  it('an oversized shader is skipped with a reason, not loaded', async () => {
    const dir = makePack('huge', manifest({ id: 'com.test.huge' }), {
      'shaders/demo.frag': `${GOOD_FRAG}\n// ${'x'.repeat(300 * 1024)}`,
    });
    const result = await packs.installShaderPackFrom(dir);
    expect(result.ok).toBe(false);
    expect(result.error ?? '').toContain('exceeds');
  });
});

describe('structural — the renderer never gets a filesystem (§138, §143)', () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

  it('the preload exposes pack DATA, never a path API', () => {
    const preload = read('electron', 'preload', 'index.ts');
    expect(preload).toContain('listShaderPacks');
    expect(preload).toContain('importShaderPack');
    // No generic file access sneaks in alongside.
    for (const forbidden of ['readFile', 'writeFile', 'readdir', 'require(', 'node:fs']) {
      expect(preload.includes(forbidden), `preload must not expose ${forbidden}`).toBe(false);
    }
  });

  it('the import dialog is owned by main, not by the renderer', () => {
    const manager = read('src', 'shaders', 'packManager.ts');
    expect(manager).toContain('window.material.importShaderPack()');
    for (const forbidden of ['showOpenDialog', 'input type="file"', 'fs.']) {
      expect(manager.includes(forbidden)).toBe(false);
    }
  });

  it('a pack is never executed — only parsed and compiled as GLSL', () => {
    const fsModule = read('electron', 'filesystem', 'shaderPacks.ts');
    for (const forbidden of ['eval(', 'new Function', 'child_process', 'exec(', 'spawn(', 'vm.']) {
      expect(fsModule.includes(forbidden), `pack loader must not use ${forbidden}`).toBe(false);
    }
  });
});

describe('a project that references a pack (§135, §136)', () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

  it('stores a reference, never the shader source', () => {
    // Embedding GLSL would make a document carry code from elsewhere and fork
    // silently from the pack it came from.
    const schema = read('shared', 'schemas', 'project.ts');
    expect(schema.includes('fragment')).toBe(false);
    expect(schema.includes('LoadedShader')).toBe(false);
    // The technique instance is unchanged: id, enabled, params.
    expect(schema).toContain('techniqueId: z.string()');
  });

  it('a custom technique id is an ordinary v3 project field', async () => {
    const { parseProject } = await import('@shared/schemas/project');
    const base = JSON.parse(
      readFileSync(join(__dirname, 'fixtures', 'project-v2-pattern.json'), 'utf8'),
    ) as Record<string, unknown>;
    // A v2 fixture: migration puts its single branch on layer 1, so the
    // custom technique id is set there.
    const migrated = parseProject(base);
    const parsed = parseProject({
      ...migrated,
      layers: [
        {
          ...migrated.layers[0]!,
          technique: {
            id: 't1',
            techniqueId: 'custom:com.example.pack:demo',
            enabled: true,
            params: { amount: 0.42 },
          },
        },
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed.version).toBe(PROJECT_FORMAT_VERSION);
    expect(parsed.layers[0]!.technique!.techniqueId).toBe('custom:com.example.pack:demo');
    // The values survive whether or not the pack is installed.
    expect(parsed.layers[0]!.technique!.params.amount).toBe(0.42);
  });

  it('no absolute path from the authoring machine is written into a project', () => {
    const projectShaders = read('src', 'shaders', 'projectShaders.ts');
    expect(projectShaders.includes('dir')).toBe(false);
    expect(projectShaders.includes('path')).toBe(false);
  });
});

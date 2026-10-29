// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type * as PackModuleNS from '@electron/filesystem/shaderPacks';

/**
 * Shader packs, the parts tests/shader-packs.test.ts leaves out: ISF import, removal (which takes an
 * id from the renderer), the dialogs, and the path tricks a manifest can try. Real files in a temp
 * userData; Electron is stubbed.
 */

const root = mkdtempSync(join(tmpdir(), 'material-packs-install-'));
const userData = join(root, 'userData');
const packsDir = join(userData, 'shader-packs');
const dialog = vi.hoisted(() => ({ showOpenDialog: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => userData }, dialog }));

let packs: typeof PackModuleNS;
beforeAll(async () => {
  packs = await import('@electron/filesystem/shaderPacks');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(packsDir, { recursive: true, force: true });
  mkdirSync(userData, { recursive: true });
  dialog.showOpenDialog.mockReset();
});

const isf = readFileSync(join(__dirname, 'fixtures', 'isf', 'controls.fs'), 'utf8');
const FRAG = 'void main(){ gl_FragColor = texture2D(uMaterial_source, vUv); }';

function pack(name: string, shaders: object[], files: Record<string, string> = {}, extra: object = {}): string {
  const dir = join(root, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'shaders'), { recursive: true });
  writeFileSync(
    join(dir, 'material-pack.json'),
    JSON.stringify({ format: 1, materialShaderVersion: 1, id: `com.test.${name}`, name, version: '1.0.0', shaders, ...extra }),
  );
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
  return dir;
}

describe('ISF import', () => {
  it('converts an ISF file into a managed single-shader pack', async () => {
    const file = join(root, 'Glow Bloom.fs');
    writeFileSync(file, isf);
    const result = await packs.installIsfFrom(file);
    expect(result.ok).toBe(true);
    expect(result.pack!.id).toBe('isf.glowbloom');
    expect(result.pack!.shaders).toHaveLength(1);
    expect(existsSync(join(packsDir, 'isf.glowbloom', 'shaders', 'isf.frag'))).toBe(true);
    expect((await packs.listShaderPacks()).map((p) => p.id)).toEqual(['isf.glowbloom']);
  });

  it('refuses what it cannot host, with the reason', async () => {
    const multipass = join(root, 'multi.fs');
    writeFileSync(multipass, '/*{ "ISFVSN": "2", "PASSES": [ {"TARGET":"a"}, {} ] }*/\nvoid main(){ gl_FragColor = vec4(1.0); }');
    const result = await packs.installIsfFrom(multipass);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();

    expect(await packs.installIsfFrom(join(root, 'missing.fs'))).toEqual({ ok: false, error: 'not a file' });
    const huge = join(root, 'huge.fs');
    writeFileSync(huge, 'x'.repeat(256 * 1024 + 1));
    expect((await packs.installIsfFrom(huge)).error).toMatch(/exceeds/);
    expect(existsSync(packsDir) ? (await packs.listShaderPacks()).length : 0).toBe(0);
  });
});

describe('removal takes an id from the renderer', () => {
  it('removes an installed pack by id', async () => {
    const dir = pack('gone', [{ id: 'demo', name: 'Demo', file: 'shaders/demo.frag' }], { 'shaders/demo.frag': FRAG });
    expect((await packs.installShaderPackFrom(dir)).ok).toBe(true);
    expect(await packs.removeShaderPack('com.test.gone')).toEqual({ ok: true });
    expect(existsSync(join(packsDir, 'com.test.gone'))).toBe(false);
  });

  it('refuses anything that is not a plain pack id', async () => {
    mkdirSync(packsDir, { recursive: true });
    writeFileSync(join(userData, 'keep.txt'), 'precious');
    for (const bad of ['..', '../keep.txt', '/etc', 'a/b', '', 42, null, 'UPPER']) {
      expect(await packs.removeShaderPack(bad)).toEqual({ ok: false, error: 'invalid pack id' });
    }
    expect(readFileSync(join(userData, 'keep.txt'), 'utf8')).toBe('precious');
  });

  it('nothing installed yet is fine', async () => {
    expect(await packs.removeShaderPack('com.test.none')).toEqual({ ok: true });
  });
});

describe('what a manifest can point at', () => {
  it('a manifest naming an absolute path or ../ is refused as a whole', async () => {
    for (const file of [join(root, 'secret.frag'), '../secret.frag']) {
      const dir = pack('escape', [{ id: 'x', name: 'X', file }]);
      const result = await packs.installShaderPackFrom(dir);
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/not a valid pack/) });
    }
    expect(existsSync(join(packsDir, 'com.test.escape'))).toBe(false);
  });

  it('a symlink out of the pack, or a folder, is skipped with a warning and never copied', async () => {
    const outside = join(root, 'secret.frag');
    writeFileSync(outside, FRAG);
    const dir = pack(
      'tricks',
      [
        { id: 'ok', name: 'OK', file: 'shaders/ok.frag' },
        { id: 'dir', name: 'Dir', file: 'shaders' },
        { id: 'link', name: 'Link', file: 'shaders/link.frag' },
      ],
      { 'shaders/ok.frag': FRAG },
    );
    symlinkSync(outside, join(dir, 'shaders', 'link.frag'));
    const result = await packs.installShaderPackFrom(dir);
    expect(result.ok).toBe(true);
    expect(result.pack!.shaders.map((s) => s.entry.id)).toEqual(['ok']);
    expect(existsSync(join(packsDir, 'com.test.tricks', 'shaders', 'link.frag'))).toBe(false);
  });

  it('a pack whose every shader is unusable is not installed', async () => {
    const dir = pack('empty', [{ id: 'gone', name: 'Gone', file: 'shaders/missing.frag' }]);
    expect(await packs.installShaderPackFrom(dir)).toMatchObject({ ok: false, error: expect.stringMatching(/^no usable shaders: gone:/) });
  });

  it('an oversized manifest is refused before it is parsed', async () => {
    const dir = pack('big', [], {}, { description: 'x'.repeat(256 * 1024) });
    const result = await packs.installShaderPackFrom(dir);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/larger than/) });
  });

  it('enum and bool parameters are part of the shader identity hash', async () => {
    const shader = (params: object[]) => [{ id: 'demo', name: 'Demo', file: 'shaders/demo.frag', params }];
    const a = await packs.installShaderPackFrom(
      pack('ha', shader([{ id: 'm', label: 'M', type: 'enum', default: 'x', options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }] }]), { 'shaders/demo.frag': FRAG }),
    );
    const b = await packs.installShaderPackFrom(
      pack('hb', shader([{ id: 'm', label: 'M', type: 'bool', default: true }]), { 'shaders/demo.frag': FRAG }),
    );
    expect(a.pack!.shaders[0]!.hash).not.toBe(b.pack!.shaders[0]!.hash);
  });

  it('stray files in the packs folder are not packs', async () => {
    mkdirSync(packsDir, { recursive: true });
    writeFileSync(join(packsDir, '.DS_Store'), '');
    expect(await packs.listShaderPacks()).toEqual([]);
  });
});

describe('dialogs', () => {
  it('cancelling either picker installs nothing', async () => {
    dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await packs.importShaderPack()).toEqual({ ok: false });
    expect(await packs.importIsfFile()).toEqual({ ok: false });
  });

  it('a picked folder or file goes through the same install', async () => {
    const dir = pack('picked', [{ id: 'demo', name: 'Demo', file: 'shaders/demo.frag' }], { 'shaders/demo.frag': FRAG });
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [dir] });
    expect((await packs.importShaderPack()).ok).toBe(true);

    const file = join(root, 'Picked.fs');
    writeFileSync(file, isf);
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [file] });
    expect((await packs.importIsfFile()).pack?.id).toBe('isf.picked');
  });
});

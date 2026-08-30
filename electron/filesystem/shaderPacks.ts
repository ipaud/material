import { app, dialog } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  PACK_LIMITS,
  shaderPackManifestSchema,
  type LoadedPack,
  type LoadedShader,
  type ShaderPackManifest,
} from '../../shared/schemas/shaderPack';

/**
 * v0.5B — shader packs on disk, in a location MATERIAL manages.
 *
 * Everything here runs in the MAIN process, on purpose. The renderer never
 * receives a filesystem API: it asks for the installed packs and gets back
 * validated data. A pack that wanted to read something it should not have no
 * way to ask, because the only paths ever opened are the ones its own manifest
 * declares, resolved and then checked to still be inside the pack.
 *
 * Installing copies the DECLARED FILES ONLY — the manifest and the shaders it
 * names — rather than mirroring a folder. An allow-list of files falls out of
 * that for free, and nothing incidental (a stray binary, a symlink, a
 * node_modules) can ride along.
 */

const MANIFEST = 'material-pack.json';

export function packsRoot(): string {
  return path.join(app.getPath('userData'), 'shader-packs');
}

/**
 * Resolve `relative` inside `root`, refusing anything that escapes.
 *
 * Two separate checks, because they catch different attacks: the lexical one
 * stops `../` and absolute paths before touching the disk, and the realpath one
 * stops a symlink that points outside — which looks perfectly innocent until
 * it is followed.
 */
async function resolveInside(root: string, relative: string): Promise<string | null> {
  if (path.isAbsolute(relative)) return null;
  if (relative.split(/[\\/]/).includes('..')) return null;
  const rootReal = await fs.realpath(root).catch(() => null);
  if (rootReal === null) return null;
  const target = path.resolve(rootReal, relative);
  if (target !== rootReal && !target.startsWith(rootReal + path.sep)) return null;
  const targetReal = await fs.realpath(target).catch(() => null);
  if (targetReal === null) return null;
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) return null;
  const stat = await fs.lstat(targetReal).catch(() => null);
  if (!stat || !stat.isFile()) return null;
  return targetReal;
}

async function readManifest(dir: string): Promise<ShaderPackManifest> {
  const manifestPath = path.join(dir, MANIFEST);
  const stat = await fs.stat(manifestPath);
  if (stat.size > PACK_LIMITS.maxManifestBytes) {
    throw new Error(`${MANIFEST} is larger than ${PACK_LIMITS.maxManifestBytes} bytes`);
  }
  const text = await fs.readFile(manifestPath, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`${MANIFEST} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = shaderPackManifestSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(
      `${MANIFEST} is not a valid pack: ${first ? `${first.path.join('.')} ${first.message}` : 'unknown problem'}`,
    );
  }
  const ids = new Set<string>();
  for (const s of parsed.data.shaders) {
    if (ids.has(s.id)) throw new Error(`duplicate shader id '${s.id}'`);
    ids.add(s.id);
  }
  return parsed.data;
}

/** FNV-1a, mirroring the renderer's hash so both sides agree. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function hashOf(entry: ShaderPackManifest['shaders'][number], fragment: string): string {
  const contract = JSON.stringify({
    id: entry.id,
    params: entry.params.map((p) =>
      p.type === 'enum'
        ? { i: p.id, t: p.type, o: p.options.map((o) => o.value), d: p.default }
        : p.type === 'bool'
          ? { i: p.id, t: p.type, d: p.default }
          : { i: p.id, t: p.type, min: p.min, max: p.max, d: p.default },
    ),
  });
  return `${fnv1a(fragment)}-${fnv1a(contract)}`;
}

async function loadPackFrom(dir: string): Promise<LoadedPack> {
  const manifest = await readManifest(dir);
  const warnings: string[] = [];
  const shaders: LoadedShader[] = [];
  for (const entry of manifest.shaders) {
    const file = await resolveInside(dir, entry.file);
    if (!file) {
      warnings.push(`${entry.id}: '${entry.file}' is missing or resolves outside the pack`);
      continue;
    }
    const stat = await fs.stat(file);
    if (stat.size > PACK_LIMITS.maxShaderBytes) {
      warnings.push(`${entry.id}: source exceeds ${PACK_LIMITS.maxShaderBytes} bytes`);
      continue;
    }
    const fragment = await fs.readFile(file, 'utf8');
    shaders.push({
      packId: manifest.id,
      packName: manifest.name,
      packVersion: manifest.version,
      entry,
      fragment,
      hash: hashOf(entry, fragment),
    });
  }
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author,
    description: manifest.description,
    dir,
    shaders,
    warnings,
  };
}

/**
 * Every installed pack.
 *
 * Defensive by construction: one bad pack contributes a warning entry and the
 * rest still load. A pack that cannot be parsed must never be able to stop
 * MATERIAL from starting.
 */
export async function listShaderPacks(): Promise<LoadedPack[]> {
  const root = packsRoot();
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const out: LoadedPack[] = [];
  for (const dirent of entries.slice(0, PACK_LIMITS.maxFilesScanned)) {
    if (!dirent.isDirectory()) continue;
    const dir = path.join(root, dirent.name);
    try {
      out.push(await loadPackFrom(dir));
    } catch (err) {
      out.push({
        id: dirent.name,
        name: dirent.name,
        version: '0.0.0',
        author: '',
        description: '',
        dir,
        shaders: [],
        warnings: [(err as Error).message],
      });
    }
  }
  return out;
}

export interface ImportResult {
  ok: boolean;
  pack?: LoadedPack;
  error?: string;
}

/** Ask for a folder, validate it, then copy only what the manifest declares. */
export async function importShaderPack(): Promise<ImportResult> {
  const picked = await dialog.showOpenDialog({
    title: 'Import Shader Pack',
    message: 'Choose a folder containing material-pack.json',
    properties: ['openDirectory'],
  });
  if (picked.canceled || picked.filePaths.length === 0) return { ok: false };
  return installShaderPackFrom(picked.filePaths[0] as string);
}

/** Split out from the dialog so it can be tested without one. */
export async function installShaderPackFrom(sourceDir: string): Promise<ImportResult> {
  let pack: LoadedPack;
  try {
    pack = await loadPackFrom(sourceDir);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  if (pack.shaders.length === 0) {
    return {
      ok: false,
      error: `no usable shaders: ${pack.warnings.join('; ') || 'the manifest declares none'}`,
    };
  }

  const destination = path.join(packsRoot(), pack.id);
  // The pack id decides the folder, and the id is a validated slug — but
  // resolve and check anyway, because a directory name is a filesystem path
  // and this one is derived from a file we did not write.
  const rootReal = await fs.mkdir(packsRoot(), { recursive: true }).then(
    () => fs.realpath(packsRoot()),
    () => null,
  );
  if (rootReal === null) return { ok: false, error: 'could not create the shader packs folder' };
  const destReal = path.resolve(rootReal, pack.id);
  if (!destReal.startsWith(rootReal + path.sep)) {
    return { ok: false, error: 'pack id does not resolve to a folder inside the packs directory' };
  }

  // Replace wholesale: a shader deleted between versions must not survive.
  await fs.rm(destReal, { recursive: true, force: true });
  await fs.mkdir(destReal, { recursive: true });
  await fs.writeFile(
    path.join(destReal, MANIFEST),
    await fs.readFile(path.join(sourceDir, MANIFEST), 'utf8'),
    'utf8',
  );
  for (const shader of pack.shaders) {
    const target = path.resolve(destReal, shader.entry.file);
    if (!target.startsWith(destReal + path.sep)) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, shader.fragment, 'utf8');
  }
  return { ok: true, pack: await loadPackFrom(destReal) };
}

export async function removeShaderPack(rawId: unknown): Promise<{ ok: boolean; error?: string }> {
  const id = typeof rawId === 'string' ? rawId : '';
  if (!/^[a-z0-9]+([._-][a-z0-9]+)*$/.test(id)) return { ok: false, error: 'invalid pack id' };
  const rootReal = await fs.realpath(packsRoot()).catch(() => null);
  if (rootReal === null) return { ok: true };
  const target = path.resolve(rootReal, id);
  if (!target.startsWith(rootReal + path.sep)) return { ok: false, error: 'refused: outside root' };
  await fs.rm(target, { recursive: true, force: true });
  return { ok: true };
}

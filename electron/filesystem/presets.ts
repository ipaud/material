import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { presetFileSchema, presetSchema, type Preset } from '../../shared/schemas/preset';

function presetsPath(): string {
  return path.join(app.getPath('userData'), 'presets.json');
}

async function readFile(): Promise<Preset[]> {
  try {
    const text = await fs.readFile(presetsPath(), 'utf8');
    return presetFileSchema.parse(JSON.parse(text)).presets;
  } catch {
    return [];
  }
}

async function writeFile(presets: Preset[]): Promise<void> {
  const payload = JSON.stringify({ version: 1, presets }, null, 2);
  await fs.mkdir(path.dirname(presetsPath()), { recursive: true });
  await fs.writeFile(presetsPath(), payload, 'utf8');
}

export async function listUserPresets(): Promise<Preset[]> {
  return readFile();
}

export async function saveUserPreset(raw: unknown): Promise<void> {
  const preset = presetSchema.parse(raw);
  const existing = await readFile();
  const next = [...existing.filter((p) => p.id !== preset.id), { ...preset, builtin: false }];
  await writeFile(next);
}

export async function deleteUserPreset(id: string): Promise<void> {
  const existing = await readFile();
  await writeFile(existing.filter((p) => p.id !== id));
}

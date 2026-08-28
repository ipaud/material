import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Application preferences (Phase 18C) — machine/setup state, never creative
 * state. Same shape of solution as presets.json: one small zod-validated
 * JSON file in userData, missing/corrupt file degrades to defaults.
 *
 * Monitor topology belongs to the machine, not to the composition, so the
 * chosen output display lives HERE and never in the project. Note what is
 * deliberately absent: whether the output was open. Restoring that would
 * make MATERIAL seize a projector on launch.
 */

const settingsSchema = z.object({
  version: z.literal(1).default(1),
  lastOutputDisplayId: z.number().nullable().default(null),
  lastOutputMode: z.enum(['windowed', 'fullscreen']).default('fullscreen'),
});

export type AppSettings = z.infer<typeof settingsSchema>;

const DEFAULTS: AppSettings = settingsSchema.parse({});

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

let cache: AppSettings | null = null;

export async function readSettings(): Promise<AppSettings> {
  if (cache) return cache;
  try {
    const text = await fs.readFile(settingsPath(), 'utf8');
    cache = settingsSchema.parse(JSON.parse(text));
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = settingsSchema.parse({ ...(await readSettings()), ...patch });
  cache = next;
  try {
    await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
    await fs.writeFile(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
  } catch (error) {
    // A preference that cannot be written is not worth failing an action for.
    console.error('[settings] write failed:', error);
  }
  return next;
}

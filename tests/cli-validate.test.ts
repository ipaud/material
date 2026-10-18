import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateProject, EXIT } from '../electron/cli/validate';
import { createEmptyProject, triggerMappingSchema } from '../shared/schemas/project';

async function write(project: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mat-cli-'));
  const file = path.join(dir, 'p.material');
  await fs.writeFile(file, JSON.stringify(project));
  return file;
}

describe('validateProject', () => {
  it('a clean project exits 0', async () => {
    const { report, exit } = await validateProject(await write(createEmptyProject('ok')));
    expect(exit).toBe(EXIT.ok);
    expect(report.ok).toBe(true);
  });

  it('lists every schema problem and exits 2', async () => {
    const bad = (amount: number) => ({
      ...triggerMappingSchema.parse({ id: `t${amount}`, enabled: true, source: 'beat', action: 'pulse' }),
      amount,
    });
    const project = { ...createEmptyProject('bad'), triggers: [bad(2), bad(0.1), bad(-3)] };
    const { report, exit } = await validateProject(await write(project));
    expect(exit).toBe(EXIT.invalid);
    expect(report.issues.map((i) => i.path)).toEqual(['triggers[0].amount', 'triggers[2].amount']);
  });

  it('missing media exits 3 and names the files', async () => {
    const project = createEmptyProject('m');
    const withSource = {
      ...project,
      sources: [{ id: 's1', kind: 'video', path: '/nope/clip.mov', metadata: null }],
    };
    const { report, exit } = await validateProject(await write(withSource));
    expect(exit).toBe(EXIT.missingMedia);
    expect(report.missingMedia).toEqual(['/nope/clip.mov']);
  });

  it('corrupt JSON is a fatal invalid project, not a crash', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mat-cli-'));
    const file = path.join(dir, 'p.material');
    await fs.writeFile(file, '{nope');
    const { exit, report } = await validateProject(file);
    expect(exit).toBe(EXIT.invalid);
    expect(report.issues[0]?.text).toMatch(/corrupted/);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEmptyProject } from '@shared/schemas/project';
import { useProjectStore } from '@/state/projectStore';
import type { RecoveryEntry } from '@shared/ipc';

const paths = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => paths.userData } }));

import { clearRecovery, listRecoveries, writeRecovery } from '../electron/filesystem/recovery';
import { restoreRecovery } from '@/projects/autosave';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'material-recovery-'));
  paths.userData = tempDir;
  useProjectStore.getState().newProject();
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('crash recovery', () => {
  it('atomically replaces session snapshot and excludes current session from recovery list', async () => {
    const project = createEmptyProject('Recovered work');
    await writeRecovery('session-old', '/tmp/work.material', project);
    await writeRecovery('session-old', '/tmp/work.material', createEmptyProject('Updated work'));
    await writeRecovery('session-current', null, project);
    const dir = path.join(tempDir, 'recovery');

    expect((await fs.readdir(dir)).sort()).toEqual(['session-current.json', 'session-old.json']);
    const entries = await listRecoveries('session-current');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ sessionId: 'session-old', projectPath: '/tmp/work.material' });
    expect(entries[0]?.project.name).toBe('Updated work');
  });

  it('sorts recoveries newest first and preserves unreadable/future snapshots', async () => {
    await writeRecovery('session-old', null, createEmptyProject('Old'));
    await new Promise((resolve) => setTimeout(resolve, 2));
    await writeRecovery('session-new', null, createEmptyProject('New'));
    const dir = path.join(tempDir, 'recovery');
    await fs.writeFile(path.join(dir, 'broken.json'), '{');
    await fs.writeFile(path.join(dir, 'future.json'), JSON.stringify({
      version: 1,
      sessionId: 'future',
      savedAt: new Date().toISOString(),
      projectPath: null,
      project: { version: 999 },
    }));

    const entries = await listRecoveries('current');
    expect(entries.map((entry) => entry.sessionId)).toEqual(['session-new', 'session-old']);
    expect(await fs.readFile(path.join(dir, 'broken.json.corrupt'), 'utf8')).toBe('{');
    expect(JSON.parse(await fs.readFile(path.join(dir, 'future.json'), 'utf8')).project).toEqual({ version: 999 });
  });

  it('migrates an older recoverable project in memory without rewriting its snapshot', async () => {
    const dir = path.join(tempDir, 'recovery');
    await fs.mkdir(dir, { recursive: true });
    const currentProject = createEmptyProject('Legacy recovery');
    const v6Layer = { ...currentProject.layers[0]! };
    Reflect.deleteProperty(v6Layer, 'techniqueChain');
    const project = { ...currentProject, version: 6, layers: [v6Layer] };
    const raw = {
      version: 1,
      sessionId: 'session-v6',
      savedAt: new Date().toISOString(),
      projectPath: null,
      project,
    };
    const file = path.join(dir, 'session-v6.json');
    await fs.writeFile(file, JSON.stringify(raw));

    const [entry] = await listRecoveries('current');

    expect(entry?.project.version).toBe(7);
    expect(entry?.project.name).toBe('Legacy recovery');
    expect(JSON.parse(await fs.readFile(file, 'utf8')).project.version).toBe(6);
  });

  it('quarantines a snapshot whose session id does not match its filename', async () => {
    await writeRecovery('session-a', null, createEmptyProject('Valid snapshot'));
    const dir = path.join(tempDir, 'recovery');
    const mismatched = {
      version: 1,
      sessionId: 'session-a',
      savedAt: new Date().toISOString(),
      projectPath: null,
      project: createEmptyProject('Mismatched snapshot'),
    };
    await fs.writeFile(path.join(dir, 'other-session.json'), JSON.stringify(mismatched));

    const entries = await listRecoveries('current');

    expect(entries.map((entry) => entry.project.name)).toEqual(['Valid snapshot']);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'other-session.json.corrupt'), 'utf8'))).toEqual(mismatched);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'session-a.json'), 'utf8')).project.name).toBe('Valid snapshot');
  });

  it('quarantines snapshots with empty or invalid session ids', async () => {
    const dir = path.join(tempDir, 'recovery');
    await fs.mkdir(dir, { recursive: true });
    const snapshot = (sessionId: string) => ({
      version: 1,
      sessionId,
      savedAt: new Date().toISOString(),
      projectPath: null,
      project: createEmptyProject('Invalid session'),
    });
    await fs.writeFile(path.join(dir, '.json'), JSON.stringify(snapshot('')));
    await fs.writeFile(path.join(dir, 'bad_id.json'), JSON.stringify(snapshot('bad_id')));

    expect(await listRecoveries('current')).toEqual([]);
    expect(JSON.parse(await fs.readFile(path.join(dir, '.json.corrupt'), 'utf8')).sessionId).toBe('');
    expect(JSON.parse(await fs.readFile(path.join(dir, 'bad_id.json.corrupt'), 'utf8')).sessionId).toBe('bad_id');
  });

  it('restores into memory as dirty and preserves explicit Save As for unsaved work', async () => {
    const project = createEmptyProject('Recovered unsaved');
    const entry: RecoveryEntry = {
      version: 1,
      sessionId: 'session-unsaved',
      savedAt: new Date().toISOString(),
      projectPath: null,
      project,
    };

    restoreRecovery(entry);

    expect(useProjectStore.getState()).toMatchObject({ project, projectPath: null, dirty: true });
  });

  it('preserves original project path while requiring an explicit Save after restore', () => {
    const project = createEmptyProject('Recovered named project');
    const entry: RecoveryEntry = {
      version: 1,
      sessionId: 'session-named',
      savedAt: new Date().toISOString(),
      projectPath: '/tmp/original.material',
      project,
    };

    restoreRecovery(entry);

    expect(useProjectStore.getState()).toMatchObject({
      project,
      projectPath: '/tmp/original.material',
      dirty: true,
    });
  });

  it('clears one recovery without affecting another session', async () => {
    await writeRecovery('session-a', null, createEmptyProject('A'));
    await writeRecovery('session-b', null, createEmptyProject('B'));

    await clearRecovery('session-a');

    expect((await fs.readdir(path.join(tempDir, 'recovery'))).sort()).toEqual(['session-b.json']);
  });
});

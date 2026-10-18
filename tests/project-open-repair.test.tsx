import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readProjectFile } from '../electron/filesystem/projects';
import { ProjectRepairDialog } from '@/app/ProjectRepairDialog';
import { openProjectFromPath } from '@/projects/projectActions';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore } from '@/state/uiStore';
import { createEmptyProject, triggerMappingSchema } from '@shared/schemas/project';
import type { ReadProjectResult } from '@shared/ipc';

async function badProjectFile(amounts: number[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mat-open-'));
  const file = path.join(dir, 'bad.material');
  const triggers = amounts.map((amount, i) => ({
    ...triggerMappingSchema.parse({ id: `t${i}`, enabled: true, source: 'beat', action: 'pulse' }),
    amount,
  }));
  await fs.writeFile(file, JSON.stringify({ ...createEmptyProject('Bad'), triggers }));
  return file;
}

describe('readProjectFile (main process)', () => {
  test('invalid file returns the full issue list, repairable', async () => {
    const file = await badProjectFile([0.1, 0.2, 0.3, 1.125, 5]);
    const r = await readProjectFile(file);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.repairable).toBe(true);
    expect(r.issues.map((i) => i.text)).toEqual([
      'triggers[3].amount = 1.125 (max 1)',
      'triggers[4].amount = 5 (max 1)',
    ]);
  });

  test('repair=true opens with values clamped', async () => {
    const file = await badProjectFile([1.125]);
    const r = await readProjectFile(file, true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.triggers[0]!.amount).toBe(1);
    expect(r.repaired).toHaveLength(1);
  });
});

describe('opening an invalid project', () => {
  const issue = {
    path: 'triggers[3].amount',
    received: 1.125,
    max: 1,
    repairable: true,
    text: 'triggers[3].amount = 1.125 (max 1)',
  };
  let readProject: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useProjectStore.getState().newProject();
    useUiStore.setState({ pendingRepair: null });
    readProject = vi.fn(
      async (p: string, repair?: boolean): Promise<ReadProjectResult> =>
        repair
          ? { ok: true, path: p, project: createEmptyProject('Fixed'), repaired: [issue] }
          : { ok: false, path: p, issues: [issue], repairable: true },
    );
    (window as unknown as { material: unknown }).material = {
      readProject,
      probeMedia: vi.fn().mockRejectedValue(new Error('none')),
    };
  });
  afterEach(cleanup);

  test('shows a persistent dialog and leaves the open project intact', async () => {
    useProjectStore.getState().newProject();
    const before = useProjectStore.getState().project;
    await openProjectFromPath('/x/bad.material');
    expect(useProjectStore.getState().project).toBe(before);
    render(<ProjectRepairDialog />);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('triggers[3].amount = 1.125 (max 1)')).toBeInTheDocument();
  });

  test('Cancel closes without loading; Repair and open loads the fixed project', async () => {
    await openProjectFromPath('/x/bad.material');
    render(<ProjectRepairDialog />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(useUiStore.getState().pendingRepair).toBeNull();

    await openProjectFromPath('/x/bad.material');
    fireEvent.click(screen.getByText('Repair and open'));
    await vi.waitFor(() => expect(useProjectStore.getState().project.name).toBe('Fixed'));
    expect(readProject).toHaveBeenLastCalledWith('/x/bad.material', true);
    expect(useUiStore.getState().pendingRepair).toBeNull();
  });
});

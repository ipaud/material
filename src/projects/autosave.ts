import { useProjectStore } from '@/state/projectStore';
import type { RecoveryEntry } from '@shared/ipc';

const AUTOSAVE_INTERVAL_MS = 15_000;

let timer: ReturnType<typeof setInterval> | null = null;
let lastSavedProject: unknown = null;

/**
 * Periodic autosave into the app's recovery store.
 * Never touches the user's .material file — recovery is a separate artifact
 * and restoring it requires an explicit Save to become permanent.
 */
export function startAutosave(): () => void {
  if (timer) return stopAutosave;
  timer = setInterval(() => {
    const { project, projectPath, dirty } = useProjectStore.getState();
    if (!dirty || project === lastSavedProject) return;
    lastSavedProject = project;
    void window.material.writeRecovery(projectPath, project).catch(() => {
      // Autosave must never interrupt the user; failures are silent here and
      // surfaced only if recovery is later unavailable.
    });
  }, AUTOSAVE_INTERVAL_MS);
  return stopAutosave;
}

export function stopAutosave(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Recovery entries left by sessions that ended abnormally. */
export async function pendingRecoveries(): Promise<RecoveryEntry[]> {
  try {
    return await window.material.listRecoveries();
  } catch {
    return [];
  }
}

/**
 * Load a recovery entry into memory. The project is marked dirty and its
 * original path is preserved, so the user decides whether to overwrite.
 */
export function restoreRecovery(entry: RecoveryEntry): void {
  const store = useProjectStore.getState();
  store.loadProject(entry.projectPath ?? '', entry.project);
  if (!entry.projectPath) {
    // Unsaved project: no path to Save into, so force Save As on first save.
    useProjectStore.setState({ projectPath: null });
  }
  useProjectStore.setState({ dirty: true });
}

export async function discardRecovery(entry: RecoveryEntry): Promise<void> {
  try {
    await window.material.discardRecovery(entry.sessionId);
  } catch {
    /* already gone */
  }
}

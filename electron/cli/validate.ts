import { promises as fs } from 'node:fs';
import { readProjectFile } from '../filesystem/projects';

export const EXIT = { ok: 0, usage: 1, invalid: 2, missingMedia: 3, failed: 4 } as const;

export interface ValidateReport {
  ok: boolean;
  project: string;
  issues: Array<{ path: string; text: string; repairable: boolean }>;
  missingMedia: string[];
}

/** Full list of schema problems and missing media, no GUI, no first-error-only. */
export async function validateProject(file: string): Promise<{ report: ValidateReport; exit: number }> {
  const report: ValidateReport = { ok: false, project: file, issues: [], missingMedia: [] };
  let outcome;
  try {
    outcome = await readProjectFile(file);
  } catch (err) {
    // unreadable file / corrupt JSON / unsupported version: one fatal issue
    const text = err instanceof Error ? err.message : String(err);
    report.issues.push({ path: '', text, repairable: false });
    return { report, exit: EXIT.invalid };
  }
  if (!outcome.ok) {
    report.issues = outcome.issues.map(({ path, text, repairable }) => ({ path, text, repairable }));
    return { report, exit: EXIT.invalid };
  }
  for (const source of outcome.project.sources) {
    if (!('path' in source)) continue;
    try {
      await fs.access(source.path);
    } catch {
      report.missingMedia.push(source.path);
    }
  }
  report.ok = report.missingMedia.length === 0;
  return { report, exit: report.ok ? EXIT.ok : EXIT.missingMedia };
}

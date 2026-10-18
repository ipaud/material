import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PROJECT_EXTENSION } from '../../shared/constants/app';
import {
  parseProjectDetailed,
  projectSchema,
  repairProject,
  type Project,
  type ProjectIssue,
} from '../../shared/schemas/project';
import { approveMediaPath } from './mediaRegistry';
import { toAbsolutePaths, toPortablePaths } from './projectPaths';

function assertProjectPath(filePath: string): void {
  if (!path.isAbsolute(filePath)) throw new Error('Project path must be absolute');
  if (path.extname(filePath).toLowerCase() !== `.${PROJECT_EXTENSION}`) {
    throw new Error(`Project file must have the .${PROJECT_EXTENSION} extension`);
  }
}

export type ReadProjectOutcome =
  | { ok: true; project: Project; repaired: ProjectIssue[] }
  | { ok: false; issues: ProjectIssue[]; repairable: boolean };

export async function readProjectFile(filePath: string, repair = false): Promise<ReadProjectOutcome> {
  assertProjectPath(filePath);
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch {
    throw new Error(`Could not read project file: ${filePath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Project file is corrupted (invalid JSON)');
  }
  // v0.8: media stored relative to the project file becomes absolute here, so
  // everything above this line works exactly as it did when paths were only
  // ever absolute.
  const parsed = parseProjectDetailed(raw);
  let valid: Project;
  let repaired: ProjectIssue[] = [];
  if (parsed.ok) {
    valid = parsed.project;
  } else if (repair) {
    const fixed = repairProject(parsed.migrated);
    if (!fixed.ok) return { ok: false, issues: fixed.issues, repairable: false };
    valid = fixed.project;
    repaired = fixed.repaired;
  } else {
    // Dry run so the dialog can promise "Repair and open" only when it works.
    return {
      ok: false,
      issues: parsed.issues,
      repairable: repairProject(parsed.migrated).ok,
    };
  }
  const project = toAbsolutePaths(valid, filePath);
  // Re-approve referenced media so material:// can serve it after reopening.
  // Live sources (camera/screen/window) and generators have no file to
  // approve — only the file-backed variants carry a path.
  for (const source of project.sources) {
    if ('path' in source) approveMediaPath(source.path);
  }
  return { ok: true, project, repaired };
}

/** Atomic write: temp file in the same directory, then rename. */
export async function writeProjectFile(filePath: string, project: unknown): Promise<void> {
  assertProjectPath(filePath);
  // v0.8: relativise on the way out, so moving the folder keeps the links.
  const validated = toPortablePaths(projectSchema.parse(project), filePath);
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}`,
  );
  const json = JSON.stringify(validated, null, 2);
  await fs.writeFile(tmpPath, json, 'utf8');
  await fs.rename(tmpPath, filePath);
}

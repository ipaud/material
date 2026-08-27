import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PROJECT_EXTENSION } from '../../shared/constants/app';
import { parseProject, projectSchema, type Project } from '../../shared/schemas/project';
import { approveMediaPath } from './mediaRegistry';

function assertProjectPath(filePath: string): void {
  if (!path.isAbsolute(filePath)) throw new Error('Project path must be absolute');
  if (path.extname(filePath).toLowerCase() !== `.${PROJECT_EXTENSION}`) {
    throw new Error(`Project file must have the .${PROJECT_EXTENSION} extension`);
  }
}

export async function readProjectFile(filePath: string): Promise<Project> {
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
  const project = parseProject(raw);
  // Re-approve referenced media so material:// can serve it after reopening.
  for (const source of project.sources) {
    approveMediaPath(source.path);
  }
  return project;
}

/** Atomic write: temp file in the same directory, then rename. */
export async function writeProjectFile(filePath: string, project: unknown): Promise<void> {
  assertProjectPath(filePath);
  const validated = projectSchema.parse(project);
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}`,
  );
  const json = JSON.stringify(validated, null, 2);
  await fs.writeFile(tmpPath, json, 'utf8');
  await fs.rename(tmpPath, filePath);
}

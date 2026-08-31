import type { Project } from '@shared/schemas/project';
import type { LoadedShader } from '@shared/schemas/shaderPack';
import { parseCustomTechniqueId } from '@shared/schemas/shaderPack';
import { findShader } from './packRegistry';

/**
 * v0.5A — which pack shaders a project can actually reach.
 *
 * Sending the whole installed library to the Output would work and would be
 * wasteful; sending only the active technique would break the moment a morph
 * switched to a Look with a different custom shader, because a morph changes
 * the Output's technique id without any project change to ride along with.
 *
 * So: the active technique plus every pinned Look. Bounded by the project, not
 * by what happens to be installed.
 */
export function shadersReferencedBy(project: Project): LoadedShader[] {
  const ids = new Set<string>();
  for (const l of project.layers) if (l.technique) ids.add(l.technique.techniqueId);
  for (const look of project.pinnedLooks) for (const t of look.techniques) ids.add(t.techniqueId);

  const out: LoadedShader[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const ref = parseCustomTechniqueId(id);
    if (!ref) continue;
    const shader = findShader(ref.packId, ref.shaderId);
    // A missing pack contributes nothing: the replica shows the same
    // pass-through placeholder the editor does, rather than a stale shader.
    if (!shader || seen.has(shader.hash)) continue;
    seen.add(shader.hash);
    out.push(shader);
  }
  return out;
}

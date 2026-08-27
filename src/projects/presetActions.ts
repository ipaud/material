import { useProjectStore } from '@/state/projectStore';
import { reportError, useUiStore } from '@/state/uiStore';
import { withTechniqueEnsured } from '@/projects/projectActions';
import { uid } from '@/utils/id';
import type { Preset } from '@shared/schemas/preset';

/** Built-in starting points. Source media is never part of a preset. */
export const BUILTIN_PRESETS: Preset[] = [
  {
    id: 'builtin-clean-mosaic',
    name: 'Clean Mosaic',
    techniqueId: 'mosaic',
    params: { columns: 64, rows: 36, scale: 1, spacing: 0.15, lumToScale: 0.9 },
    material: { materialId: 'square', colorMode: 'source', params: { aspect: 1 }, assetPath: null },
    modulations: [],
    builtin: true,
  },
  {
    id: 'builtin-dense-grid',
    name: 'Dense Grid',
    techniqueId: 'mosaic',
    params: { columns: 160, rows: 90, scale: 1.1, spacing: 0, lumToScale: 1, contrast: 1.3 },
    material: { materialId: 'circle', colorMode: 'source', params: { aspect: 1 }, assetPath: null },
    modulations: [],
    builtin: true,
  },
  {
    id: 'builtin-broken-portrait',
    name: 'Broken Portrait',
    techniqueId: 'mosaic',
    params: {
      columns: 72,
      rows: 96,
      scale: 1.2,
      spacing: 0.05,
      lumToScale: 1,
      randomRotation: 0.12,
      jitterX: 0.35,
      jitterY: 0.2,
      threshold: 0.08,
    },
    material: { materialId: 'rectangle', colorMode: 'source', params: { aspect: 1 }, assetPath: null },
    modulations: [],
    builtin: true,
  },
  {
    id: 'builtin-halftone',
    name: 'Halftone',
    techniqueId: 'mosaic',
    params: { columns: 96, rows: 54, scale: 1.3, spacing: 0.1, lumToScale: 1, gamma: 1.4 },
    material: { materialId: 'dot', colorMode: 'mono', params: { aspect: 1 }, assetPath: null },
    modulations: [],
    builtin: true,
  },
];

export async function listAllPresets(): Promise<Preset[]> {
  try {
    const user = await window.material.listPresets();
    return [...BUILTIN_PRESETS, ...user];
  } catch (err) {
    reportError('List presets', err);
    return BUILTIN_PRESETS;
  }
}

export function applyPreset(preset: Preset): void {
  useProjectStore.getState().apply((p) => {
    const base = withTechniqueEnsured(p);
    return {
      ...base,
      techniques: base.techniques.map((t, i) =>
        i === 0
          ? { ...t, techniqueId: preset.techniqueId, params: { ...t.params, ...preset.params } }
          : t,
      ),
      material: preset.material,
      modulations: preset.modulations,
    };
  });
}

export async function saveCurrentAsPreset(name: string): Promise<Preset | null> {
  const { project } = useProjectStore.getState();
  const technique = project.techniques.find((t) => t.enabled);
  if (!technique) {
    useUiStore.getState().pushToast('info', 'Nothing to save as a preset');
    return null;
  }
  const preset: Preset = {
    id: uid('preset'),
    name,
    techniqueId: technique.techniqueId,
    params: technique.params,
    material: project.material,
    modulations: project.modulations,
    builtin: false,
  };
  try {
    await window.material.savePreset(preset);
    useUiStore.getState().pushToast('info', `Preset "${name}" saved`);
    return preset;
  } catch (err) {
    reportError('Save preset', err);
    return null;
  }
}

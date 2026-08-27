import * as THREE from 'three';
import { engine } from './RenderEngine';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore, reportError } from '@/state/uiStore';
import { getTechnique } from '@/techniques/registry';
import type { TechniqueRenderer } from '@/techniques/types';

function mediaUrl(path: string): string {
  return `material://media?p=${encodeURIComponent(path)}`;
}

let loadedSourcePath: string | null = null;
let loadGeneration = 0;
let activeTechniqueId: string | null = null;
let activeRenderer: TechniqueRenderer | null = null;

function syncFromProject(): void {
  const { project } = useProjectStore.getState();
  const { composition } = project;

  engine.setComposition(composition.width, composition.height, composition.background);

  // Source texture (images in Phase 1; video arrives in Phase 3).
  const source = project.sources.find(
    (s) => s.id === composition.sourceId && (s.kind === 'image' || s.kind === 'video'),
  );
  const sourcePath = source && source.kind === 'image' ? source.path : null;
  if (sourcePath !== loadedSourcePath) {
    loadedSourcePath = sourcePath;
    const generation = ++loadGeneration;
    if (!sourcePath) {
      engine.setSource(null);
    } else {
      new THREE.TextureLoader().load(
        mediaUrl(sourcePath),
        (texture) => {
          if (generation !== loadGeneration) {
            texture.dispose();
            return;
          }
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.minFilter = THREE.LinearMipmapLinearFilter;
          texture.generateMipmaps = true;
          engine.setSource(texture);
        },
        undefined,
        () => {
          if (generation === loadGeneration) {
            reportError('Load source', new Error(`Could not load ${sourcePath}`));
            engine.setSource(null);
          }
        },
      );
    }
  }

  // Technique renderer lifecycle.
  const instance = project.techniques.find((t) => t.enabled) ?? null;
  const techniqueId = instance?.techniqueId ?? null;
  if (techniqueId !== activeTechniqueId) {
    activeTechniqueId = techniqueId;
    if (techniqueId) {
      const definition = getTechnique(techniqueId);
      activeRenderer = definition ? definition.createRenderer() : null;
      engine.setTechniqueRenderer(activeRenderer);
      if (!definition) reportError('Technique', new Error(`Unknown technique: ${techniqueId}`));
    } else {
      activeRenderer = null;
      engine.setTechniqueRenderer(null);
    }
  }
  if (instance) engine.setTechniqueParams(instance.params);
  engine.setMaterialState(project.material);
}

function syncFromUi(): void {
  const ui = useUiStore.getState();
  engine.setShowOriginal(ui.showOriginal);
}

/** Connect stores to the render engine. Returns a cleanup function. */
export function startEngineBridge(): () => void {
  const unsubProject = useProjectStore.subscribe(syncFromProject);
  const unsubUi = useUiStore.subscribe(syncFromUi);
  syncFromProject();
  syncFromUi();
  return () => {
    unsubProject();
    unsubUi();
    loadedSourcePath = null;
    activeTechniqueId = null;
    activeRenderer = null;
  };
}

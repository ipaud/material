import * as THREE from 'three';
import { engine } from './RenderEngine';
import { useProjectStore } from '@/state/projectStore';
import { useUiStore, reportError } from '@/state/uiStore';
import { getTechnique } from '@/techniques/registry';
import { playback } from '@/playback/PlaybackController';
import type { TechniqueRenderer } from '@/techniques/types';

function mediaUrl(path: string): string {
  return `material://media?p=${encodeURIComponent(path)}`;
}

let loadedSourcePath: string | null = null;
let loadGeneration = 0;
let loadedMaterialAsset: string | null = null;
let materialGeneration = 0;
let activeTechniqueId: string | null = null;
let activeRenderer: TechniqueRenderer | null = null;

function syncFromProject(): void {
  const { project } = useProjectStore.getState();
  const { composition } = project;

  engine.setComposition(composition.width, composition.height, composition.background);

  // Source texture: still image or video.
  const source = project.sources.find(
    (s) => s.id === composition.sourceId && (s.kind === 'image' || s.kind === 'video'),
  );
  const sourceKey = source ? `${source.kind}:${source.path}` : null;
  if (sourceKey !== loadedSourcePath) {
    loadedSourcePath = sourceKey;
    const generation = ++loadGeneration;
    playback.detachVideo();
    if (!source) {
      engine.setSource(null);
    } else if (source.kind === 'image') {
      new THREE.TextureLoader().load(
        mediaUrl(source.path),
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
            reportError('Load source', new Error(`Could not load ${source.path}`));
            engine.setSource(null);
          }
        },
      );
    } else {
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.src = mediaUrl(source.path);
      video.addEventListener('loadedmetadata', () => {
        if (generation !== loadGeneration) return;
        const texture = new THREE.VideoTexture(video);
        texture.colorSpace = THREE.SRGBColorSpace;
        playback.attachVideo(video);
        engine.setSource(texture);
        playback.seek(0);
      });
      video.addEventListener('error', () => {
        if (generation === loadGeneration) {
          reportError(
            'Load video',
            new Error(`Could not decode ${source.path} (unsupported codec?)`),
          );
          engine.setSource(null);
        }
      });
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

  // Custom material texture (SVG or raster image).
  const materialAsset = project.material.materialId === 'custom' ? project.material.assetPath : null;
  if (materialAsset !== loadedMaterialAsset) {
    loadedMaterialAsset = materialAsset;
    const generation = ++materialGeneration;
    if (!materialAsset) {
      engine.setMaterialTexture(null);
    } else {
      import('@/materials/textureLoader')
        .then(({ loadMaterialTexture }) => loadMaterialTexture(materialAsset))
        .then((texture) => {
          if (generation === materialGeneration) engine.setMaterialTexture(texture);
          else texture.dispose();
        })
        .catch((err) => {
          if (generation === materialGeneration) {
            reportError('Load material', err);
            engine.setMaterialTexture(null);
          }
        });
    }
  }
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
    loadedMaterialAsset = null;
    activeTechniqueId = null;
    activeRenderer = null;
  };
}

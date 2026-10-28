import { engine } from '@/rendering/RenderEngine';
import { useProjectStore } from '@/state/projectStore';
import { reportError, useUiStore } from '@/state/uiStore';
import { projectWithLayerLooks } from '@/performance/layerLook';
import { lookToCore, projectWithLookCore } from '@/performance/lookCore';

/** Render the composition at full project resolution and save as PNG. */
export async function exportPngStill(pinId?: string): Promise<void> {
  const project = useProjectStore.getState().project;
  const pin = pinId ? project.pinnedLooks.find((look) => look.id === pinId) : null;
  if (pinId && !pin) return;
  const target = pin ? projectWithLookCore(projectWithLayerLooks(project, pin), lookToCore(pin), pin.id) : project;
  if (pin ? !target.layers.some((layer) => layer.sourceId) : !project.composition.sourceId) {
    useUiStore.getState().pushToast('info', 'Nothing to export — import a source first');
    return;
  }
  if (pin && target.layers.some((layer) => {
    if (!layer.sourceId) return false;
    const source = target.sources.find((item) => item.id === layer.sourceId);
    return !source || source.kind !== 'generator';
  })) {
    useUiStore.getState().pushToast('info', 'Pin still export needs existing generator sources');
    return;
  }
  try {
    let pixels: Uint8Array;
    try {
      if (pin) useProjectStore.getState().applySilent(() => target);
      const { width, height } = target.composition;
      pixels = engine.renderStill(width, height);
    } finally {
      if (pin) useProjectStore.getState().applySilent(() => project);
    }

    const canvas = document.createElement('canvas');
    canvas.width = target.composition.width;
    canvas.height = target.composition.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create 2D context for PNG encode');
    const imageData = new ImageData(new Uint8ClampedArray(pixels), canvas.width, canvas.height);
    ctx.putImageData(imageData, 0, 0);

    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const savedPath = await window.material.savePngDialog(base64, `${project.name || 'material'}-${pin?.label ?? 'still'}`);
    if (savedPath) {
      useUiStore.getState().pushToast('info', `Exported ${savedPath.split('/').pop()}`);
    }
  } catch (err) {
    reportError('Export PNG', err);
  }
}

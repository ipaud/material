import { engine } from '@/rendering/RenderEngine';
import { useProjectStore } from '@/state/projectStore';
import { reportError, useUiStore } from '@/state/uiStore';

/** Render the composition at full project resolution and save as PNG. */
export async function exportPngStill(): Promise<void> {
  const { project } = useProjectStore.getState();
  if (!project.composition.sourceId) {
    useUiStore.getState().pushToast('info', 'Nothing to export — import a source first');
    return;
  }
  try {
    const { width, height } = project.composition;
    const pixels = engine.renderStill(width, height);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create 2D context for PNG encode');
    const imageData = new ImageData(new Uint8ClampedArray(pixels), width, height);
    ctx.putImageData(imageData, 0, 0);

    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const savedPath = await window.material.savePngDialog(base64, project.name || 'material');
    if (savedPath) {
      useUiStore.getState().pushToast('info', `Exported ${savedPath.split('/').pop()}`);
    }
  } catch (err) {
    reportError('Export PNG', err);
  }
}

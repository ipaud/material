import * as THREE from 'three';

const RASTER_SIZE = 512;

function mediaUrl(path: string): string {
  return `material://media?p=${encodeURIComponent(path)}`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode image'));
    img.src = src;
  });
}

/** Contain-fit an image into a square transparent canvas → texture. */
function rasterizeToSquare(img: HTMLImageElement): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = RASTER_SIZE;
  canvas.height = RASTER_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create raster context');
  const w = img.naturalWidth || RASTER_SIZE;
  const h = img.naturalHeight || RASTER_SIZE;
  const fit = Math.min(RASTER_SIZE / w, RASTER_SIZE / h);
  const dw = w * fit;
  const dh = h * fit;
  ctx.drawImage(img, (RASTER_SIZE - dw) / 2, (RASTER_SIZE - dh) / 2, dw, dh);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * Load a custom material texture from an asset path.
 * SVG goes through main-process sanitization, then rasterizes via <img>
 * (browser SVG-as-image mode: no scripts, no external loads).
 */
export async function loadMaterialTexture(assetPath: string): Promise<THREE.Texture> {
  if (assetPath.toLowerCase().endsWith('.svg')) {
    const svgText = await window.material.readSvg(assetPath);
    const blob = new Blob([svgText], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImage(url);
      return rasterizeToSquare(img);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const img = await loadImage(mediaUrl(assetPath));
  return rasterizeToSquare(img);
}

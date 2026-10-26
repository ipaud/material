import * as THREE from 'three';
import type { MaterialState } from '@shared/schemas/project';
import { typographyTokens } from './typography';
import notoSansMonoUrl from './fonts/NotoSansMono-variable.ttf?url';

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

let fontReady: Promise<void> | null = null;
async function ensureTypographyFont(): Promise<void> {
  fontReady ??= (async () => {
    const font = new FontFace('Material Noto Sans Mono', `url("${notoSansMonoUrl}")`, { weight: '100 900' });
    await font.load();
    document.fonts.add(font);
  })();
  await fontReady;
}

export async function loadTypographyTexture(material: MaterialState): Promise<THREE.Texture> {
  await ensureTypographyFont();
  const canvas = document.createElement('canvas');
  canvas.width = RASTER_SIZE;
  canvas.height = RASTER_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create typography raster context');
  ctx.clearRect(0, 0, RASTER_SIZE, RASTER_SIZE);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const params = material.params;
  const mode = params.mode === 'word' || params.mode === 'phrase' ? params.mode : 'character';
  const tokens = typographyTokens(typeof params.text === 'string' ? params.text : '', mode);
  const weight = Math.max(100, Math.min(900, Number(params.weight) || 500));
  const size = Math.max(24, Math.min(512, Number(params.size) || 320));
  const tracking = Math.max(-20, Math.min(80, Number(params.tracking) || 0));
  const cols = Math.ceil(Math.sqrt(tokens.length));
  const rows = Math.ceil(tokens.length / cols);
  const cellW = RASTER_SIZE / cols;
  const cellH = RASTER_SIZE / rows;
  tokens.forEach((token, index) => {
    const x = (index % cols) * cellW;
    const y = Math.floor(index / cols) * cellH;
    const lines = mode === 'phrase' ? token.split('\n').slice(0, 8) : [token];
    let fontSize = Math.min(size, cellH * (mode === 'phrase' ? 0.82 / lines.length : 0.72));
    ctx.font = `${weight} ${fontSize}px "Material Noto Sans Mono"`;
    const widest = Math.max(...lines.map((line) => ctx.measureText(line).width + Math.max(0, line.length - 1) * tracking));
    if (widest > cellW * 0.88) fontSize *= (cellW * 0.88) / widest;
    ctx.font = `${weight} ${fontSize}px "Material Noto Sans Mono"`;
    const lineH = fontSize * 1.15;
    lines.forEach((line, lineIndex) => {
      const cy = y + cellH / 2 + (lineIndex - (lines.length - 1) / 2) * lineH;
      if ('letterSpacing' in ctx) ctx.letterSpacing = `${tracking}px`;
      ctx.fillText(line, x + cellW / 2, cy, cellW * 0.9);
    });
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

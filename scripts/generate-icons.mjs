import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * MATERIAL brand icons — 3×3 module grid, one module carrying the signal.
 *
 * Renders the mark directly to PNG (rounded-rect SDF + flat rects, 1px
 * antialias) so the build needs no SVG rasterizer, no native deps, no
 * network. Geometry mirrors assets/brand/material-logo.svg exactly.
 *
 * Outputs:
 *   build/icon.png            1024px, signal at centre — the app bundle icon
 *                             (electron-builder picks build/icon.png up
 *                             automatically and converts it to .icns)
 *   build/dock/pos-{0..8}.png  512px, one per signal position — the runtime
 *                             Dock icon variants (position = project seed)
 *
 * Run: npm run icons
 */

// Source geometry (from material-logo.svg, viewBox 952.09).
const SRC = 952.09;
const CORNER = 215.58;
const CELL = 145.85;
const COLS = [209.91, 403.12, 595.09];
const ROWS = [217.39, 403.12, 588.86];

const BG = [0x10, 0x10, 0x0f];
const MODULE = [0xfd, 0xfc, 0xfd];
const SIGNAL = [0xfd, 0xc3, 0x06];

/** Signed distance to a rounded rectangle centred at (cx, cy). */
function roundedRectSdf(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius);
  const qy = Math.abs(py - cy) - (halfH - radius);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** 0..1 pixel coverage from a signed distance, ~1px feather. */
const coverage = (d) => Math.min(Math.max(0.5 - d, 0), 1);

function renderMark(size, signalIndex) {
  const scale = size / SRC;
  const pixels = new Uint8Array(size * size * 4);

  const cells = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      cells.push({
        x: COLS[col] * scale,
        y: ROWS[row] * scale,
        w: CELL * scale,
        h: CELL * scale,
        color: row * 3 + col === signalIndex ? SIGNAL : MODULE,
      });
    }
  }

  const half = (SRC * scale) / 2;
  const corner = CORNER * scale;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      // Background: rounded square, transparent outside.
      const bgAlpha = coverage(roundedRectSdf(px, py, half, half, half, half, corner));
      let r = BG[0];
      let g = BG[1];
      let b = BG[2];
      let a = bgAlpha;

      for (const cell of cells) {
        const d = roundedRectSdf(
          px,
          py,
          cell.x + cell.w / 2,
          cell.y + cell.h / 2,
          cell.w / 2,
          cell.h / 2,
          0,
        );
        const cov = coverage(d);
        if (cov > 0) {
          r = r + (cell.color[0] - r) * cov;
          g = g + (cell.color[1] - g) * cov;
          b = b + (cell.color[2] - b) * cov;
          a = Math.max(a, cov);
        }
      }

      const i = (y * size + x) * 4;
      pixels[i] = Math.round(r);
      pixels[i + 1] = Math.round(g);
      pixels[i + 2] = Math.round(b);
      pixels[i + 3] = Math.round(a * 255);
    }
  }
  return pixels;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // Raw scanlines, filter type 0 per row.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dockDir = join(root, 'build', 'dock');
mkdirSync(dockDir, { recursive: true });

// Bundle icon: signal at the centre (the canonical mark).
writeFileSync(join(root, 'build', 'icon.png'), encodePng(renderMark(1024, 4), 1024));
console.log('build/icon.png (1024, centre)');

// Dock variants: one per signal position.
for (let position = 0; position < 9; position++) {
  const file = join(dockDir, `pos-${position}.png`);
  writeFileSync(file, encodePng(renderMark(512, position), 512));
}
console.log('build/dock/pos-{0..8}.png (512)');

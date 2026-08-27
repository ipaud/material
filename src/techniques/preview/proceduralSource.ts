import * as THREE from 'three';
import type { TemporalSource } from '@/rendering/temporal/TemporalFrameProvider';

const W = 320;
const H = 180;

/**
 * Owned procedural preview footage — a moving figure over a graded field.
 * Time is legible two ways (position and hue), so temporal techniques show
 * their behavior in a still thumbnail. Nothing here is third-party artwork.
 */
export function drawProceduralFrame(ctx: CanvasRenderingContext2D, timeSec: number): void {
  const t = timeSec;
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#101014');
  bg.addColorStop(1, '#2a2a34');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Drifting hue band — makes the sampled moment readable as color.
  const hue = (t * 60) % 360;
  ctx.fillStyle = `hsl(${hue} 70% 55%)`;
  ctx.fillRect(0, H * 0.72, W, H * 0.06);

  // Figure: a bright head-and-shoulders shape tracking a slow horizontal path.
  const cx = W * (0.5 + 0.28 * Math.sin(t * 1.1));
  const cy = H * 0.52;
  const glow = ctx.createRadialGradient(cx, cy, 4, cx, cy, H * 0.48);
  glow.addColorStop(0, '#ffffff');
  glow.addColorStop(0.45, `hsl(${(hue + 180) % 360} 60% 62%)`);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#0b0b0e';
  ctx.beginPath();
  ctx.ellipse(cx, cy - H * 0.04, H * 0.13, H * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();

  // Vertical rhythm so grid techniques have structure to bite into.
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  for (let i = 0; i < 9; i++) {
    ctx.fillRect((i / 9) * W + ((t * 18) % (W / 9)), 0, 2, H);
  }
}

/** Time-addressable procedural source; drives previews through the real path. */
export class ProceduralTemporalSource implements TemporalSource {
  readonly isStatic = false;
  readonly startSec = 0;
  readonly endSec = 30;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Preview canvas unavailable');
    this.ctx = ctx;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.drawAt(0);
  }

  drawAt(timeSec: number): void {
    drawProceduralFrame(this.ctx, timeSec);
    this.texture.needsUpdate = true;
  }

  currentTexture(): THREE.Texture {
    return this.texture;
  }

  async acquireAt(timeSec: number): Promise<THREE.Texture> {
    this.drawAt(timeSec);
    return this.texture;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

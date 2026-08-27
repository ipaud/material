#!/usr/bin/env node
/**
 * Generate owned sample assets into assets/samples/ using ffmpeg's lavfi
 * sources — gradient, checker, and a portrait-like test pattern.
 * Usage: node scripts/generate-samples.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, accessSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'assets', 'samples');
mkdirSync(outDir, { recursive: true });

function findFfmpeg() {
  const candidates = [
    join(os.homedir(), '.local', 'bin', 'ffmpeg'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ];
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      /* keep looking */
    }
  }
  throw new Error('ffmpeg not found');
}

const ffmpeg = findFfmpeg();

function generate(name, filter) {
  const out = join(outDir, name);
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', filter, '-frames:v', '1', out], {
    stdio: 'pipe',
  });
  console.log(`✓ ${name}`);
}

generate('gradient.png', 'gradients=size=1920x1080:c0=black:c1=white:x0=0:y0=0:x1=1920:y1=1080');
generate('checker.png', 'color=c=black:size=1920x1080,geq=lum=255*mod(floor(X/120)+floor(Y/120)\\,2):cb=128:cr=128');
// Portrait-like pattern: soft radial highlight off-center on a dark field.
generate(
  'portrait-pattern.png',
  'color=c=black:size=1080x1350,geq=lum=255*exp(-((X-540)*(X-540)+(Y-500)*(Y-500))/180000)+40*exp(-((X-540)*(X-540)+(Y-1000)*(Y-1000))/400000):cb=128:cr=128',
);
console.log(`Samples written to ${outDir}`);

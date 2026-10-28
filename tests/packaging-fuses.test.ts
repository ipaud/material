import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('packaged app cannot become a Node runtime', () => {
  it('keeps RunAsNode, NODE_OPTIONS and --inspect fuses off', () => {
    // 0.9.1 ran `ELECTRON_RUN_AS_NODE=1 MATERIAL -e …` as plain Node under the
    // app's identity. Checked on the packaged app with @electron/fuses read.
    const config = readFileSync('electron-builder.yml', 'utf8');
    const fuses = /\nelectronFuses:\n((?:\s{2}.+\n)+)/.exec(config)?.[1] ?? '';
    expect(fuses).toMatch(/runAsNode:\s*false/);
    expect(fuses).toMatch(/enableNodeOptionsEnvironmentVariable:\s*false/);
    expect(fuses).toMatch(/enableNodeCliInspectArguments:\s*false/);
  });
});

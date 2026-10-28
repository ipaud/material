// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ASSET_PREFIX, INSTALL_SCRIPT, isNewer, parseVersion, pickRelease } from '../shared/update';

const HASH = 'a'.repeat(64);
const release = (over: Record<string, unknown> = {}, asset: Record<string, unknown> = {}) => ({
  tag_name: 'v0.8.5',
  name: 'MATERIAL 0.8.5',
  draft: false,
  prerelease: false,
  html_url: 'https://github.com/ipaud/material/releases/tag/v0.8.5',
  body: '## Notes\nFaster export.\nSHA-256: `' + HASH + '`',
  assets: [
    {
      name: 'MATERIAL-0.8.5-arm64.zip',
      size: 1234,
      browser_download_url: `${ASSET_PREFIX}v0.8.5/MATERIAL-0.8.5-arm64.zip`,
      ...asset,
    },
  ],
  ...over,
});

describe('versions', () => {
  it('parses plain and v-prefixed, refuses anything else', () => {
    expect(parseVersion('v0.8.5')).toEqual([0, 8, 5]);
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('0.8.5-beta.1')).toBeNull();
    expect(parseVersion('latest')).toBeNull();
  });
  it('orders numerically, not as text', () => {
    expect(isNewer('0.8.10', '0.8.9')).toBe(true);
    expect(isNewer('0.9.0', '0.8.99')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.8.4', '0.8.4')).toBe(false);
    expect(isNewer('0.8.3', '0.8.4')).toBe(false);
    expect(isNewer('garbage', '0.8.4')).toBe(false);
  });
});

describe('pickRelease', () => {
  const opts = { arch: 'arm64' };
  it('takes the asset for this arch and a SHA-256 from the release text', () => {
    const r = pickRelease(release(), opts);
    expect(r).toMatchObject({ version: '0.8.5', assetName: 'MATERIAL-0.8.5-arm64.zip', size: 1234, sha256: HASH });
    expect(r?.notes).toBe('Faster export.');
  });
  it('shows release notes without Markdown syntax and cuts them at a word', () => {
    // The 0.9.1 dialog showed `**Fixes for 0.9.0.**` and ended mid-word.
    const body = [
      'MATERIAL 0.9.1. **Fixes for 0.9.0.** See [notes](https://example.com).',
      '- **Two typography layers** used `the selected` texture.',
      'typography '.repeat(60),
      `SHA-256: \`${HASH}\``,
    ].join('\n');
    const notes = pickRelease(release({ body }), opts)!.notes;
    expect(notes).toContain('MATERIAL 0.9.1. Fixes for 0.9.0. See notes.');
    expect(notes).toContain('• Two typography layers used the selected texture.');
    expect(notes).not.toMatch(/\*\*|`|\]\(/);
    expect(notes.length).toBeLessThanOrEqual(401);
    // Cut between words: the last word before the ellipsis is whole.
    expect(notes).toMatch(/ typography…$/);
  });
  it('prefers the asset digest GitHub computes', () => {
    const digest = 'b'.repeat(64);
    expect(pickRelease(release({}, { digest: `sha256:${digest}` }), opts)?.sha256).toBe(digest);
  });
  it('refuses drafts, pre-releases and tags that are not versions', () => {
    expect(pickRelease(release({ draft: true }), opts)).toBeNull();
    expect(pickRelease(release({ prerelease: true }), opts)).toBeNull();
    expect(pickRelease(release({ tag_name: 'nightly' }), opts)).toBeNull();
  });
  it('refuses an asset hosted anywhere but this repo', () => {
    const evil = release({}, { browser_download_url: 'https://evil.example/MATERIAL-0.8.5-arm64.zip' });
    expect(pickRelease(evil, opts)).toBeNull();
    const lookalike = release({}, { browser_download_url: 'https://github.com/someone/else/releases/download/v1/x.zip' });
    expect(pickRelease(lookalike, opts)).toBeNull();
  });
  it('refuses a release with no checksum, no matching asset, or a bad size', () => {
    expect(pickRelease(release({ body: 'no hash here' }), opts)).toBeNull();
    expect(pickRelease(release(), { arch: 'x64' })).toBeNull();
    expect(pickRelease(release({}, { size: 0 }), opts)).toBeNull();
    expect(pickRelease(null, opts)).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('INSTALL_SCRIPT (really run, on temp folders)', () => {
  const setup = (name: string) => {
    const root = mkdtempSync(join(tmpdir(), 'material-update-'));
    const target = join(root, name);
    const next = join(root, "new it's 'dir'", 'MATERIAL.app');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'v'), 'old');
    mkdirSync(next, { recursive: true });
    writeFileSync(join(next, 'v'), 'new');
    return { root, target, next };
  };
  // a pid that is not running, so the script does not wait
  const run = (target: string, next: string) =>
    spawnSync('/bin/sh', ['-c', INSTALL_SCRIPT], {
      env: { PATH: '/usr/bin:/bin', PID: '2147483646', MAX_TICKS: '5', NEW_APP: next, TARGET_APP: target, RELAUNCH: '0' },
    });

  it('swaps the bundle, whatever the path looks like, and leaves no old copy', () => {
    const { target, next } = setup('My MATERIAL "app" $HOME.app');
    expect(run(target, next).status).toBe(0);
    expect(readFileSync(join(target, 'v'), 'utf8')).toBe('new');
    expect(existsSync(`${target}.updating-old`)).toBe(false);
  });
  it('puts the old app back if the new one is missing', () => {
    const { target, root } = setup('MATERIAL.app');
    expect(run(target, join(root, 'does-not-exist')).status).not.toBe(0);
    expect(readFileSync(join(target, 'v'), 'utf8')).toBe('old');
  });
  it('gives up waiting if the app never quits', () => {
    const { target, next } = setup('MATERIAL.app');
    const res = spawnSync('/bin/sh', ['-c', INSTALL_SCRIPT], {
      env: { PATH: '/usr/bin:/bin', PID: String(process.pid), MAX_TICKS: '3', NEW_APP: next, TARGET_APP: target, RELAUNCH: '0' },
    });
    expect(res.status).toBe(1);
    expect(readFileSync(join(target, 'v'), 'utf8')).toBe('old');
  });
});

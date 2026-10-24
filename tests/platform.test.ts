// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { binaryName, searchDirs } from '../electron/media/ffmpegPaths';
import { pickNotice } from '../shared/update';
import { basename, hasCommand } from '../src/utils/platform';

describe('ffmpeg search path', () => {
  it('uses .exe on Windows only', () => {
    expect(binaryName('ffmpeg', 'win32')).toBe('ffmpeg.exe');
    expect(binaryName('ffmpeg', 'darwin')).toBe('ffmpeg');
  });
  it('puts the process PATH first, then the usual macOS places, without repeats', () => {
    const dirs = searchDirs({ platform: 'darwin', pathVar: '/usr/bin:/custom/bin:/opt/homebrew/bin', home: '/Users/a' });
    expect(dirs.slice(0, 3)).toEqual(['/usr/bin', '/custom/bin', '/opt/homebrew/bin']);
    expect(dirs).toContain('/Users/a/.local/bin');
    expect(new Set(dirs).size).toBe(dirs.length);
  });
  it('knows where winget, Chocolatey and Scoop put ffmpeg on Windows', () => {
    const dirs = searchDirs({
      platform: 'win32',
      pathVar: 'C:\\Windows\\System32;C:\\tools',
      home: 'C:\\Users\\a',
      localAppData: 'C:\\Users\\a\\AppData\\Local',
      programData: 'C:\\ProgramData',
      programFiles: 'C:\\Program Files',
    });
    expect(dirs.slice(0, 2)).toEqual(['C:\\Windows\\System32', 'C:\\tools']);
    expect(dirs).toContain('C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Links');
    expect(dirs).toContain('C:\\ProgramData\\chocolatey\\bin');
    expect(dirs).toContain('C:\\Users\\a\\scoop\\shims');
    expect(dirs).toContain('C:\\Program Files\\ffmpeg\\bin');
  });
  it('copes with an empty or missing PATH', () => {
    expect(searchDirs({ platform: 'win32', pathVar: undefined, home: 'C:\\Users\\a' })).toContain('C:\\ffmpeg\\bin');
    expect(searchDirs({ platform: 'linux', pathVar: '', home: '/home/a' })).toContain('/usr/bin');
  });
});

describe('platform helpers', () => {
  it('basename handles both separators', () => {
    expect(basename('/Users/a/media/clip.mp4')).toBe('clip.mp4');
    expect(basename('C:\\Users\\a\\media\\clip.mp4')).toBe('clip.mp4');
    expect(basename('clip.mp4')).toBe('clip.mp4');
    expect(basename('/folder/')).toBe('');
  });
  it('accepts meta (and, off macOS, ctrl) as the command key', () => {
    expect(hasCommand({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(hasCommand({ metaKey: false, ctrlKey: false })).toBe(false);
  });
});

describe('pickNotice (platforms that cannot self-install)', () => {
  const rel = { tag_name: 'v0.9.0', name: 'MATERIAL 0.9.0', html_url: 'https://github.com/ipaud/material/releases/tag/v0.9.0', body: '## New\nA thing.\nSHA-256: x' };
  it('gives the version, the page and the first lines of the notes', () => {
    expect(pickNotice(rel)).toEqual({ version: '0.9.0', name: 'MATERIAL 0.9.0', pageUrl: rel.html_url, notes: 'A thing.' });
  });
  it('ignores drafts, pre-releases, odd tags and junk', () => {
    expect(pickNotice({ ...rel, draft: true })).toBeNull();
    expect(pickNotice({ ...rel, prerelease: true })).toBeNull();
    expect(pickNotice({ ...rel, tag_name: 'nightly' })).toBeNull();
    expect(pickNotice(null)).toBeNull();
  });
});

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { defaultFps, loadExportSettings, saveExportSettings } from '../src/export/exportSettings';

const OPTIONS = [24, 25, 30, 50, 60];

// jsdom under this vitest config exposes no localStorage; a Map-backed stub is enough.
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
});

describe('export settings', () => {
  test('round-trips per project and does not leak between projects', () => {
    const a = { format: 'prores422', resolution: '1080', fps: 25, includeAudio: false, alpha: false } as const;
    saveExportSettings('/p/a.material', a);
    expect(loadExportSettings('/p/a.material')).toEqual(a);
    expect(loadExportSettings('/p/b.material')).toBeNull();
  });

  test('corrupt or foreign stored data falls back to null', () => {
    localStorage.setItem('material.export./p/x', '{not json');
    expect(loadExportSettings('/p/x')).toBeNull();
    localStorage.setItem('material.export./p/y', JSON.stringify({ format: 'gif' }));
    expect(loadExportSettings('/p/y')).toBeNull();
  });
});

describe('defaultFps', () => {
  test('uses the source rate, never a fixed 30', () => {
    expect(defaultFps(25, OPTIONS)).toBe(25);
    expect(defaultFps(24, OPTIONS)).toBe(24);
  });
  test('keeps non-standard rates instead of rounding them away', () => {
    expect(defaultFps(23.976023976, OPTIONS)).toBe(23.976);
  });
  test('unknown source rate falls back to 30', () => {
    expect(defaultFps(null, OPTIONS)).toBe(30);
    expect(defaultFps(Number.NaN, OPTIONS)).toBe(30);
  });
});

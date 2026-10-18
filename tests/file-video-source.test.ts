import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FileVideoSource } from '@/sources/FileVideoSource';
import { clearProxies, setProxy, UnsupportedMediaError } from '@/sources/mediaProxy';

const probe = vi.fn();

beforeEach(() => {
  clearProxies();
  probe.mockReset();
  (window as unknown as { material: unknown }).material = { probeMedia: probe };
});
afterEach(() => vi.restoreAllMocks());

function sizeOf(source: FileVideoSource, w: number, h: number): void {
  Object.defineProperty(source.video, 'videoWidth', { value: w, configurable: true });
  Object.defineProperty(source.video, 'videoHeight', { value: h, configurable: true });
}

describe('FileVideoSource load failures', () => {
  test('decode error on a file that exists is an UnsupportedMediaError with the codec', async () => {
    probe.mockResolvedValue({ videoCodec: 'prores' });
    const source = new FileVideoSource('/m/clip.mov');
    const loading = source.load();
    source.video.dispatchEvent(new Event('error'));
    const err = await loading.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedMediaError);
    expect((err as UnsupportedMediaError).codec).toBe('prores');
    expect(source.status).toBe('error');
  });

  test('metadata with no picture (ProRes audio-only decode) is a failure, not a live source', async () => {
    probe.mockResolvedValue({ videoCodec: 'prores' });
    const source = new FileVideoSource('/m/clip.mov');
    const loading = source.load();
    sizeOf(source, 0, 0);
    source.video.dispatchEvent(new Event('loadedmetadata'));
    await expect(loading).rejects.toBeInstanceOf(UnsupportedMediaError);
    expect(source.status).toBe('error');
    expect(source.texture()).toBeNull();
  });

  test('missing file stays an offline error', async () => {
    probe.mockRejectedValue(new Error('ENOENT'));
    const source = new FileVideoSource('/m/gone.mov');
    const loading = source.load();
    source.video.dispatchEvent(new Event('error'));
    await expect(loading).rejects.toThrow(/missing/);
    expect(source.status).toBe('offline');
  });

  test('loads the proxy when one is registered', () => {
    setProxy('/m/clip.mov', '/cache/clip.h264.mp4');
    const source = new FileVideoSource('/m/clip.mov');
    void source.load();
    expect(source.video.src).toContain(encodeURIComponent('/cache/clip.h264.mp4'));
  });
});

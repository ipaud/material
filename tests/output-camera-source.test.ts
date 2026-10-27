import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { OutputCameraSource } from '@/output-window/outputCameraSource';

describe('OutputCameraSource', () => {
  let mediaDevicesDescriptor: PropertyDescriptor | undefined;
  let getUserMedia: ReturnType<typeof vi.fn>;
  let track: { stop: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    getUserMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    track = { stop: vi.fn() };
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event('playing'));
      return Promise.resolve();
    });
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (mediaDevicesDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDevicesDescriptor);
    else Reflect.deleteProperty(navigator, 'mediaDevices');
    vi.restoreAllMocks();
  });

  function stream(): MediaStream {
    return { getTracks: () => [track] } as unknown as MediaStream;
  }

  it('retries without device constraint only after OverconstrainedError', async () => {
    getUserMedia
      .mockRejectedValueOnce(new DOMException('device missing', 'OverconstrainedError'))
      .mockResolvedValueOnce(stream());
    const source = new OutputCameraSource('camera-1');

    await source.load();

    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      video: { deviceId: { exact: 'camera-1' } }, audio: false,
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { video: true, audio: false });
    expect(source.texture()).toBeInstanceOf(THREE.VideoTexture);
    expect(source.texture()?.colorSpace).toBe(THREE.SRGBColorSpace);

    const disposeTexture = vi.spyOn(source.texture()!, 'dispose');
    source.dispose();
    source.dispose();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(disposeTexture).toHaveBeenCalledOnce();
    expect(source.texture()).toBeNull();
  });

  it('does not retry when user or system denies capture', async () => {
    const denied = new DOMException('permission denied', 'NotAllowedError');
    getUserMedia.mockRejectedValue(denied);
    const source = new OutputCameraSource('camera-1');

    await expect(source.load()).rejects.toBe(denied);

    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(source.texture()).toBeNull();
  });

  it('stops late stream when source was disposed during acquisition', async () => {
    let resolveStream!: (value: MediaStream) => void;
    getUserMedia.mockImplementation(() => new Promise<MediaStream>((resolve) => { resolveStream = resolve; }));
    const source = new OutputCameraSource(null);
    const loading = source.load();
    source.dispose();
    resolveStream(stream());

    await loading;

    expect(getUserMedia).toHaveBeenCalledWith({ video: true, audio: false });
    expect(track.stop).toHaveBeenCalledOnce();
    expect(source.texture()).toBeNull();
  });
});

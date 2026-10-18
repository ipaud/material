/**
 * Chromium cannot decode some editing codecs (ProRes, DNxHD…). For those the
 * app plays an H.264 proxy instead; this registry says which one, per original.
 */
const proxies = new Map<string, string>();

export function setProxy(original: string, proxy: string): void {
  proxies.set(original, proxy);
}

export function clearProxies(): void {
  proxies.clear();
}

/** The file the <video> element should load for this source path. */
export function playablePath(original: string): string {
  return proxies.get(original) ?? original;
}

/** The file is fine on disk but this browser engine cannot play it. */
export class UnsupportedMediaError extends Error {
  constructor(
    readonly path: string,
    readonly codec: string | null,
  ) {
    const name = path.split('/').pop() ?? path;
    super(
      `Cannot play ${name}${codec ? ` (${codec})` : ''} in the viewer — make an H.264 proxy to use it`,
    );
    this.name = 'UnsupportedMediaError';
  }
}

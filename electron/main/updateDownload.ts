import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Download a file to `dest` and keep it only if it is exactly what the release said it would be: the same number of
 * bytes and the same SHA-256. A short, long or altered download is deleted and throws. No Electron in here, so the
 * tests can run it against a local server.
 */
export async function downloadVerified(
  url: string,
  dest: string,
  size: number,
  sha256: string,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const part = `${dest}.part`;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const res = await fetch(url, {
    ...(signal ? { signal } : {}),
    redirect: 'follow',
    headers: { 'User-Agent': 'MATERIAL-updater' },
  });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const hash = createHash('sha256');
  const file = await fs.open(part, 'w');
  let got = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
      if (got > size) throw new Error('download is larger than the release says');
      hash.update(value);
      await file.write(value);
      onProgress(got / size);
    }
  } catch (error) {
    await file.close().catch(() => undefined);
    await fs.rm(part, { force: true });
    throw error;
  }
  await file.close();
  if (got !== size) {
    await fs.rm(part, { force: true });
    throw new Error(`download is ${got} bytes, the release says ${size}`);
  }
  if (hash.digest('hex') !== sha256) {
    await fs.rm(part, { force: true });
    throw new Error('download does not match the SHA-256 the release publishes');
  }
  await fs.rename(part, dest);
}

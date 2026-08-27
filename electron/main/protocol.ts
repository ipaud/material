import { protocol } from 'electron';
import { createReadStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { isApprovedMediaPath } from '../filesystem/mediaRegistry';

export const MEDIA_SCHEME = 'material';

/** Must run before app ready. */
export function registerMediaSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        stream: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
};

function contentType(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** Parse a single-range `bytes=start-end` header. */
function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  let start: number;
  let end: number;
  if (rawStart === '') {
    // Suffix range: last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

function toWebStream(nodeStream: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
}

/**
 * material://media?p=<encoded absolute path>
 *
 * Serves only paths explicitly approved through import/probe. Byte ranges are
 * handled here rather than delegated: `<video>` will not report a seekable
 * range (and therefore cannot seek at all) unless the response advertises
 * Accept-Ranges and answers Range requests with 206 + Content-Range.
 */
export function registerMediaProtocolHandler(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const filePath = url.searchParams.get('p');
      if (!filePath || !isApprovedMediaPath(filePath)) {
        return new Response('Not found', { status: 404 });
      }

      const stats = await fs.stat(filePath);
      const size = stats.size;
      const type = contentType(filePath);
      // The renderer runs on a different origin, so media needs CORS headers
      // to be usable as a WebGL texture.
      const headers: Record<string, string> = {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      };

      const range = parseRange(request.headers.get('Range'), size);
      if (range) {
        const length = range.end - range.start + 1;
        return new Response(toWebStream(createReadStream(filePath, range)), {
          status: 206,
          headers: {
            ...headers,
            'Content-Length': String(length),
            'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
          },
        });
      }

      return new Response(toWebStream(createReadStream(filePath)), {
        status: 200,
        headers: { ...headers, 'Content-Length': String(size) },
      });
    } catch (err) {
      return new Response(`Media error: ${err instanceof Error ? err.message : 'unknown'}`, {
        status: 500,
      });
    }
  });
}

export function mediaUrlForPath(filePath: string): string {
  return `${MEDIA_SCHEME}://media?p=${encodeURIComponent(filePath)}`;
}

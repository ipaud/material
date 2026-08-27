import { protocol, net } from 'electron';
import { pathToFileURL } from 'node:url';
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
      },
    },
  ]);
}

/**
 * material://media?p=<encoded absolute path>
 * Serves only paths explicitly approved through import/probe. Range requests
 * are handled by net.fetch's file protocol support (needed for <video>).
 */
export function registerMediaProtocolHandler(): void {
  protocol.handle(MEDIA_SCHEME, (request) => {
    try {
      const url = new URL(request.url);
      const filePath = url.searchParams.get('p');
      if (!filePath || !isApprovedMediaPath(filePath)) {
        return new Response('Not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(filePath).toString(), {
        headers: request.headers,
        bypassCustomProtocolHandlers: true,
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

// @vitest-environment node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { downloadVerified } from '../electron/main/updateDownload';

const body = Buffer.from('MATERIAL '.repeat(5000));
const sha = createHash('sha256').update(body).digest('hex');
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/zip' }).end();
    } else if (req.url === '/missing') {
      res.writeHead(404).end();
    } else {
      res.writeHead(200, { 'Content-Length': body.length }).end(req.url === '/tampered' ? Buffer.from(body).fill(0x41, 0, 4) : body);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const dest = () => join(mkdtempSync(join(tmpdir(), 'material-dl-')), 'out.zip');

describe('downloadVerified', () => {
  it('keeps a download that matches size and SHA-256, following redirects, and reports progress', async () => {
    const d = dest();
    const seen: number[] = [];
    await downloadVerified(`${base}/redirect`, d, body.length, sha, (f) => seen.push(f));
    expect(readFileSync(d).equals(body)).toBe(true);
    expect(seen.at(-1)).toBe(1);
    expect(existsSync(`${d}.part`)).toBe(false);
  });
  it('deletes a download whose bytes were altered', async () => {
    const d = dest();
    await expect(downloadVerified(`${base}/tampered`, d, body.length, sha, () => undefined)).rejects.toThrow(/SHA-256/);
    expect(existsSync(d)).toBe(false);
    expect(existsSync(`${d}.part`)).toBe(false);
  });
  it('refuses a file larger or smaller than the release says', async () => {
    const d = dest();
    await expect(downloadVerified(`${base}/zip`, d, body.length - 1, sha, () => undefined)).rejects.toThrow(/larger/);
    await expect(downloadVerified(`${base}/zip`, d, body.length + 1, sha, () => undefined)).rejects.toThrow(/bytes/);
    expect(existsSync(d) || existsSync(`${d}.part`)).toBe(false);
  });
  it('throws on an HTTP error', async () => {
    await expect(downloadVerified(`${base}/missing`, dest(), 1, sha, () => undefined)).rejects.toThrow(/404/);
  });
});

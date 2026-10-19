/**
 * Regression tests for the asset mirroring pipeline (remediation record #15):
 *
 * Discovered image assets are mirrored regardless of origin — content imagery
 * is frequently CDN-hosted, and a clone cannot reproduce what it never
 * downloads — while every request (including redirect targets) still passes
 * the SSRF/network policy and the image MIME/size budgets.
 *
 * Fixtures are generic (example.com / cdn.example.com) — nothing target-
 * specific.
 *
 * spec: automate-testing-self-fixing.md remediation record #15 (Experiment 6).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mirrorAssets } from '../dist/crawler/assets.js';
import type { NetworkPolicyOptions } from '../dist/crawler/network-policy.js';

const PUBLIC_RESOLVE: NetworkPolicyOptions['resolve'] = async () => [
  { address: '93.184.216.34', family: 4 },
];

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x01,
]);

function response(
  body: Buffer,
  contentType: string,
  extra: { status?: number; statusText?: string; location?: string | null; contentLength?: string | null } = {},
) {
  const headers = new Map<string, string>();
  headers.set('content-type', contentType);
  if (extra.contentLength !== undefined && extra.contentLength !== null) {
    headers.set('content-length', extra.contentLength);
  }
  if (extra.location !== undefined && extra.location !== null) {
    headers.set('location', extra.location);
  }
  return {
    ok: (extra.status ?? 200) >= 200 && (extra.status ?? 200) < 300,
    status: extra.status ?? 200,
    statusText: extra.statusText ?? 'OK',
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

async function withAssetsDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'apograph-assets-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('asset-mirror > mirrors cross-origin CDN images as well as same-origin ones', async () => {
  await withAssetsDir(async (dir) => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return response(PNG_BYTES, 'image/png');
    }) as unknown as typeof fetch;

    const { entries, uncaptured } = await mirrorAssets(
      [
        'https://www.example.com/images/hero.jpg',
        'https://cdn.example.com/uploads/media/photo.png',
      ],
      'https://www.example.com',
      dir,
      { fetchImpl, resolve: PUBLIC_RESOLVE },
    );

    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((e) => e.status), ['downloaded', 'downloaded']);
    for (const entry of entries) {
      assert.ok(entry.localPath !== null);
      const bytes = await readFile(entry.localPath as string);
      assert.ok(bytes.length > 0);
    }
    assert.equal(calls.length, 2);
    assert.equal(uncaptured.length, 0);
  });
});

test('asset-mirror > policy-blocked and non-image URLs fail without weakening SSRF', async () => {
  await withAssetsDir(async (dir) => {
    const fetchImpl = (async () => response(Buffer.from('not an image'), 'text/html')) as unknown as typeof fetch;
    const selective: NetworkPolicyOptions['resolve'] = async (host) =>
      host.includes('localhost')
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }];

    const { entries, uncaptured } = await mirrorAssets(
      [
        'http://localhost.internal/secret.png',
        'https://www.example.com/page.html',
      ],
      'https://www.example.com',
      dir,
      { fetchImpl, resolve: selective },
    );

    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((e) => e.status), ['failed', 'failed']);
    assert.ok(uncaptured[0]?.reason.includes('blocked by network policy'));
    assert.ok(uncaptured[1]?.reason.includes('same-origin'));
    assert.ok(uncaptured[1]?.reason.includes('unexpected content type'));
  });
});

test('asset-mirror > follows policy-valid cross-origin redirects (CDN to storage)', async () => {
  await withAssetsDir(async (dir) => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init?: { redirect?: string }) => {
      seen.push(`${init?.redirect ?? ''} ${url}`);
      if (url.startsWith('https://cdn.example.com/')) {
        return response(Buffer.alloc(0), 'text/plain', {
          status: 302,
          statusText: 'Found',
          location: 'https://storage.example.org/objects/pic.png',
        });
      }
      return response(PNG_BYTES, 'image/png');
    }) as unknown as typeof fetch;

    const { entries } = await mirrorAssets(
      ['https://cdn.example.com/redirected.png'],
      'https://www.example.com',
      dir,
      { fetchImpl, resolve: PUBLIC_RESOLVE },
    );

    assert.equal(entries[0]?.status, 'downloaded');
    assert.ok(seen.some((s) => s.includes('storage.example.org')));
  });
});

test('asset-mirror > enforces per-asset byte limits', async () => {
  await withAssetsDir(async (dir) => {
    const fetchImpl = (async () =>
      response(PNG_BYTES, 'image/png', { contentLength: '104857600' })) as unknown as typeof fetch;

    const { entries } = await mirrorAssets(
      ['https://www.example.com/huge.png'],
      'https://www.example.com',
      dir,
      { fetchImpl, resolve: PUBLIC_RESOLVE, maxBytes: 1024 },
    );

    assert.equal(entries[0]?.status, 'failed');
  });
});

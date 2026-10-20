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

import { mirrorAssets, isTransientAssetError } from '../dist/crawler/assets.js';
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

// ---------------------------------------------------------------------------
// Transient-failure resilience (bounded retry with backoff)
// ---------------------------------------------------------------------------

/** Builds a network-dropout fetch rejection with a node-style cause code. */
function networkDropout(code = 'ECONNRESET'): TypeError {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNRESET'), { code }),
  });
}

test('asset-mirror > isTransientAssetError separates transients from deterministic failures', () => {
  assert.equal(isTransientAssetError(networkDropout()), true);
  assert.equal(isTransientAssetError(new Error('socket hang up')), true);
  assert.equal(isTransientAssetError(Object.assign(new Error('HTTP 503'), { status: 503 })), true);
  assert.equal(isTransientAssetError(Object.assign(new Error('HTTP 429'), { status: 429 })), true);
  assert.equal(isTransientAssetError(new DOMException('The operation timed out.', 'TimeoutError')), true);
  assert.equal(isTransientAssetError(Object.assign(new Error('HTTP 404'), { status: 404 })), false);
  assert.equal(isTransientAssetError(new Error('unexpected content type: text/html')), false);
  assert.equal(isTransientAssetError('not an error'), false);
});

test('asset-mirror > retries transient network dropouts with bounded backoff and succeeds', async () => {
  await withAssetsDir(async (dir) => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls <= 2) throw networkDropout();
      return response(PNG_BYTES, 'image/png');
    }) as unknown as typeof fetch;
    const sleeps: number[] = [];

    const { entries, uncaptured } = await mirrorAssets(
      ['https://www.example.com/flaky.png'],
      'https://www.example.com',
      dir,
      {
        fetchImpl,
        resolve: PUBLIC_RESOLVE,
        sleepImpl: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    assert.equal(entries[0]?.status, 'downloaded');
    assert.equal(uncaptured.length, 0);
    assert.equal(calls, 3, 'two transient failures then success');
    assert.equal(sleeps.length, 2, 'one backoff wait per failed attempt');
    assert.ok(sleeps[0] >= 1000 && sleeps[0] < 1500, `first backoff ${sleeps[0]}ms`);
    assert.ok(sleeps[1] >= 3000 && sleeps[1] < 4000, `second backoff ${sleeps[1]}ms`);
  });
});

test('asset-mirror > retries transient HTTP faults (503) and recovers', async () => {
  await withAssetsDir(async (dir) => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return response(PNG_BYTES, 'image/png', { status: 503, statusText: 'Service Unavailable' });
      return response(PNG_BYTES, 'image/png');
    }) as unknown as typeof fetch;
    const sleeps: number[] = [];

    const { entries } = await mirrorAssets(
      ['https://www.example.com/throttled.png'],
      'https://www.example.com',
      dir,
      {
        fetchImpl,
        resolve: PUBLIC_RESOLVE,
        sleepImpl: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    assert.equal(entries[0]?.status, 'downloaded');
    assert.equal(calls, 2);
    assert.equal(sleeps.length, 1);
  });
});

test('asset-mirror > never retries deterministic failures (404, non-image content)', async () => {
  await withAssetsDir(async (dir) => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return response(PNG_BYTES, 'image/png', { status: 404, statusText: 'Not Found' });
    }) as unknown as typeof fetch;

    const { entries } = await mirrorAssets(
      ['https://www.example.com/missing.png'],
      'https://www.example.com',
      dir,
      { fetchImpl, resolve: PUBLIC_RESOLVE, sleepImpl: async () => undefined },
    );

    assert.equal(entries[0]?.status, 'failed');
    assert.equal(calls, 1, 'a 404 must not be retried');
  });

  await withAssetsDir(async (dir) => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return response(Buffer.from('html'), 'text/html');
    }) as unknown as typeof fetch;

    const { entries } = await mirrorAssets(
      ['https://www.example.com/page.png'],
      'https://www.example.com',
      dir,
      { fetchImpl, resolve: PUBLIC_RESOLVE, sleepImpl: async () => undefined },
    );

    assert.equal(entries[0]?.status, 'failed');
    assert.equal(calls, 1, 'a content-type policy failure must not be retried');
  });
});

test('asset-mirror > gives up after bounded attempts on persistent transients', async () => {
  await withAssetsDir(async (dir) => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw networkDropout();
    }) as unknown as typeof fetch;
    const sleeps: number[] = [];

    const { entries, uncaptured } = await mirrorAssets(
      ['https://www.example.com/dead.png'],
      'https://www.example.com',
      dir,
      {
        fetchImpl,
        resolve: PUBLIC_RESOLVE,
        sleepImpl: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    assert.equal(entries[0]?.status, 'failed');
    assert.equal(calls, 4, 'bounded: one initial attempt plus three retries');
    assert.equal(sleeps.length, 3);
    assert.ok(sleeps[2] >= 8000 && sleeps[2] < 10000, `third backoff ${sleeps[2]}ms`);
    assert.ok(uncaptured[0]?.reason.includes('fetch failed'));
  });
});

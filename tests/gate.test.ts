/**
 * Unit tests for the Gate 1 evidence review gate: non-interactive filtering
 * (blank pruning, redirect aliasing, evidence-gate.json emission) and
 * selective route-index parsing.
 *
 * spec: integration/visual-resilience s8.5
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';

import {
  filterEvidenceNonInteractive,
  parseRouteIndices,
} from '../dist/plan/evidenceGate.js';
import type { CrawlRoute, EvidenceManifest } from '../dist/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Renders a solid single-color PNG of the given size. */
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const idx = i << 2;
    png.data[idx] = rgb[0];
    png.data[idx + 1] = rgb[1];
    png.data[idx + 2] = rgb[2];
    png.data[idx + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** Renders a noisy (non-uniform) PNG so it never classifies as uniform. */
function noisyPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const idx = i << 2;
    png.data[idx] = (i * 7) % 256;
    png.data[idx + 1] = (i * 13) % 256;
    png.data[idx + 2] = (i * 29) % 256;
    png.data[idx + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** Minimal a11y tree with the requested node count. */
function a11yTree(nodeCount: number): { role: string; children?: unknown[] } {
  if (nodeCount <= 0) return { role: 'WebArea' };
  return {
    role: 'WebArea',
    children: Array.from({ length: nodeCount - 1 }, () => ({ role: 'Generic' })),
  };
}

function makeRoute(
  url: string,
  path: string,
  screenshotPath: string | null,
  nodes: number,
): CrawlRoute {
  return {
    url,
    path,
    title: path,
    desktopScreenshot: screenshotPath,
    mobileScreenshot: null,
    a11yTree: a11yTree(nodes) as unknown as CrawlRoute['a11yTree'],
    tokens: { colors: {}, fonts: [], spacing: [], radii: [] },
  };
}

async function makeManifest(): Promise<{
  evidenceDir: string;
  manifest: EvidenceManifest;
}> {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'apograph-gate-'));
  const screenshotsDir = join(evidenceDir, 'screenshots');
  await mkdir(screenshotsDir, { recursive: true });
  await writeFile(join(screenshotsDir, 'home-desktop.png'), noisyPng(64, 64));
  await writeFile(join(screenshotsDir, 'blank-desktop.png'), solidPng(64, 64, [255, 255, 255]));

  const manifest: EvidenceManifest = {
    targetUrl: 'https://example.com/en',
    crawledAt: new Date().toISOString(),
    stats: {
      pagesCrawled: 3,
      linksDiscovered: 0,
      assetsDownloaded: 0,
      assetsFailed: 0,
      externalAssets: 0,
      durationMs: 100,
    },
    routes: [
      makeRoute(
        'https://example.com/',
        '/',
        join(screenshotsDir, 'blank-desktop.png'),
        0,
      ),
      makeRoute(
        'https://example.com/en',
        '/en',
        join(screenshotsDir, 'home-desktop.png'),
        12,
      ),
      makeRoute(
        'https://example.com/en/about',
        '/en/about',
        join(screenshotsDir, 'blank-desktop.png'),
        1,
      ),
    ],
    assets: [],
    diagnostics: {
      skippedUrls: [],
      failedNavigations: [],
      uncapturedResources: [],
      redirectAliases: [{ from: 'https://example.com/', to: 'https://example.com/en', settleTimeMs: 50 }],
    },
  };

  return { evidenceDir, manifest };
}

// ---------------------------------------------------------------------------
// s8.5 - gate > non-interactive prunes suspect frames
// ---------------------------------------------------------------------------

test('gate > non-interactive prunes suspect frames and preserves healthy routes', async () => {
  const { evidenceDir, manifest } = await makeManifest();
  try {
    const { manifest: filtered, record } = await filterEvidenceNonInteractive(
      manifest,
      evidenceDir,
    );

    // Healthy route survives; blank and aliased routes are excluded.
    assert.equal(filtered.routes.length, 1);
    assert.equal(filtered.routes[0]?.path, '/en');

    // Record: alias action taken for the redirect transition frame.
    assert.equal(record.mode, 'non-interactive');
    assert.equal(record.aliases.length, 1);
    assert.deepEqual(record.aliases[0], {
      from: 'https://example.com/',
      to: 'https://example.com/en',
    });
    // Record: blank transition frame pruned as aliased; standalone blank pruned.
    const aliasedVerdict = record.verdicts.find((v) => v.path === '/');
    assert.equal(aliasedVerdict?.status, 'aliased');
    const blankVerdict = record.verdicts.find((v) => v.path === '/en/about');
    assert.equal(blankVerdict?.status, 'pruned');
    assert.equal(blankVerdict?.health?.blank, true);
    const healthyVerdict = record.verdicts.find((v) => v.path === '/en');
    assert.equal(healthyVerdict?.status, 'ok');
    assert.equal(healthyVerdict?.health?.blank, false);

    // evidence-gate.json emitted into the evidence dir with all decisions.
    const persisted = JSON.parse(
      await readFile(join(evidenceDir, 'evidence-gate.json'), 'utf8'),
    );
    assert.equal(persisted.mode, 'non-interactive');
    assert.equal(persisted.verdicts.length, 3);
    assert.equal(persisted.pruned.length, 1);
    assert.equal(persisted.aliases.length, 1);
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
  }
});

test('gate > missing screenshot file does not prune a populated route', async () => {
  const { evidenceDir, manifest } = await makeManifest();
  try {
    // Health cannot be evaluated without the screenshot: keep the route.
    (manifest.routes[1] as CrawlRoute).desktopScreenshot = null;
    const { manifest: filtered, record } = await filterEvidenceNonInteractive(manifest, evidenceDir);
    assert.equal(filtered.routes.length, 1);
    assert.equal(filtered.routes[0]?.path, '/en');
    assert.equal(record.verdicts.find((v) => v.path === '/en')?.health, null);
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// s8.5 - gate > selective re-crawl parses indices
// ---------------------------------------------------------------------------

test('gate > parses comma-separated indices', () => {
  assert.deepEqual(parseRouteIndices('2,5,7', 10), [2, 5, 7]);
  assert.deepEqual(parseRouteIndices(' 2 , 5 , 7 ', 10), [2, 5, 7]);
});

test('gate > parses ranges inclusively', () => {
  assert.deepEqual(parseRouteIndices('2-5', 10), [2, 3, 4, 5]);
  assert.deepEqual(parseRouteIndices('1,3-5', 10), [1, 3, 4, 5]);
  assert.deepEqual(parseRouteIndices('7-7', 10), [7]);
});

test('gate > deduplicates and sorts', () => {
  assert.deepEqual(parseRouteIndices('5,2,5,3', 10), [2, 3, 5]);
});

test('gate > rejects out-of-bounds indices with actionable errors', () => {
  assert.throws(() => parseRouteIndices('0', 10), /indices run 1-10|out of bounds/);
  assert.throws(() => parseRouteIndices('11', 10), /has 10 route/);
  assert.throws(() => parseRouteIndices('5-2', 10), /must not exceed/);
  assert.throws(() => parseRouteIndices('2-11', 10), /out of bounds/);
});

test('gate > rejects invalid tokens with actionable errors', () => {
  assert.throws(() => parseRouteIndices('a', 10), /Invalid selection token "a"/);
  assert.throws(() => parseRouteIndices('2,,5', 10), /Empty selection/);
  assert.throws(() => parseRouteIndices('', 10), /No route indices given/);
  assert.throws(() => parseRouteIndices('2.5', 10), /Invalid selection token/);
});

test('gate > rejects selection when no routes exist', () => {
  assert.throws(() => parseRouteIndices('1', 0), /No routes available/);
});

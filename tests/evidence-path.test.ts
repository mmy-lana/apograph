/**
 * Regression tests for the evidence-reference contract (relocatable bundles):
 *
 * 1. The crawler records manifest screenshot references bundle-relative
 *    (POSIX separators) so evidence bundles can be moved between machines
 *    and directories without breaking consumers.
 * 2. Consumers resolve BOTH bundle-relative references (preferred) and
 *    legacy absolute references written by older crawls.
 * 3. Containment is preserved: relative references cannot escape the
 *    evidence directory, and recording a path outside the bundle throws.
 *
 * spec: evidence manifest portability (see automate-testing-self-fixing.md
 * remediation record #2 for the defect that motivated this contract).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import {
  resolveContainedPath,
  resolveEvidenceReference,
  toEvidenceRelativePath,
} from '../dist/utils/fs-safe.js';
import { filterEvidenceNonInteractive } from '../dist/plan/evidenceGate.js';
import type { CrawlRoute, EvidenceManifest } from '../dist/types.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
  path: string,
  screenshotReference: string | null,
  nodes: number,
): CrawlRoute {
  return {
    url: `https://example.com${path}`,
    path,
    title: path,
    desktopScreenshot: screenshotReference,
    mobileScreenshot: null,
    a11yTree: a11yTree(nodes) as unknown as CrawlRoute['a11yTree'],
    tokens: { colors: {}, fonts: [], spacing: [], radii: [] },
  };
}

// ---------------------------------------------------------------------------
// toEvidenceRelativePath / resolveEvidenceReference
// ---------------------------------------------------------------------------

test('evidence-path > manifest references round-trip bundle-relative', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'apograph-evidence-path-'));
  try {
    const absolute = join(evidenceDir, 'screenshots', 'index-desktop.png');
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, noisyPng(8, 8));

    const relative = toEvidenceRelativePath(evidenceDir, absolute);
    assert.equal(relative, 'screenshots/index-desktop.png');

    assert.equal(resolveEvidenceReference(evidenceDir, relative), absolute);
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
  }
});

test('evidence-path > recording a path outside the bundle throws', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'apograph-evidence-path-'));
  try {
    assert.throws(
      () => toEvidenceRelativePath(evidenceDir, join(evidenceDir, '..', 'outside.png')),
      /escapes authorized root/,
    );
    assert.throws(
      () => toEvidenceRelativePath(evidenceDir, evidenceDir),
      /escapes authorized root/,
    );
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
  }
});

test('evidence-path > resolution honors legacy absolute paths and rejects traversal', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'apograph-evidence-path-'));
  try {
    const absolute = join(evidenceDir, 'screenshots', 'old-bundle.png');
    // Legacy absolute references (older evidence bundles) resolve as-is.
    assert.equal(resolveEvidenceReference(evidenceDir, absolute), absolute);

    // Relative references stay containment-checked.
    assert.throws(
      () => resolveEvidenceReference(evidenceDir, '../outside.png'),
      /Unsafe relative path|escapes authorized root/,
    );
    assert.equal(
      resolveEvidenceReference(evidenceDir, 'screenshots/kept.png'),
      resolveContainedPath(evidenceDir, 'screenshots/kept.png'),
    );
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Gate health evaluation with bundle-relative references (producer contract)
// ---------------------------------------------------------------------------

test('evidence-path > gate pruning works with bundle-relative screenshot references', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'apograph-evidence-path-'));
  try {
    const screenshotsDir = join(evidenceDir, 'screenshots');
    await mkdir(screenshotsDir, { recursive: true });
    await writeFile(join(screenshotsDir, 'home-desktop.png'), noisyPng(64, 64));
    await writeFile(join(screenshotsDir, 'blank-desktop.png'), solidPng(64, 64, [255, 255, 255]));

    const manifest: EvidenceManifest = {
      targetUrl: 'https://example.com/en',
      crawledAt: new Date().toISOString(),
      stats: {
        pagesCrawled: 2,
        linksDiscovered: 0,
        assetsDownloaded: 0,
        assetsFailed: 0,
        externalAssets: 0,
        durationMs: 100,
      },
      routes: [
        // Bundle-relative references exactly as the crawler records them.
        makeRoute('/', 'screenshots/blank-desktop.png', 0),
        makeRoute('/en', 'screenshots/home-desktop.png', 12),
      ],
      assets: [],
      diagnostics: {
        skippedUrls: [],
        failedNavigations: [],
        uncapturedResources: [],
        redirectAliases: [],
      },
    };

    const { manifest: filtered, record } = await filterEvidenceNonInteractive(
      manifest,
      evidenceDir,
    );

    assert.deepEqual(record.pruned.map((entry) => entry.path), ['/']);
    assert.deepEqual(filtered.routes.map((route) => route.path), ['/en']);
    // The pruned route's health must have been evaluated from the bundle
    // (uniform blank frame), not silently skipped as a missing screenshot.
    const prunedVerdict = record.verdicts?.find((verdict) => verdict.path === '/');
    if (prunedVerdict !== undefined) {
      assert.notEqual(prunedVerdict.health, null);
    }
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Producer source invariant (repo test style: see tests/scroll.test.ts)
// ---------------------------------------------------------------------------

test('evidence-path > crawler records both screenshot references bundle-relative', async () => {
  const engineText = await readFile(join(SRC_ROOT, 'src', 'crawler', 'engine.ts'), 'utf8');
  assert.ok(
    engineText.includes('toEvidenceRelativePath(evidenceDir, desktopScreenshot)'),
    'crawler must record desktopScreenshot bundle-relative',
  );
  assert.ok(
    engineText.includes('toEvidenceRelativePath(evidenceDir, mobileScreenshot)'),
    'crawler must record mobileScreenshot bundle-relative',
  );
});

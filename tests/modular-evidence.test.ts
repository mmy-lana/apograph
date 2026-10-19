import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEvidenceManifest, loadRouteEvidence } from '../dist/plan/generator.js';
import { writeModularEvidence } from '../dist/crawler/engine.js';
import { slugForPath } from '../dist/utils/fs-safe.js';
import type { CrawlRoute, EvidenceManifest } from '../dist/types.js';

function createSampleRoute(): CrawlRoute {
  return {
    url: 'https://example.com/',
    path: '/',
    title: 'Example Domain',
    desktopScreenshot: 'screenshots/index-desktop.png',
    mobileScreenshot: 'screenshots/index-mobile.png',
    a11yTree: { role: 'WebArea', name: 'Example' },
    tokens: {
      colors: { 'color:#ffffff': '#ffffff' },
      fonts: ['Inter'],
      spacing: ['16px'],
      radii: ['4px'],
    },
    textSpans: [
      {
        text: 'Example Domain',
        color: 'rgb(0, 0, 0)',
        tag: 'h1',
        parentTag: 'div',
      },
    ],
    mobileTextSpans: [
      {
        text: 'Example Domain',
        color: 'rgb(0, 0, 0)',
        tag: 'h1',
        parentTag: 'div',
      },
    ],
  };
}

function createSampleManifest(): EvidenceManifest {
  return {
    targetUrl: 'https://example.com/',
    crawledAt: new Date().toISOString(),
    stats: {
      pagesCrawled: 1,
      linksDiscovered: 5,
      assetsDownloaded: 1,
      assetsFailed: 0,
      externalAssets: 0,
      durationMs: 1200,
    },
    routes: [createSampleRoute()],
    assets: [
      {
        originalUrl: 'https://example.com/logo.png',
        localPath: 'assets/logo.png',
        status: 'downloaded',
      },
    ],
    diagnostics: {
      skippedUrls: [],
      failedNavigations: [],
      uncapturedResources: [],
      redirectAliases: [],
    },
  };
}

test('modular-evidence > loads legacy monolithic manifest.json transparently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apograph-legacy-manifest-'));
  try {
    const original = createSampleManifest();
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(original, null, 2), 'utf8');

    const loaded = await loadEvidenceManifest(dir);
    assert.equal(loaded.targetUrl, original.targetUrl);
    assert.equal(loaded.routes.length, 1);
    assert.equal(loaded.routes[0]?.path, '/');
    assert.equal(loaded.routes[0]?.a11yTree.role, 'WebArea');
    assert.equal(loaded.routes[0]?.textSpans?.[0]?.text, 'Example Domain');
    assert.equal(loaded.assets.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('modular-evidence > hydrates modular per-route directory evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apograph-modular-manifest-'));
  try {
    const original = createSampleManifest();
    const route = original.routes[0]!;

    const routesDir = join(dir, 'routes', 'index');
    await mkdir(routesDir, { recursive: true });

    const { a11yTree, textSpans, mobileTextSpans, ...routeMeta } = route;
    await writeFile(join(routesDir, 'route.json'), JSON.stringify(routeMeta, null, 2), 'utf8');
    await writeFile(join(routesDir, 'a11y.json'), JSON.stringify(a11yTree, null, 2), 'utf8');
    await writeFile(
      join(routesDir, 'text-spans.json'),
      JSON.stringify({ desktop: textSpans, mobile: mobileTextSpans }, null, 2),
      'utf8',
    );
    await writeFile(join(dir, 'assets.json'), JSON.stringify(original.assets, null, 2), 'utf8');

    const indexManifest = {
      targetUrl: original.targetUrl,
      crawledAt: original.crawledAt,
      stats: original.stats,
      routes: [
        {
          path: route.path,
          url: route.url,
          title: route.title,
          slug: 'index',
          desktopScreenshot: route.desktopScreenshot,
          mobileScreenshot: route.mobileScreenshot,
        },
      ],
      diagnostics: original.diagnostics,
    };
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(indexManifest, null, 2), 'utf8');

    const loaded = await loadEvidenceManifest(dir);
    assert.equal(loaded.targetUrl, original.targetUrl);
    assert.equal(loaded.routes.length, 1);
    assert.equal(loaded.routes[0]?.path, '/');
    assert.equal(loaded.routes[0]?.a11yTree.role, 'WebArea');
    assert.equal(loaded.routes[0]?.textSpans?.[0]?.text, 'Example Domain');
    assert.equal(loaded.routes[0]?.mobileTextSpans?.[0]?.text, 'Example Domain');
    assert.equal(loaded.assets.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('modular-evidence > writeModularEvidence emits the modular layout with a lightweight index', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apograph-modular-write-'));
  try {
    const original = createSampleManifest();
    original.routes.push({
      ...createSampleRoute(),
      url: 'https://example.com/about-us',
      path: '/about-us',
      title: 'About Us',
      desktopScreenshot: 'screenshots/about-us-desktop.png',
      mobileScreenshot: 'screenshots/about-us-mobile.png',
      metadata: { description: 'About the example domain' },
    });
    original.stats.pagesCrawled = 2;

    await writeModularEvidence(dir, original);

    // Root manifest stays a lightweight index: no inlined trees or spans.
    const indexText = await readFile(join(dir, 'manifest.json'), 'utf8');
    assert.ok(indexText.split('\n').length < 150, 'manifest.json must stay under 150 lines');
    assert.ok(!indexText.includes('a11yTree'), 'manifest.json must not inline a11y trees');
    assert.ok(!indexText.includes('textSpans'), 'manifest.json must not inline text spans');
    const index = JSON.parse(indexText) as {
      routes: Array<{ path: string; slug: string }>;
    };
    assert.equal(index.routes.length, 2);
    assert.equal(index.routes[0]?.slug, 'index');
    assert.equal(index.routes[1]?.slug, 'about-us');

    // Canonical global asset registry.
    const assets = JSON.parse(await readFile(join(dir, 'assets.json'), 'utf8')) as unknown[];
    assert.equal(assets.length, 1);

    // Per-route sub-bundles.
    for (const slug of ['index', 'about-us']) {
      const routeDir = join(dir, 'routes', slug);
      JSON.parse(await readFile(join(routeDir, 'route.json'), 'utf8'));
      JSON.parse(await readFile(join(routeDir, 'a11y.json'), 'utf8'));
      const spans = JSON.parse(await readFile(join(routeDir, 'text-spans.json'), 'utf8')) as {
        desktop: unknown[];
        mobile?: unknown[];
      };
      assert.equal(spans.desktop.length, 1);
      assert.equal(spans.mobile?.length, 1);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('modular-evidence > hydrates identical data from modular and legacy layouts', async () => {
  const modularDir = await mkdtemp(join(tmpdir(), 'apograph-modular-equiv-'));
  const legacyDir = await mkdtemp(join(tmpdir(), 'apograph-legacy-equiv-'));
  try {
    const original = createSampleManifest();
    original.routes.push({
      ...createSampleRoute(),
      url: 'https://example.com/about-us',
      path: '/about-us',
      title: 'About Us',
      desktopScreenshot: 'screenshots/about-us-desktop.png',
      mobileScreenshot: 'screenshots/about-us-mobile.png',
    });
    original.stats.pagesCrawled = 2;

    await writeModularEvidence(modularDir, original);
    await writeFile(join(legacyDir, 'manifest.json'), JSON.stringify(original, null, 2), 'utf8');

    const fromModular = await loadEvidenceManifest(modularDir);
    const fromLegacy = await loadEvidenceManifest(legacyDir);
    assert.deepStrictEqual(fromModular, fromLegacy);
    assert.equal(fromModular.routes.length, 2);
    assert.equal(fromModular.routes[1]?.metadata?.description, undefined);
  } finally {
    await rm(modularDir, { recursive: true, force: true });
    await rm(legacyDir, { recursive: true, force: true });
  }
});

test('modular-evidence > loadRouteEvidence reads a single route from the modular layout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apograph-modular-route-'));
  try {
    const original = createSampleManifest();
    original.routes.push({
      ...createSampleRoute(),
      url: 'https://example.com/about-us',
      path: '/about-us',
      title: 'About Us',
    });
    await writeModularEvidence(dir, original);

    const route = await loadRouteEvidence(dir, '/about-us');
    assert.equal(route.path, '/about-us');
    assert.equal(route.title, 'About Us');
    assert.equal(route.a11yTree.role, 'WebArea');
    assert.equal(route.textSpans?.[0]?.text, 'Example Domain');
    assert.equal(route.mobileTextSpans?.[0]?.text, 'Example Domain');
    assert.deepEqual(route.tokens.fonts, ['Inter']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('modular-evidence > loadRouteEvidence falls back to a legacy monolithic manifest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apograph-legacy-route-'));
  try {
    const original = createSampleManifest();
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(original, null, 2), 'utf8');

    const route = await loadRouteEvidence(dir, '/');
    assert.equal(route.path, '/');
    assert.equal(route.a11yTree.role, 'WebArea');

    await assert.rejects(loadRouteEvidence(dir, '/missing'), /Route not found in evidence manifest/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('modular-evidence > missing route sub-files fail with clear errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apograph-modular-missing-'));
  try {
    const original = createSampleManifest();
    await writeModularEvidence(dir, original);
    await rm(join(dir, 'routes', 'index', 'a11y.json'));

    await assert.rejects(
      loadEvidenceManifest(dir),
      /Missing modular evidence file: .*a11y\.json \(route \/ a11y tree\)/,
    );
    await assert.rejects(
      loadRouteEvidence(dir, '/'),
      /Missing modular evidence file: .*a11y\.json \(route \/ a11y tree\)/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('modular-evidence > slugForPath derives safe, stable route slugs', () => {
  assert.equal(slugForPath('/'), 'index');
  assert.equal(slugForPath('/about-us'), 'about-us');
  assert.equal(slugForPath('/blog/post'), 'blog-post');
  assert.equal(slugForPath('/weird path!'), 'weird-path');
  assert.ok(!slugForPath('/../../etc/passwd').includes('/'));
});

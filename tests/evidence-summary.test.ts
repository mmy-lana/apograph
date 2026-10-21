/**
 * Tests for the pre-flight evidence summary table (`--dry-run`).
 *
 * The summary reports exactly what the crawl captured — route title, text
 * span count, image asset count, screenshot path, and the pre-flight
 * bot-check verdict — so a run can be inspected before any plan gate or LLM
 * synthesis is attempted. Pure formatting: no crawl, no LLM, no filesystem.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEvidenceSummaryRows,
  formatEvidenceSummaryTable,
  blockedSummaryRow,
  formatBotCheck,
  EVIDENCE_SUMMARY_HEADERS,
} from '../dist/commands/evidenceSummary.js';
import type {
  AssetEntry,
  CrawlRoute,
  EvidenceManifest,
  RouteBotCheck,
  TextSpan,
} from '../dist/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function span(text: string): TextSpan {
  return { text, color: 'rgb(0, 0, 0)', tag: 'span', parentTag: 'p' };
}

function route(overrides: Partial<CrawlRoute> = {}): CrawlRoute {
  return {
    url: 'https://example.com/',
    path: '/',
    title: 'Example Domain',
    desktopScreenshot: 'screenshots/root-desktop.png',
    mobileScreenshot: 'screenshots/root-mobile.png',
    a11yTree: { role: 'root' },
    tokens: { colors: {}, fonts: [], spacing: [], radii: [] },
    ...overrides,
  };
}

function asset(overrides: Partial<AssetEntry> = {}): AssetEntry {
  return {
    originalUrl: 'https://example.com/logo.png',
    localPath: 'assets/logo.png',
    status: 'downloaded',
    routes: ['/'],
    ...overrides,
  };
}

function manifest(routes: CrawlRoute[], assets: AssetEntry[]): EvidenceManifest {
  return {
    targetUrl: 'https://example.com/',
    crawledAt: '2024-01-01T00:00:00.000Z',
    stats: {
      pagesCrawled: routes.length,
      linksDiscovered: 0,
      assetsDownloaded: assets.filter((entry) => entry.status === 'downloaded').length,
      assetsFailed: 0,
      externalAssets: 0,
      durationMs: 1,
    },
    routes,
    assets,
    diagnostics: {
      skippedUrls: [],
      failedNavigations: [],
      uncapturedResources: [],
      redirectAliases: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Row construction
// ---------------------------------------------------------------------------

test('evidence summary > rows report title, spans, images, screenshot, bot check', () => {
  const cleanCheck: RouteBotCheck = {
    verdict: 'clean',
    signature: null,
    detail: 'no challenge signatures',
  };
  const rows = buildEvidenceSummaryRows(
    manifest(
      [
        route({
          textSpans: [span('Hello'), span('World')],
          mobileTextSpans: [span('Hello')],
          botCheck: cleanCheck,
        }),
      ],
      [
        asset({ routes: ['/'] }),
        asset({ originalUrl: 'https://example.com/hero.jpg', localPath: 'assets/hero.jpg', routes: ['/'] }),
        asset({ originalUrl: 'https://example.com/ext.png', localPath: null, status: 'external', routes: ['/'] }),
      ],
    ),
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.route, '/');
  assert.equal(rows[0]?.title, 'Example Domain');
  assert.equal(rows[0]?.textSpans, 3, 'desktop + mobile corpora are counted');
  assert.equal(rows[0]?.imageAssets, 2, 'only downloaded assets count');
  assert.equal(rows[0]?.screenshot, 'screenshots/root-desktop.png');
  assert.equal(rows[0]?.botCheck, 'clean');
});

test('evidence summary > image assets are attributed per route', () => {
  const rows = buildEvidenceSummaryRows(
    manifest(
      [route({ path: '/' }), route({ url: 'https://example.com/about', path: '/about', title: 'About' })],
      [
        asset({ routes: ['/about'] }),
        asset({ originalUrl: 'https://example.com/2.png', localPath: 'assets/2.png', routes: ['/about', '/'] }),
      ],
    ),
  );
  assert.equal(rows[0]?.imageAssets, 1);
  assert.equal(rows[1]?.imageAssets, 2);
});

test('evidence summary > screenshot falls back to mobile, then (none)', () => {
  const rows = buildEvidenceSummaryRows(
    manifest(
      [
        route({ desktopScreenshot: null, mobileScreenshot: 'screenshots/root-mobile.png' }),
        route({ path: '/bare', desktopScreenshot: null, mobileScreenshot: null }),
      ],
      [],
    ),
  );
  assert.equal(rows[0]?.screenshot, 'screenshots/root-mobile.png');
  assert.equal(rows[1]?.screenshot, '(none)');
});

test('evidence summary > bot-check verdicts render legacy and blocked states', () => {
  assert.equal(formatBotCheck(undefined), 'unchecked');
  assert.equal(formatBotCheck({ verdict: 'clean', signature: null, detail: '' }), 'clean');
  assert.equal(
    formatBotCheck({ verdict: 'blocked', signature: 'challenge-title', detail: '' }),
    'blocked (challenge-title)',
  );

  const rows = buildEvidenceSummaryRows(manifest([route()], []));
  assert.equal(rows[0]?.botCheck, 'unchecked', 'legacy bundles without a verdict report unchecked');
});

test('evidence summary > untitled routes render (untitled)', () => {
  const rows = buildEvidenceSummaryRows(manifest([route({ title: '   ' })], []));
  assert.equal(rows[0]?.title, '(untitled)');
});

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

test('evidence summary > table renders headers, separators, and every row', () => {
  const rows = buildEvidenceSummaryRows(
    manifest(
      [
        route({ textSpans: [span('a')], botCheck: { verdict: 'clean', signature: null, detail: '' } }),
        route({
          url: 'https://example.com/about',
          path: '/about',
          title: 'About',
          desktopScreenshot: 'screenshots/about-desktop.png',
          botCheck: { verdict: 'clean', signature: null, detail: '' },
        }),
      ],
      [asset()],
    ),
  );
  const table = formatEvidenceSummaryTable(rows);

  for (const header of EVIDENCE_SUMMARY_HEADERS) {
    assert.ok(table.includes(header), `table must carry the "${header}" column`);
  }
  assert.ok(table.includes('Example Domain'));
  assert.ok(table.includes('/about'));
  assert.ok(table.includes('screenshots/about-desktop.png'));
  assert.ok(table.includes('clean'));
});

test('evidence summary > long titles and paths are truncated, never spilled', () => {
  const longTitle = 'A'.repeat(120);
  const table = formatEvidenceSummaryTable(
    buildEvidenceSummaryRows(manifest([route({ title: longTitle })], [])),
  );
  assert.ok(!table.includes(longTitle), 'over-long titles are truncated');
  assert.ok(table.includes('…'), 'truncation is visible');
});

test('evidence summary > empty manifests render a header-only table', () => {
  const table = formatEvidenceSummaryTable([]);
  assert.ok(table.includes('Route'));
  assert.ok(table.includes('Bot check'));
});

test('evidence summary > a blocked crawl renders its verdict row', () => {
  const row = blockedSummaryRow('https://blocked.example/', {
    verdict: 'blocked',
    signature: 'challenge-title',
    detail: 'document title "Just a moment..." matches a bot challenge signature',
  });
  assert.equal(row.botCheck, 'blocked (challenge-title)');
  assert.equal(row.screenshot, '(none)');
  assert.equal(row.textSpans, 0);

  const table = formatEvidenceSummaryTable([row]);
  assert.ok(table.includes('blocked (challenge-title)'));
  assert.ok(table.includes('https://blocked.example/'));
});

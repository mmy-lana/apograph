/**
 * apograph — Headless crawl engine (Layer 1b: Crawl).
 *
 * Replaces the old CDP-attach flow: launches its own headless Chromium via
 * `playwright.chromium.launch({ headless: true })` — no
 * `--remote-debugging-port=9222` required.
 *
 * Crawls same-origin links from a root URL (max depth 2, max 10 pages —
 * both configurable), prioritizing navigation pages (`/about`, `/pricing`,
 * `/features`, `/contact`, `/faq`). For every page it captures:
 * - dual-viewport screenshots (desktop 1280x800, mobile 390x844) as PNGs;
 * - the a11y tree and CSSTree design tokens (reusing `harvester/dom.ts`);
 * - image asset references, mirrored into the evidence bundle afterwards.
 *
 * Everything is recorded in `.apograph/evidence/manifest.json`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import type { Browser, Frame, Page } from 'playwright';
import type {
  CrawlScope,
  EvidenceManifest,
  RedirectAliasRecord,
  RouteMetadata,
  ViewportMode,
} from '../types.js';
import { captureDOMSnapshot } from '../harvester/dom.js';
import { discoverImageAssets, mirrorAssets } from './assets.js';
import {
  checkCaptureHealth,
  classifyRedirect,
} from './health.js';
import type { CaptureHealth } from './health.js';
import {
  createScopeFilter,
  isCrawlablePage,
  isSameOrigin,
  linkPriority,
  normalizeUrl,
} from './urls.js';

// ---------------------------------------------------------------------------
// Options & constants
// ---------------------------------------------------------------------------

/** Options for {@link crawlEvidence}. */
export interface CrawlOptions {
  /** The root URL to start crawling from. */
  rootUrl: string;
  /** Evidence output directory. Defaults to `.apograph/evidence`. */
  evidenceDir?: string;
  /** Max crawl depth (links followed from the root). Defaults to 2. */
  maxDepth?: number;
  /** Max number of pages crawled. Defaults to 10. */
  maxPages?: number;
  /** Which viewports to screenshot. Defaults to `both`. */
  viewport?: ViewportMode;
  /** Same-origin crawl scope. Defaults to `site`. */
  scope?: CrawlScope;
}

/** Desktop capture viewport. */
const DESKTOP_VIEWPORT = { width: 1280, height: 800 } as const;

/** Mobile capture viewport. */
const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;

/** Default evidence directory (relative to cwd). */
const DEFAULT_EVIDENCE_DIR = '.apograph/evidence';

/** Default crawl bounds. */
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_PAGES = 10;

/** Per-page navigation timeout. */
const NAVIGATION_TIMEOUT_MS = 30_000;

/** One pending URL in the crawl frontier. */
interface FrontierEntry {
  url: string;
  depth: number;
  priority: number;
  order: number;
}

// ---------------------------------------------------------------------------
// Headless browser lifecycle
// ---------------------------------------------------------------------------

/**
 * Launches the shared headless Chromium instance used by every capture
 * pipeline (evidence crawl and harvest alike). No CDP port is required.
 */
export async function launchHeadlessChromium(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

// ---------------------------------------------------------------------------
// Crawl engine
// ---------------------------------------------------------------------------

/** Derives a filesystem-safe slug from a URL path (`/` -> `index`). */
function slugForPath(pathname: string): string {
  const slug = pathname
    .split('/')
    .filter(Boolean)
    .join('-')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length > 0 ? slug : 'index';
}

/**
 * Runs the full evidence crawl for a root URL and writes the evidence bundle
 * (screenshots, mirrored assets, `manifest.json`) under the evidence dir.
 * Returns the persisted manifest.
 */
export async function crawlEvidence(options: CrawlOptions): Promise<EvidenceManifest> {
  const requestedRoot = normalizeUrl(options.rootUrl);
  if (requestedRoot === null) {
    throw new Error(`Invalid root URL: ${options.rootUrl}`);
  }

  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const viewportMode: ViewportMode = options.viewport ?? 'both';
  const scope: CrawlScope = options.scope ?? 'site';

  const captureDesktop = viewportMode !== 'mobile';
  const captureMobile = viewportMode !== 'desktop';

  const evidenceDir = resolve(options.evidenceDir ?? DEFAULT_EVIDENCE_DIR);
  const screenshotsDir = join(evidenceDir, 'screenshots');
  const assetsDir = join(evidenceDir, 'assets');
  await mkdir(screenshotsDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });

  const startedAt = Date.now();

  const browser = await launchHeadlessChromium();

  const routes: EvidenceManifest['routes'] = [];
  const assetUrls = new Set<string>();
  const diagnostics: EvidenceManifest['diagnostics'] = {
    skippedUrls: [],
    failedNavigations: [],
    uncapturedResources: [],
    redirectAliases: [],
  };

  const visited = new Set<string>();
  const queued = new Set<string>();
  const recordedSkips = new Set<string>();
  const frontier: FrontierEntry[] = [
    { url: requestedRoot, depth: 0, priority: 0, order: 0 },
  ];
  queued.add(requestedRoot);

  const bookkeeping: CrawlBookkeeping = {
    visited,
    queued,
    frontier,
    linksDiscovered: 0,
    order: 1,
  };

  /** Records a skip once per URL. */
  const skip = (url: string, reason: string): void => {
    const key = `${url}::${reason}`;
    if (recordedSkips.has(key)) return;
    recordedSkips.add(key);
    diagnostics.skippedUrls.push({ url, reason });
  };

  /** The canonical root: updated to the post-redirect URL on the first page. */
  let canonicalRoot = requestedRoot;

  /** Deferred alias verdict awaiting confirmation of the target's health. */
  let pendingAlias: RedirectAliasRecord | null = null;

  try {
    const context = await browser.newContext({ viewport: { ...DESKTOP_VIEWPORT } });
    const page = await context.newPage();

    while (frontier.length > 0 && visited.size < maxPages) {
      // Highest priority first, then shallowest, then discovery order.
      frontier.sort(
        (a, b) => b.priority - a.priority || a.depth - b.depth || a.order - b.order,
      );
      const entry = frontier.shift();
      if (entry === undefined) break;

      queued.delete(entry.url);
      if (visited.has(entry.url)) continue;
      visited.add(entry.url);

      const path = safePathname(entry.url);

      let title = '';
      // Settle-time measurement for instant redirect detection (spec s2.2):
      // time between navigation start and the last main-frame navigation.
      const gotoStart = Date.now();
      let lastNavTime = gotoStart;
      const onNavigated = (frame: Frame): void => {
        if (frame === page.mainFrame()) lastNavTime = Date.now();
      };
      page.on('framenavigated', onNavigated);
      try {
        await page.goto(entry.url, {
          waitUntil: 'networkidle',
          timeout: NAVIGATION_TIMEOUT_MS,
        });
        title = await page.title();
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        diagnostics.failedNavigations.push({ url: entry.url, reason });
        continue;
      } finally {
        page.off('framenavigated', onNavigated);
      }
      const settleTimeMs = lastNavTime - gotoStart;

      // Record the post-redirect URL as the canonical root when the initial
      // request was redirected (e.g. /faq -> /frequently-asked-questions).
      if (entry.url === requestedRoot) {
        const finalUrl = normalizeUrl(page.url());
        if (finalUrl !== null && finalUrl !== entry.url) {
          canonicalRoot = finalUrl;
          diagnostics.skippedUrls.push({
            url: entry.url,
            reason: `redirected to ${finalUrl} (recorded as canonical root)`,
          });
        }
      }

      // DOM snapshot + a11y tree + design tokens (shared harvester logic).
      const snapshot = await captureDOMSnapshot(page, path);

      // SEO / OpenGraph metadata extraction.
      const metadata = await extractRouteMetadata(page, title);

      // Viewport-gated screenshots.
      const slug = slugForPath(path);
      const desktopScreenshot = captureDesktop
        ? join(screenshotsDir, `${slug}-desktop.png`)
        : null;
      const mobileScreenshot = captureMobile
        ? join(screenshotsDir, `${slug}-mobile.png`)
        : null;

      if (captureDesktop) {
        await page.setViewportSize({ ...DESKTOP_VIEWPORT });
        await page.screenshot({ path: desktopScreenshot as string, type: 'png' });
      }
      if (captureMobile) {
        await page.setViewportSize({ ...MOBILE_VIEWPORT });
        await page.screenshot({ path: mobileScreenshot as string, type: 'png' });
      }
      if (captureDesktop) {
        await page.setViewportSize({ ...DESKTOP_VIEWPORT });
      }

      // Capture health checks (spec s2.1): visible node count plus pixel
      // uniformity of the desktop screenshot.
      const visibleNodeCount = await countVisibleNodes(page);
      let health: CaptureHealth = {
        blank: false,
        reason: null,
        uniformityRatio: 1,
        dominantColor: null,
        visibleNodeCount,
      };
      if (desktopScreenshot !== null) {
        const png = await readFile(desktopScreenshot);
        health = checkCaptureHealth(png, visibleNodeCount);
      }

      // Instant redirect classification (spec s2.2): when the initial
      // navigation settled instantly (< 500ms) onto a distinct URL and the
      // pre-redirect frame is blank, alias instead of recording a dead route.
      // The post-redirect frame's own health is confirmed after the loop.
      const finalUrl = normalizeUrl(page.url());
      if (finalUrl !== null && finalUrl !== entry.url && health.blank) {
        const postHealth = {
          blank: false,
          reason: null,
          uniformityRatio: 0,
          dominantColor: null,
          visibleNodeCount: 0,
        };
        const verdict = classifyRedirect(entry.url, finalUrl, settleTimeMs, health, postHealth);
        if (verdict.alias) {
          pendingAlias = { from: entry.url, to: finalUrl, settleTimeMs };
          skip(entry.url, `blank transition frame; aliased to ${finalUrl}`);
          // Make sure the alias target itself is captured.
          if (!visited.has(finalUrl) && !queued.has(finalUrl)) {
            frontier.push({
              url: finalUrl,
              depth: entry.depth,
              priority: 0,
              order: bookkeeping.order++,
            });
            queued.add(finalUrl);
          }
          continue;
        }
      }

      // Automated pruning (spec s3.2): blank frames never enter synthesis.
      if (health.blank) {
        skip(entry.url, `blank capture frame (${health.reason ?? 'unknown'})`);
        continue;
      }

      routes.push({
        url: entry.url,
        path,
        title,
        desktopScreenshot,
        mobileScreenshot,
        metadata,
        a11yTree: snapshot.a11yTree,
        tokens: snapshot.tokens,
      });

      // Link discovery (scoped against the canonical root).
      const scopeFilter = createScopeFilter(canonicalRoot, scope);
      await enqueueLinks(page, entry, canonicalRoot, scopeFilter, maxDepth, maxPages, bookkeeping, skip);

      // Asset discovery.
      for (const assetUrl of await discoverImageAssets(page)) {
        assetUrls.add(assetUrl);
      }
    }

    // Whatever the frontier still holds was cut off by the page cap.
    for (const entry of frontier) {
      skip(entry.url, `page-cap (max ${maxPages} pages)`);
    }

    // Confirm the deferred alias: it stands only when the redirect target
    // was captured as a healthy route; otherwise the frame stays suspect.
    const alias = pendingAlias;
    if (alias !== null) {
      const targetHealthy = routes.some((route) => route.url === alias.to);
      if (targetHealthy) {
        diagnostics.redirectAliases.push(alias);
      } else {
        skip(alias.from, 'suspect (blank redirect frame without healthy target)');
      }
    }
  } finally {
    await browser.close();
  }

  // Asset mirroring pass (same-origin against the canonical root).
  const rootOrigin = new URL(canonicalRoot).origin;
  const { entries: assets, uncaptured } = await mirrorAssets(
    [...assetUrls],
    rootOrigin,
    assetsDir,
  );
  diagnostics.uncapturedResources.push(...uncaptured);

  const manifest: EvidenceManifest = {
    targetUrl: canonicalRoot,
    crawledAt: new Date().toISOString(),
    stats: {
      pagesCrawled: routes.length,
      linksDiscovered: bookkeeping.linksDiscovered,
      assetsDownloaded: assets.filter((asset) => asset.status === 'downloaded').length,
      assetsFailed: assets.filter((asset) => asset.status === 'failed').length,
      externalAssets: assets.filter((asset) => asset.status === 'external').length,
      durationMs: Date.now() - startedAt,
    },
    routes,
    assets,
    diagnostics,
  };

  await writeFile(
    join(evidenceDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );

  return manifest;
}

// ---------------------------------------------------------------------------
// Visible node counting (spec s2.1)
// ---------------------------------------------------------------------------

/** In-page collector counting visible element nodes beneath <body>. */
function countVisibleNodesInPage(): number {
  if (document.body === null) return 0;
  let count = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const el = walker.currentNode as Element;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) count += 1;
  }
  return count;
}

/** Counts visible DOM nodes on the current page (spec s2.1 DOM emptiness). */
async function countVisibleNodes(page: Page): Promise<number> {
  return page.evaluate(countVisibleNodesInPage);
}

// ---------------------------------------------------------------------------
// SEO / OpenGraph metadata extraction
// ---------------------------------------------------------------------------

/** In-page collector for <head> metadata (title, description, icon, OG tags). */
function collectHeadMetadata(): {
  description: string | null;
  favicon: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
} {
  const metaContent = (selector: string): string | null => {
    const el = document.querySelector(selector);
    const content = el?.getAttribute('content');
    return content !== null && content !== undefined && content.length > 0 ? content : null;
  };

  const iconEl = document.querySelector(
    'link[rel="icon"], link[rel="shortcut icon"], link[rel~="icon"]',
  );
  const favicon = iconEl?.getAttribute('href');
  const description = metaContent('meta[name="description"]');

  return {
    description,
    favicon: favicon !== null && favicon !== undefined && favicon.length > 0 ? favicon : null,
    ogTitle: metaContent('meta[property="og:title"]'),
    ogDescription: metaContent('meta[property="og:description"]'),
    ogImage: metaContent('meta[property="og:image"]'),
  };
}

/** Extracts SEO metadata from a loaded page, resolving the favicon URL. */
async function extractRouteMetadata(page: Page, title: string): Promise<RouteMetadata> {
  const raw = await page.evaluate(collectHeadMetadata);
  const pageUrl = page.url();

  const metadata: RouteMetadata = { title };
  if (raw.description !== null) metadata.description = raw.description;
  if (raw.ogTitle !== null) metadata.ogTitle = raw.ogTitle;
  if (raw.ogDescription !== null) metadata.ogDescription = raw.ogDescription;
  if (raw.ogImage !== null) metadata.ogImage = raw.ogImage;
  if (raw.favicon !== null) {
    try {
      metadata.favicon = new URL(raw.favicon, pageUrl).href;
    } catch {
      // Malformed favicon href — drop it.
    }
  }

  return metadata;
}

// ---------------------------------------------------------------------------
// Link enqueueing
// ---------------------------------------------------------------------------

/** Mutable crawl bookkeeping passed to the link enqueueing step. */
interface CrawlBookkeeping {
  visited: Set<string>;
  queued: Set<string>;
  frontier: FrontierEntry[];
  linksDiscovered: number;
  order: number;
}

/**
 * Discovers same-origin, in-scope links on the page and enqueues the
 * crawlable ones, recording skips (off-site, out-of-scope, non-page,
 * over-depth, page-cap) as diagnostics.
 */
async function enqueueLinks(
  page: Page,
  entry: FrontierEntry,
  rootUrl: string,
  scopeFilter: (url: string) => boolean,
  maxDepth: number,
  maxPages: number,
  bookkeeping: CrawlBookkeeping,
  skip: (url: string, reason: string) => void,
): Promise<void> {
  const { visited, queued, frontier } = bookkeeping;

  const hrefs = await page.$$eval('a[href]', (anchors) =>
    anchors.map((anchor) => (anchor as HTMLAnchorElement).href),
  );

  for (const href of hrefs) {
    const normalized = normalizeUrl(href);
    if (normalized === null) continue;
    bookkeeping.linksDiscovered += 1;

    if (!isSameOrigin(normalized, rootUrl)) {
      skip(normalized, 'off-site (not same-origin)');
      continue;
    }

    if (!scopeFilter(normalized)) {
      skip(normalized, 'out-of-scope');
      continue;
    }

    if (visited.has(normalized) || queued.has(normalized)) continue;

    if (!isCrawlablePage(normalized)) {
      skip(normalized, 'non-page asset link');
      continue;
    }

    const depth = entry.depth + 1;
    if (depth > maxDepth) {
      skip(normalized, `max-depth (${maxDepth})`);
      continue;
    }

    if (visited.size + queued.size >= maxPages) {
      skip(normalized, `page-cap (max ${maxPages} pages)`);
      continue;
    }

    frontier.push({
      url: normalized,
      depth,
      priority: linkPriority(normalized),
      order: bookkeeping.order++,
    });
    queued.add(normalized);
  }
}

/** Extracts a URL's pathname without throwing on malformed input. */
function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

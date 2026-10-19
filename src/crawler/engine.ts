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
import { join, resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import { validateNetworkUrl, type NetworkPolicyOptions } from './network-policy.js';
import type { Browser, Frame, Page } from 'playwright';
import type {
  AssetEntry,
  CrawlRoute,
  CrawlScope,
  EvidenceManifest,
  HashCapture,
  RedirectAliasRecord,
  RouteMetadata,
  TextSpan,
  ViewportMode,
} from '../types.js';
import { captureDOMSnapshot, extractTextSpans } from '../harvester/dom.js';
import { toEvidenceRelativePath } from '../utils/fs-safe.js';
import { discoverImageAssets, mirrorAssets } from './assets.js';
import {
  checkCaptureHealth,
  classifyRedirect,
} from './health.js';
import type { CaptureHealth } from './health.js';
import { discoverInteractiveStates } from './interactions.js';
import { extractVisualAssets } from './visual-assets.js';
import {
  autoScrollWithReset,
  readinessDiagnostic,
  scrollResetDiagnostic,
  waitForPageReadiness,
} from './scroll.js';
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
  networkPolicy?: NetworkPolicyOptions;
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

/**
 * Shared SPA-probe budget per page (hash anchors + interactive states):
 * the added crawl time for one page never exceeds 30 seconds.
 */
const SPA_PROBE_BUDGET_MS = 30_000;

/** Max unique hash-anchor targets captured per page. */
const MAX_HASH_TARGETS = 10;

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
  const requestedRootUrl = await validateNetworkUrl(options.rootUrl, options.networkPolicy);
  const requestedRoot = normalizeUrl(requestedRootUrl.href);
  if (requestedRoot === null) {
    throw new Error(`Invalid root URL: ${options.rootUrl}`);
  }

  const maxDepth = Number.isSafeInteger(options.maxDepth) && (options.maxDepth as number) >= 0
    ? Math.min(options.maxDepth as number, 5)
    : DEFAULT_MAX_DEPTH;
  const maxPages = Number.isSafeInteger(options.maxPages) && (options.maxPages as number) >= 1
    ? Math.min(options.maxPages as number, 50)
    : DEFAULT_MAX_PAGES;
  const viewportMode: ViewportMode = options.viewport ?? 'both';
  const scope: CrawlScope = options.scope ?? 'site';

  const captureDesktop = viewportMode !== 'mobile';
  const captureMobile = viewportMode !== 'desktop';

  const evidenceDir = resolve(options.evidenceDir ?? DEFAULT_EVIDENCE_DIR);
  const evidenceRoot = resolve(process.cwd());
  if (!evidenceDir.startsWith(`${evidenceRoot}${sep}`) && evidenceDir !== evidenceRoot) {
    throw new Error(`Evidence directory must remain inside the current workspace: ${evidenceDir}`);
  }
  const screenshotsDir = join(evidenceDir, 'screenshots');
  const assetsDir = join(evidenceDir, 'assets');
  await mkdir(screenshotsDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });

  const startedAt = Date.now();

  const browser = await launchHeadlessChromium();

  const routes: EvidenceManifest['routes'] = [];
  const assetUrls = new Set<string>();
  /** Tracks which route paths each discovered asset URL was seen on. */
  const assetRouteMap = new Map<string, string[]>();
  /** Screenshot-cropped visual assets (background-image / canvas / banners). */
  const visualAssets: AssetEntry[] = [];
  /** Filesystem names claimed by visual extracts (collision-safe across routes). */
  const usedVisualNames = new Set<string>();
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
    await context.route('**/*', async (route) => {
      const resourceUrl = route.request().url();
      if (/^(data:|blob:|about:)/i.test(resourceUrl)) {
        await route.continue();
        return;
      }
      try {
        await validateNetworkUrl(resourceUrl, options.networkPolicy);
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });
    const page = await context.newPage();

    /** The viewport width the page document was last loaded at. */
    let loadedWidth: number = DESKTOP_VIEWPORT.width;

    /**
     * Capture-state policy: screenshots and DOM measurements must reflect the
     * rendering a visitor at that viewport actually receives. Resizing a
     * document that was loaded at a different width leaves initialization
     * artifacts (media-state scripts, canvases sized at load, inline styles)
     * that measurably distort the capture, so whenever the effective viewport
     * width changes the document is reloaded at the target width and the
     * lazy-load scroll pass plus readiness checks run again before any
     * capture or measurement.
     */
    const ensureCaptureViewport = async (
      size: { width: number; height: number },
    ): Promise<void> => {
      if (loadedWidth === size.width) return;
      await page.setViewportSize({ ...size });
      try {
        await page.reload({ waitUntil: 'networkidle', timeout: NAVIGATION_TIMEOUT_MS });
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        skip(page.url(), `post-reload navigation incomplete (${reason}); capture proceeded`);
      }
      loadedWidth = size.width;
      const scroll = await autoScrollWithReset(page);
      if (scroll.scrollTerminatedBy !== 'bottom') {
        skip(
          page.url(),
          `post-reload auto-scroll terminated by ${scroll.scrollTerminatedBy} after ${scroll.steps} step(s) ` +
            '(probable infinite scroll); capture proceeded within bounds',
        );
      }
      if (!scroll.confirmedTop) {
        skip(page.url(), `post-reload ${scrollResetDiagnostic(scroll)}`);
      }
      const readinessNote = readinessDiagnostic(await waitForPageReadiness(page));
      if (readinessNote !== null) {
        skip(page.url(), readinessNote);
      }
    };

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
        await page.evaluate(() => {
          try { localStorage.clear(); } catch {}
          try { sessionStorage.clear(); } catch {}
        });
        await page.goto(entry.url, {
          waitUntil: 'networkidle',
          timeout: NAVIGATION_TIMEOUT_MS,
        });
        await validateNetworkUrl(page.url(), options.networkPolicy);
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

      // Patch spec s3.1 capture ordering: goto settle -> auto-scroll ->
      // settle delay -> hardened scroll reset -> confirm top, before any
      // snapshot, node count, or screenshot.
      const scroll = await autoScrollWithReset(page);
      if (scroll.scrollTerminatedBy !== 'bottom') {
        skip(
          entry.url,
          `auto-scroll terminated by ${scroll.scrollTerminatedBy} after ${scroll.steps} step(s) ` +
            '(probable infinite scroll); capture proceeded within bounds',
        );
      }
      // Amendment A1 R3: record an unconfirmed reset as a diagnostic.
      if (!scroll.confirmedTop) {
        skip(entry.url, scrollResetDiagnostic(scroll));
      }

      // Post-scroll readiness (fonts, network settle, lazy images) before any
      // capture; incomplete readiness is recorded as a diagnostic.
      const readinessNote = readinessDiagnostic(await waitForPageReadiness(page));
      if (readinessNote !== null) {
        skip(entry.url, readinessNote);
      }

      // Viewport-gated full-page screenshots (patch spec s3.2). Captured at
      // the top of the page; full-page mode records below-the-fold content.
      const slug = slugForPath(path);
      const desktopScreenshot = captureDesktop
        ? join(screenshotsDir, `${slug}-desktop.png`)
        : null;
      const mobileScreenshot = captureMobile
        ? join(screenshotsDir, `${slug}-mobile.png`)
        : null;
      // Per-viewport typography evidence: measured while the mobile layout is
      // active so the corpus carries the mobile type scale and wrapping.
      let mobileTextSpans: TextSpan[] | undefined;

      if (captureDesktop) {
        await ensureCaptureViewport(DESKTOP_VIEWPORT);
        await page.screenshot({ path: desktopScreenshot as string, type: 'png', fullPage: true });
        // Visual bounding-box asset extraction (screenshot-to-code pattern):
        // crop background-image / canvas / svg / unmirrorable <img> surfaces —
        // which have no mirrored <img> source — out of the just-captured
        // full-page PNG. Generic wrapper divs are never cropped for size.
        const desktopVisuals = await extractVisualAssets(
          page,
          desktopScreenshot as string,
          assetsDir,
          usedVisualNames,
        );
        for (const va of desktopVisuals) {
          va.routes = [path];
        }
        visualAssets.push(...desktopVisuals);
      }
      if (captureMobile) {
        await ensureCaptureViewport(MOBILE_VIEWPORT);
        await page.screenshot({ path: mobileScreenshot as string, type: 'png', fullPage: true });
        if (!captureDesktop) {
          // Mobile-only crawl: extract against the mobile screenshot while the
          // mobile layout (and therefore its bounding boxes) is active.
          const mobileVisuals = await extractVisualAssets(
            page,
            mobileScreenshot as string,
            assetsDir,
            usedVisualNames,
          );
          for (const va of mobileVisuals) {
            va.routes = [path];
          }
          visualAssets.push(...mobileVisuals);
        }
        // In dual-viewport crawls, measure the mobile text corpus while the
        // mobile viewport is still active (before the desktop restore below).
        // Mobile-only crawls already measure their primary corpus at mobile.
        if (captureDesktop) {
          mobileTextSpans = await extractTextSpans(page);
        }
      }
      if (captureDesktop) {
        await ensureCaptureViewport(DESKTOP_VIEWPORT);
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

      // DOM snapshot + a11y tree + design tokens + text corpus (shared
      // harvester logic), captured at rest at the top of the page.
      const snapshot = await captureDOMSnapshot(page, path);

      // SEO / OpenGraph metadata extraction.
      const metadata = await extractRouteMetadata(page, title);

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

      // Route record is built as a mutable object so the SPA-aware passes
      // (modals here, hash anchors after link discovery) can attach their
      // captures to the very record stored in the manifest. Screenshot
      // references are recorded bundle-relative (relocatable evidence);
      // the absolute paths remain in scope for filesystem operations above.
      const routeRecord: CrawlRoute = {
        url: entry.url,
        path,
        title,
        desktopScreenshot:
          desktopScreenshot === null
            ? null
            : toEvidenceRelativePath(evidenceDir, desktopScreenshot),
        mobileScreenshot:
          mobileScreenshot === null
            ? null
            : toEvidenceRelativePath(evidenceDir, mobileScreenshot),
        metadata,
        a11yTree: snapshot.a11yTree,
        tokens: snapshot.tokens,
        ...(snapshot.textSpans !== undefined
          ? { textSpans: snapshot.textSpans }
          : {}),
        ...(mobileTextSpans !== undefined
          ? { mobileTextSpans }
          : {}),
      };

      // Shared SPA-probe budget: both passes must fit within 30s per page.
      const spaDeadline = Date.now() + SPA_PROBE_BUDGET_MS;

      // SPA-aware interactive state discovery (modals / overlays): probing
      // happens before the route is stored so modalCaptures ride on the
      // record; per-element failures are swallowed inside the discovery.
      const modalCaptures = await discoverInteractiveStates(
        page,
        routeRecord,
        screenshotsDir,
        spaDeadline,
      );
      if (modalCaptures.length > 0) {
        routeRecord.modalCaptures = modalCaptures.map((capture) => ({
          ...capture,
          desktopScreenshot:
            capture.desktopScreenshot === null
              ? null
              : toEvidenceRelativePath(evidenceDir, capture.desktopScreenshot),
          mobileScreenshot:
            capture.mobileScreenshot === null
              ? null
              : toEvidenceRelativePath(evidenceDir, capture.mobileScreenshot),
        }));
      }

      routes.push(routeRecord);

      // Link discovery (scoped against the canonical root).
      const scopeFilter = createScopeFilter(canonicalRoot, scope);
      await enqueueLinks(page, entry, canonicalRoot, scopeFilter, maxDepth, maxPages, bookkeeping, skip);

      // SPA-aware hash-anchor sub-captures: scroll to each `#target` on the
      // current page and record desktop screenshots as sub-captures of this
      // route (no new route entry is created).
      const hashCaptures = await discoverHashAnchors(
        page,
        entry,
        screenshotsDir,
        spaDeadline,
      );
      if (hashCaptures.length > 0) {
        routeRecord.hashCaptures = hashCaptures.map((capture) => ({
          ...capture,
          screenshot: toEvidenceRelativePath(evidenceDir, capture.screenshot),
        }));
      }

      // Asset discovery.
      for (const assetUrl of await discoverImageAssets(page)) {
        assetUrls.add(assetUrl);
        const existing = assetRouteMap.get(assetUrl);
        if (existing !== undefined) {
          if (!existing.includes(path)) existing.push(path);
        } else {
          assetRouteMap.set(assetUrl, [path]);
        }
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
    { ...options.networkPolicy, maxTotalBytes: 50 * 1024 * 1024 },
  );
  diagnostics.uncapturedResources.push(...uncaptured);

  // Merge per-route provenance into mirrored asset entries.
  for (const asset of assets) {
    const routes = assetRouteMap.get(asset.originalUrl);
    if (routes !== undefined && routes.length > 0) {
      asset.routes = routes;
    }
  }

  // Visual extracts join the mirrored assets in the manifest so the
  // synthesizer prompt lists them under available local assets (and
  // copyMirroredAssets mirrors them into public/assets/).
  const allAssets = [...assets, ...visualAssets];

  const manifest: EvidenceManifest = {
    targetUrl: canonicalRoot,
    crawledAt: new Date().toISOString(),
    stats: {
      pagesCrawled: routes.length,
      linksDiscovered: bookkeeping.linksDiscovered,
      assetsDownloaded: allAssets.filter((asset) => asset.status === 'downloaded').length,
      assetsFailed: allAssets.filter((asset) => asset.status === 'failed').length,
      externalAssets: allAssets.filter((asset) => asset.status === 'external').length,
      durationMs: Date.now() - startedAt,
    },
    routes,
    assets: allAssets,
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

// ---------------------------------------------------------------------------
// Hash-anchor sub-captures (SPA-aware)
// ---------------------------------------------------------------------------

/**
 * In-page collector listing unique in-page hash targets (`a[href^="#"]`).
 * Bare `#` anchors (no target id) are skipped.
 */
function collectHashTargets(): string[] {
  const hashes: string[] = [];
  for (const anchor of Array.from(document.querySelectorAll('a[href^="#"]'))) {
    const href = anchor.getAttribute('href');
    if (href === null || href.length < 2) continue;
    if (!hashes.includes(href)) hashes.push(href);
  }
  return hashes;
}

/** Sanitizes a hash (e.g. `#pricing-faq`) for use inside a filename. */
function hashNameForFile(hash: string): string {
  const name = hash
    .replace(/^#/, '')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return name.length > 0 ? name : 'target';
}

/**
 * SPA-aware hash-anchor discovery: for every unique `a[href^="#"]` target
 * on the current page, scrolls the element into view, waits for
 * scroll-triggered animations, and records a desktop screenshot as a
 * sub-capture of the current route. No new route entry is created — the
 * caller attaches the returned captures to the existing route record.
 *
 * `deadlineAt` bounds the total added time (shared with the interactive
 * state pass). Any per-target failure is caught and skipped silently.
 */
async function discoverHashAnchors(
  page: Page,
  entry: FrontierEntry,
  screenshotsDir: string,
  deadlineAt?: number,
): Promise<HashCapture[]> {
  const captures: HashCapture[] = [];
  const slug = slugForPath(safePathname(entry.url));

  let hashes: string[] = [];
  try {
    hashes = await page.evaluate(collectHashTargets);
  } catch {
    return captures;
  }

  await page.setViewportSize({ ...DESKTOP_VIEWPORT });

  for (const hash of hashes.slice(0, MAX_HASH_TARGETS)) {
    if (deadlineAt !== undefined && Date.now() > deadlineAt) break;
    try {
      const scrolled = await page.evaluate((target: string) => {
        const el = document.querySelector(target);
        if (el === null) return false;
        el.scrollIntoView();
        return true;
      }, hash);
      if (!scrolled) continue;

      // Wait for scroll-triggered animations to settle.
      await page.waitForTimeout(600);

      const screenshot = join(
        screenshotsDir,
        `${slug}-hash-${hashNameForFile(hash)}-desktop.png`,
      );
      await page.screenshot({ path: screenshot, type: 'png' });
      captures.push({ hash, screenshot });
    } catch {
      // Malformed selector / detached frame — skip this target silently.
      continue;
    }
  }

  // Return the page to its resting (top) state for subsequent passes.
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
  } catch {
    // Page already navigated away — nothing to reset.
  }

  return captures;
}

/** Extracts a URL's pathname without throwing on malformed input. */
function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

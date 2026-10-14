/**
 * apograph — URL normalization & link prioritization (Layer 1b: Crawl).
 *
 * Pure deterministic helpers used by the headless crawler: canonical URL
 * normalization (tracking-parameter stripping, fragment removal, trailing
 * slash collapsing), same-origin checks, page-asset filtering, crawl
 * scoping, and navigation-link prioritization.
 */

import type { CrawlScope } from '../types.js';

/** Query parameters treated as tracking noise. `utm_*` is matched by prefix. */
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'ref']);

/** Path segments that mark high-value navigation pages. */
const PRIORITY_SEGMENTS = new Set(['about', 'pricing', 'features', 'contact', 'faq']);

/** File extensions of links that are never crawlable HTML pages. */
const NON_PAGE_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico',
  '.css', '.js', '.mjs', '.json', '.xml', '.txt', '.pdf', '.zip',
  '.gz', '.tgz', '.mp4', '.webm', '.mp3', '.wav', '.woff', '.woff2',
  '.ttf', '.otf', '.eot', '.dmg', '.exe',
] as const;

/** True when a query-parameter name is tracking noise (`utm_*`, fbclid, gclid, ref). */
function isTrackingParam(name: string): boolean {
  return name.startsWith('utm_') || TRACKING_PARAMS.has(name);
}

/**
 * Normalizes a raw URL into its canonical crawl form:
 * - resolves against `base` when relative;
 * - only `http:` / `https:` schemes survive;
 * - strips the `#fragment`;
 * - removes tracking parameters (`utm_*`, `fbclid`, `gclid`, `ref`);
 * - collapses trailing slashes (`/about/` -> `/about`; root `/` stays).
 *
 * Returns null when the input cannot be normalized into an http(s) URL.
 */
export function normalizeUrl(raw: string, base?: string): string | null {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hash = '';

  for (const key of [...url.searchParams.keys()]) {
    if (isTrackingParam(key)) url.searchParams.delete(key);
  }

  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }

  return url.href;
}

/** True when both URLs share the same origin (scheme + host + port). */
export function isSameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** True when a URL's path looks like a crawlable HTML page (not a raw asset). */
export function isCrawlablePage(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    return !NON_PAGE_EXTENSIONS.some((ext) => pathname.toLowerCase().endsWith(ext));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Crawl scoping
// ---------------------------------------------------------------------------

/**
 * True when the URL targets a subpath rather than a site root — e.g.
 * `domain.com/frequently-asked-questions` (any non-empty pathname).
 */
export function urlHasSubpath(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, '').length > 0;
  } catch {
    return false;
  }
}

/**
 * Builds the same-origin scope filter for a crawl:
 * - `single`: only the root URL itself (page cap 1);
 * - `subtree`: pages under the root's path prefix (`/faq`, `/faq/...`);
 * - `site`: every same-origin page.
 */
export function createScopeFilter(
  rootUrl: string,
  scope: CrawlScope,
): (url: string) => boolean {
  let root: URL;
  try {
    root = new URL(rootUrl);
  } catch {
    return () => false;
  }

  const rootPath = root.pathname.replace(/\/+$/, '');

  if (scope === 'single') {
    return (url) => url === rootUrl;
  }

  if (scope === 'subtree') {
    return (url) => {
      try {
        const candidate = new URL(url);
        return (
          candidate.origin === root.origin &&
          (candidate.pathname === rootPath ||
            candidate.pathname.startsWith(`${rootPath}/`))
        );
      } catch {
        return false;
      }
    };
  }

  return (url) => isSameOrigin(url, rootUrl);
}

/**
 * Scores a URL path by navigation value. Paths containing priority segments
 * (`/about`, `/pricing`, `/features`, `/contact`, `/faq`) score higher so the
 * crawler visits them before generic deep links when the page cap binds.
 */
export function linkPriority(url: string): number {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    let score = 0;
    for (const segment of segments) {
      if (PRIORITY_SEGMENTS.has(segment.toLowerCase())) score += 10;
    }
    return score;
  } catch {
    return 0;
  }
}

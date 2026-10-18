/**
 * apograph — Network capture collector (Layer 1: Capture).
 *
 * Hooks into a Playwright page and records HTTP exchanges into the canonical
 * `RecordedRequest` shape, filtering out static assets and analytics telemetry
 * so downstream contract inference only sees meaningful API traffic.
 */

import type { Page, Response } from 'playwright';
import type { RecordedRequest } from '../types.js';

/** File extensions to skip: static assets with no contract value. */
const STATIC_ASSET_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.webp',
  '.woff',
  '.woff2',
  '.ttf',
  '.css',
] as const;

/** Substrings of hostnames to skip: known analytics/telemetry vendors. */
const TELEMETRY_DOMAIN_FRAGMENTS = [
  'google-analytics.com',
  'segment.io',
  'sentry.io',
  'telemetry',
  'datadog',
] as const;

const MAX_CAPTURED_REQUESTS = 500;
const MAX_CAPTURED_BODY_BYTES = 512 * 1024;
const MAX_CAPTURED_TOTAL_BYTES = 10 * 1024 * 1024;

export class NetworkCollector {
  private readonly requests: RecordedRequest[] = [];
  private capturedBytes = 0;
  private listener: ((response: Response) => void) | null = null;

  /**
   * Hooks `page.on('response')` and begins eagerly recording HTTP exchanges.
   * Safe to call only once per page; a second attach replaces nothing and is
   * ignored while a listener is active.
   */
  attach(page: Page): void {
    if (this.listener) return;

    const listener = (response: Response): void => {
      const request = response.request();
      const url = response.url();

      if (isStaticAsset(url) || isTelemetry(url)) return;
       if (this.requests.length >= MAX_CAPTURED_REQUESTS || this.capturedBytes >= MAX_CAPTURED_TOTAL_BYTES) return;

      const timestamp = Date.now();
      const method = request.method();

      // Request side: read headers and body eagerly while the exchange is live.
      const headers = request.headers();
      const requestBody = request.postData();

      // Response side: status/headers are sync; body may throw (e.g. redirects,
      // navigation-invalidated buffers), so read defensively.
      const status = response.status();
      const responseHeaders = response.headers();

      void (async () => {
        const responseBody = await response.text().then((body) => {
          if (body.length > MAX_CAPTURED_BODY_BYTES) return null;
          const bytes = Buffer.byteLength(body, 'utf8');
          if (this.capturedBytes + bytes > MAX_CAPTURED_TOTAL_BYTES) return null;
          this.capturedBytes += bytes;
          return body;
        }).catch(() => null);

        this.requests.push({
          method,
          url,
          routePattern: '',
          headers: { ...headers, ...prefixResponseHeaders(responseHeaders) },
          requestBody: requestBody ?? null,
          responseBody,
          status,
          timestamp,
        });
      })();
    };

    this.listener = listener;
    page.on('response', listener);
  }

  /** Returns the requests captured so far. */
  getRequests(): RecordedRequest[] {
    return this.requests;
  }

  /** Empties the in-memory capture buffer. */
  clear(): void {
    this.requests.length = 0;
    this.capturedBytes = 0;
  }

  /**
   * Removes the response listener from the page and returns the final
   * recorded array. Safe to call even if never attached.
   */
  stop(page: Page): RecordedRequest[] {
    if (this.listener) {
      page.removeListener('response', this.listener);
      this.listener = null;
    }
    return this.requests;
  }
}

/** True when the URL's path ends in a static asset extension. */
function isStaticAsset(url: string): boolean {
  const path = safeUrlPath(url);
  return STATIC_ASSET_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** True when the URL's host matches a known telemetry vendor. */
function isTelemetry(url: string): boolean {
  const host = safeUrlHost(url);
  return TELEMETRY_DOMAIN_FRAGMENTS.some((fragment) => host.includes(fragment));
}

/** Extracts the pathname without throwing on malformed URLs. */
function safeUrlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Extracts the lowercase hostname without throwing on malformed URLs. */
function safeUrlHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Prefixes response header names so they can be merged into the same record
 * without clobbering the request headers.
 */
function prefixResponseHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const prefixed: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    prefixed[`x-response-${name}`] = value;
  }
  return prefixed;
}

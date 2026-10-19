/**
 * apograph — Asset mirroring pipeline (Layer 1b: Crawl).
 *
 * Discovers image assets referenced by a live page (`<img>`, `srcset`, SVG
 * `<image>`, CSS `background-image`), then mirrors same-origin assets into
 * `.apograph/evidence/assets/` under hashed local filenames, recording every
 * asset (downloaded / failed / external) in the manifest's asset list.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { AssetEntry, UncapturedResource } from '../types.js';
import { validateNetworkUrl, type NetworkPolicyOptions } from './network-policy.js';

/** Download timeout per asset. */
const DOWNLOAD_TIMEOUT_MS = 20_000;

/** Bounded download attempts per asset (1 initial + retries on transients). */
const DOWNLOAD_ATTEMPTS = 3;

/** Backoff schedule (base + jitter) between transient asset download retries. */
const DOWNLOAD_BACKOFF: ReadonlyArray<{ baseMs: number; jitterMs: number }> = [
  { baseMs: 1_000, jitterMs: 500 },
  { baseMs: 3_000, jitterMs: 1_000 },
];

/** HTTP statuses worth retrying (bounded): throttling and server-side faults. */
const RETRYABLE_ASSET_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Markers of transient network dropouts (node/undici error codes and messages). */
const TRANSIENT_NETWORK_RE =
  /(fetch failed|socket hang up|econnreset|econnrefused|etimedout|epipe|eai_again|ehostunreach|enetunreach|und_err|timeout|abort)/i;

/**
 * True when a failed asset download is transient (network dropout, timeout,
 * throttling, or server fault) and a bounded retry can plausibly succeed.
 * Deterministic policy failures (404, blocked content type, size limits) are
 * never retried.
 */
export function isTransientAssetError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number') return RETRYABLE_ASSET_STATUS.has(status);
  const cause = (error as { cause?: unknown }).cause;
  for (const node of [error, cause]) {
    if (!(node instanceof Error)) continue;
    const code = (node as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSIENT_NETWORK_RE.test(code)) return true;
    if (TRANSIENT_NETWORK_RE.test(node.name)) return true;
    if (TRANSIENT_NETWORK_RE.test(node.message)) return true;
  }
  return false;
}

/** Fallback file extensions derived from MIME types. */
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

/**
 * In-page collector: gathers every image URL referenced by the DOM —
 * `<img src>` / `data-src`, `srcset` candidates, SVG `<image>` hrefs,
 * computed `background-image` values, and `<style>` block `url(...)`s.
 */
function collectImageUrlsInPage(): string[] {
  const MAX_BACKGROUND_SCAN_ELEMENTS = 2_000;
  const urls = new Set<string>();
  const push = (value: string | null | undefined): void => {
    if (value && value.length > 0) urls.add(value);
  };

  for (const img of Array.from(document.querySelectorAll('img'))) {
    push(img.getAttribute('src'));
    push(img.getAttribute('data-src'));
  }

  for (const el of Array.from(document.querySelectorAll('img[srcset], source[srcset]'))) {
    const srcset = el.getAttribute('srcset') ?? '';
    for (const candidate of srcset.split(',')) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url) push(url);
    }
  }

  for (const image of Array.from(document.querySelectorAll('image'))) {
    push(image.getAttribute('href'));
    push(image.getAttribute('xlink:href'));
  }

  const elements = Array.from(document.querySelectorAll('*')).slice(
    0,
    MAX_BACKGROUND_SCAN_ELEMENTS,
  );
  for (const el of elements) {
    const background = getComputedStyle(el).backgroundImage;
    if (!background || background === 'none') continue;
    for (const match of background.matchAll(/url\((['"]?)(.*?)\1\)/g)) {
      push(match[2]);
    }
  }

  for (const style of Array.from(document.querySelectorAll('style'))) {
    const text = style.textContent ?? '';
    for (const match of text.matchAll(/url\((['"]?)(.*?)\1\)/g)) {
      push(match[2]);
    }
  }

  return [...urls];
}

/**
 * Discovers image asset URLs on the current page, resolved to absolute URLs.
 * `data:` URIs and unresolvable values are dropped.
 */
export async function discoverImageAssets(page: Page): Promise<string[]> {
  const raw = await page.evaluate(collectImageUrlsInPage);
  const pageUrl = page.url();

  const resolved: string[] = [];
  for (const candidate of raw) {
    if (candidate.startsWith('data:')) continue;
    try {
      resolved.push(new URL(candidate, pageUrl).href);
    } catch {
      // Malformed URL — ignore.
    }
  }
  return resolved;
}

/** Builds a hashed, collision-safe local filename for an asset URL. */
function assetFilename(url: URL, mimeType: string): string {
  const hash = createHash('sha256').update(url.href).digest('hex').slice(0, 12);

  const pathMatch = url.pathname.match(/\.([a-zA-Z0-9]{1,5})$/);
  const pathExtension = pathMatch?.[1]?.toLowerCase();
  const extension =
    pathExtension && pathExtension.length > 0 ? pathExtension : (MIME_EXTENSIONS[mimeType] ?? 'bin');

  return `${hash}.${extension}`;
}

/** Result of mirroring the discovered asset set. */
export interface MirrorResult {
  entries: AssetEntry[];
  uncaptured: UncapturedResource[];
}

export interface MirrorOptions extends NetworkPolicyOptions {
  fetchImpl?: typeof fetch;
  maxAssets?: number;
  maxBytes?: number;
  maxTotalBytes?: number;
  /** Sleep primitive for retry backoff waits (tests inject fakes). */
  sleepImpl?: (ms: number) => Promise<void>;
}

/** One successful asset download (post-redirect), ready to mirror to disk. */
interface DownloadedAsset {
  url: URL;
  mimeType: string;
  buffer: Buffer;
}

/** Builds an Error carrying an HTTP status so retries can classify it. */
function httpStatusError(status: number, statusText: string): Error {
  return Object.assign(new Error(`HTTP ${status} ${statusText}`.trim()), { status });
}

/**
 * Runs one download attempt for a single asset: follows at most one
 * policy-validated redirect, then enforces the image MIME and per-asset size
 * budgets. Throws on any failure; transient classification happens in
 * {@link downloadWithRetry}.
 */
async function downloadAssetOnce(
  startUrl: URL,
  fetchImpl: typeof fetch,
  options: NetworkPolicyOptions,
  maxBytes: number,
): Promise<DownloadedAsset> {
  let url = startUrl;
  let response = await fetchImpl(url.href, {
    redirect: 'manual',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (location === null) throw new Error('redirect response missing Location');
    // Redirect targets (e.g. CDN -> object storage) are allowed for any
    // origin as long as they pass the same SSRF/network policy.
    const redirectUrl = await validateNetworkUrl(new URL(location, url).href, options);
    response = await fetchImpl(redirectUrl.href, {
      redirect: 'error',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    url = redirectUrl;
  }

  if (!response.ok) {
    throw httpStatusError(response.status, response.statusText);
  }

  const mimeType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  if (!mimeType.startsWith('image/')) throw new Error(`unexpected content type: ${mimeType || 'missing'}`);
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (declaredLength > maxBytes) throw new Error(`asset exceeds ${maxBytes} byte limit`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) throw new Error(`asset exceeds ${maxBytes} byte limit`);

  return { url, mimeType, buffer };
}

/**
 * Downloads one asset with a bounded transient retry policy: network
 * dropouts, timeouts, throttling, and server faults are retried with
 * exponential backoff + jitter; deterministic failures raise immediately.
 */
async function downloadWithRetry(
  startUrl: URL,
  fetchImpl: typeof fetch,
  options: NetworkPolicyOptions,
  maxBytes: number,
  sleepImpl: (ms: number) => Promise<void>,
): Promise<DownloadedAsset> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await downloadAssetOnce(startUrl, fetchImpl, options, maxBytes);
    } catch (cause) {
      if (attempt >= DOWNLOAD_ATTEMPTS || !isTransientAssetError(cause)) throw cause;
      const schedule = DOWNLOAD_BACKOFF[Math.min(attempt - 1, DOWNLOAD_BACKOFF.length - 1)];
      if (schedule === undefined) throw cause;
      await sleepImpl(schedule.baseMs + Math.floor(Math.random() * schedule.jitterMs));
    }
  }
}

/**
 * Mirrors discovered image assets into `assetsDir` and records every
 * discovered asset. Same-origin and cross-origin images are both mirrored:
 * content imagery is frequently served from a CDN origin, and a clone cannot
 * reproduce what it never downloads. Every request — including redirect
 * targets — passes the SSRF/network policy and the image MIME/size budgets.
 * Assets that cannot be mirrored are recorded with status `failed`.
 */
export async function mirrorAssets(
  urls: string[],
  rootOrigin: string,
  assetsDir: string,
  options: MirrorOptions = {},
): Promise<MirrorResult> {
  await mkdir(assetsDir, { recursive: true });

  const entries: AssetEntry[] = [];
  const uncaptured: UncapturedResource[] = [];
  const seen = new Set<string>();
  const maxAssets = options.maxAssets ?? 500;
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 50 * 1024 * 1024;
  let totalBytes = 0;
  const fetchImpl = options.fetchImpl ?? fetch;

  for (const raw of urls) {
    if (seen.size >= maxAssets) break;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (seen.has(url.href)) continue;
    try {
      await validateNetworkUrl(url.href, options);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      entries.push({ originalUrl: url.href, localPath: null, status: 'failed' });
      uncaptured.push({ url: url.href, reason: `blocked by network policy: ${reason}` });
      continue;
    }
    seen.add(url.href);

    const provenance = url.origin === rootOrigin ? 'same-origin' : `cross-origin (${url.origin})`;

    try {
      const sleepImpl = options.sleepImpl ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
      const downloaded = await downloadWithRetry(url, fetchImpl, options, maxBytes, sleepImpl);
      url = downloaded.url;
      if (totalBytes + downloaded.buffer.byteLength > maxTotalBytes) {
        throw new Error(`asset budget exceeds ${maxTotalBytes} byte limit`);
      }
      totalBytes += downloaded.buffer.byteLength;
      const localPath = join(assetsDir, assetFilename(url, downloaded.mimeType));

      await writeFile(localPath, downloaded.buffer);
      entries.push({ originalUrl: url.href, localPath, status: 'downloaded', mimeType: downloaded.mimeType });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      entries.push({ originalUrl: url.href, localPath: null, status: 'failed' });
      uncaptured.push({ url: url.href, reason: `${provenance}: ${reason}` });
    }
  }

  return { entries, uncaptured };
}

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
}

/**
 * Mirrors same-origin assets into `assetsDir` and records every discovered
 * asset. Cross-origin assets are recorded with status `external` and are not
 * downloaded; failed downloads are recorded with status `failed`.
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

    if (url.origin !== rootOrigin) {
      entries.push({ originalUrl: url.href, localPath: null, status: 'external' });
      uncaptured.push({ url: url.href, reason: 'external-origin (not mirrored)' });
      continue;
    }

    try {
      let response = await fetchImpl(url.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location === null) throw new Error('redirect response missing Location');
        const redirectUrl = await validateNetworkUrl(new URL(location, url).href, options);
        if (redirectUrl.origin !== url.origin) throw new Error('cross-origin asset redirect blocked');
        const redirected = await fetchImpl(redirectUrl.href, {
          redirect: 'error',
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
        response = redirected;
        url = redirectUrl;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      }

      const mimeType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
      if (!mimeType.startsWith('image/')) throw new Error(`unexpected content type: ${mimeType || 'missing'}`);
      const declaredLength = Number(response.headers.get('content-length') ?? '0');
      if (declaredLength > maxBytes) throw new Error(`asset exceeds ${maxBytes} byte limit`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) throw new Error(`asset exceeds ${maxBytes} byte limit`);
      if (totalBytes + buffer.byteLength > maxTotalBytes) throw new Error(`asset budget exceeds ${maxTotalBytes} byte limit`);
      totalBytes += buffer.byteLength;
      const localPath = join(assetsDir, assetFilename(url, mimeType));

      await writeFile(localPath, buffer);
      entries.push({ originalUrl: url.href, localPath, status: 'downloaded', mimeType });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      entries.push({ originalUrl: url.href, localPath: null, status: 'failed' });
      uncaptured.push({ url: url.href, reason });
    }
  }

  return { entries, uncaptured };
}

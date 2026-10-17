/**
 * apograph — Visual bounding-box asset extraction (screenshot-to-code pattern).
 *
 * Hero backgrounds, maps, and diagrams are frequently rendered via CSS
 * `background-image`, `<canvas>`, or `<svg>` — surfaces the DOM asset mirror
 * misses — so the vision model falls back to flat CSS gradient placeholders.
 * This pass targets ONLY actual visual surfaces:
 *
 *   a) elements whose computed `background-image` carries a `url(...)`
 *      layer (gradients — linear-gradient / radial-gradient — are excluded);
 *   b) `<canvas>` elements (maps, WebGL);
 *   c) `<svg>` elements at least 48x48 (complex diagrams / illustrations);
 *   d) loaded `<img>` elements the DOM scraper cannot mirror (blob:/data:).
 *
 * Generic wrapper divs (`div.relative`, `div.container`, `div.mx-auto`,
 * `section`) are NEVER cropped for size alone. Crops land in the evidence
 * asset directory under semantic names (`map-canvas.png`,
 * `network-diagram.png`, `hero-bg.png`); CSS layout utility classes never
 * become asset names. The synthesizer's `copyMirroredAssets` mirrors them
 * into `public/assets/`, and the manifest registration lists them as
 * available local assets.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { Page } from 'playwright';
import type { AssetEntry, VisualAssetKind, VisualAssetRegion } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Smallest significant region (either dimension) in CSS pixels. */
export const VISUAL_ASSET_MIN_SIZE = 80;

/** Minimum size for `<svg>` diagrams (icons below this are UI chrome). */
export const SVG_MIN_SIZE = 48;

/** Max visual assets extracted per screenshot (token / noise bound). */
export const MAX_VISUAL_ASSETS = 12;

// ---------------------------------------------------------------------------
// In-page region collection
// ---------------------------------------------------------------------------

/**
 * In-page collector: finds actual visual surfaces (a-d in the module docs)
 * lacking mirrored `<img>` sources and returns their page-space bounding
 * boxes with semantic name sources. Generic wrappers are never selected for
 * size alone.
 *
 * Serialized into the page by `page.evaluate`: must stay self-contained
 * (no module-scope references).
 */
export function collectVisualAssetRegionsInPage(): VisualAssetRegion[] {
  const MIN_SIZE = 80;
  const SVG_MIN_SIZE = 48;
  const HERO_TOP = 600;
  const MAX_ELEMENTS = 3_000;
  const MAX_REGIONS = 12;

  interface Candidate {
    rect: DOMRect;
    region: VisualAssetRegion;
  }

  const body = document.body;
  if (body === null) return [];

  const area = (rect: DOMRect): number => rect.width * rect.height;

  const intersectionArea = (a: DOMRect, b: DOMRect): number => {
    const x0 = Math.max(a.left, b.left);
    const y0 = Math.max(a.top, b.top);
    const x1 = Math.min(a.right, b.right);
    const y1 = Math.min(a.bottom, b.bottom);
    return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  };

  const classTokensOf = (el: Element): string[] => {
    const className = el.getAttribute('class');
    return className !== null
      ? className.split(/\s+/).filter((token) => token.length > 0)
      : [];
  };

  const candidates: Candidate[] = [];
  const elements = Array.from(document.querySelectorAll('*')).slice(0, MAX_ELEMENTS);

  for (const el of elements) {
    const tag = el.tagName.toLowerCase();
    if (
      tag === 'script' ||
      tag === 'style' ||
      tag === 'picture' ||
      tag === 'video' ||
      tag === 'head'
    ) {
      continue;
    }

    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (Number.parseFloat(style.opacity || '1') < 0.1) continue;

    const rect = el.getBoundingClientRect();

    // a) CSS background-image with a real url() layer. Gradients
    // (linear-gradient / radial-gradient) carry no url() and never qualify;
    // generic wrappers are not selected for size alone.
    const backgroundImage = style.backgroundImage;
    const hasBackgroundUrl =
      typeof backgroundImage === 'string' && /url\(/i.test(backgroundImage);

    let kind: VisualAssetKind | null = null;
    if (tag === 'canvas') {
      if (rect.width >= MIN_SIZE && rect.height >= MIN_SIZE) kind = 'canvas';
    } else if (tag === 'svg') {
      if (rect.width >= SVG_MIN_SIZE && rect.height >= SVG_MIN_SIZE) kind = 'svg';
    } else if (tag === 'img') {
      // d) Loaded images the DOM scraper cannot mirror (blob:/data: URLs).
      const img = el as HTMLImageElement;
      const src = img.getAttribute('src') ?? '';
      if (
        img.naturalWidth > 0 &&
        (src.startsWith('blob:') || src.startsWith('data:'))
      ) {
        kind = 'image';
      }
    } else if (hasBackgroundUrl) {
      if (rect.width >= MIN_SIZE && rect.height >= MIN_SIZE) kind = 'background-image';
    }
    if (kind === null) continue;

    // Regions mostly covered by a mirrored <img> source are already captured
    // by the DOM asset scraper — skip them (never applies to the images
    // themselves).
    if (kind !== 'image') {
      let imgArea = 0;
      for (const img of Array.from(el.querySelectorAll('img'))) {
        const imgRect = img.getBoundingClientRect();
        imgArea += imgRect.width * imgRect.height;
      }
      if (imgArea >= area(rect) * 0.5) continue;
    }

    candidates.push({
      rect,
      region: {
        kind,
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height,
        tag,
        id: el.getAttribute('id'),
        ariaLabel: el.getAttribute('aria-label'),
        alt: tag === 'img' ? el.getAttribute('alt') : null,
        classTokens: classTokensOf(el),
        inHero:
          el.closest('#hero') !== null || rect.top + window.scrollY < HERO_TOP,
      },
    });
  }

  // Prefer the innermost specific surface: largest first, a candidate nested
  // inside a kept region is dropped — unless it covers >=50% of that region,
  // in which case the kept entry was a mere wrapper and yields to it.
  candidates.sort((a, b) => area(b.rect) - area(a.rect));
  const selected: Candidate[] = [];

  for (const candidate of candidates) {
    const candidateArea = area(candidate.rect);
    let handled = false;

    for (const kept of [...selected]) {
      const inside = intersectionArea(candidate.rect, kept.rect);
      if (inside < candidateArea * 0.9) continue;

      if (inside >= area(kept.rect) * 0.5) {
        selected.splice(selected.indexOf(kept), 1);
        selected.push(candidate);
      }
      // Either way the candidate is spatially accounted for.
      handled = true;
      break;
    }

    if (!handled) selected.push(candidate);
    if (selected.length >= MAX_REGIONS) break;
  }

  return selected.map((candidate) => candidate.region);
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Exact CSS layout utility tokens that must never become asset names. */
const LAYOUT_UTILITY_TOKENS = new Set([
  'relative',
  'absolute',
  'fixed',
  'sticky',
  'container',
  'flex',
  'grid',
  'block',
  'inline',
  'hidden',
  'contents',
  'isolate',
  'truncate',
  'overflow-hidden',
  'mx-auto',
  'w-full',
  'h-full',
  'space-y',
  'space-x',
]);

/** Tailwind-style layout utility prefixes that must never become asset names. */
const LAYOUT_UTILITY_PREFIX =
  /^(m[xytblr]?|p[xytblr]?|w|h|max-w|max-h|min-w|min-h|gap|space-[xy]|top|left|right|bottom|inset|z|order|flex|grid|items|justify|self|place|col|row|basis|grow|shrink|text|bg|border|rounded|font|leading|tracking|shadow|opacity|transition|duration|ease|ring|outline|fill|stroke|divide|sr|pointer|select|align|whitespace|break|overflow|aspect|object|cursor|resize|appearance)(-|$)/;

/**
 * True when a name is a generic CSS layout utility class (`relative`,
 * `container`, `mx-auto`, `w-full`, `space-y-6`, ...). Such names confuse the
 * vision model and must never become asset names.
 */
export function isLayoutUtilityName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (normalized.length === 0) return true;
  if (LAYOUT_UTILITY_TOKENS.has(normalized)) return true;
  if (LAYOUT_UTILITY_PREFIX.test(normalized)) return true;
  const leading = normalized.split('-')[0] ?? normalized;
  return LAYOUT_UTILITY_TOKENS.has(leading);
}

/** Sanitizes a name source into a filesystem-safe asset base name. */
export function sanitizeAssetBaseName(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base.length > 0 ? base : 'asset';
}

/**
 * Suggests the file base name for a region (e.g. `map-canvas`,
 * `network-diagram`, `hero-bg`, `section-graphic-3`):
 *
 * 1. semantic sources win — element id, aria-label, image alt, or a semantic
 *    class token (`map` + canvas -> `map-canvas`, `network` + svg ->
 *    `network-diagram`);
 * 2. `background-image` regions inside `#hero` or in the top 600px are named
 *    `hero-bg`;
 * 3. CSS layout utility names are NEVER used — they fall back to
 *    `section-graphic-${index}` (or the bare semantic tag for canvas/svg).
 */
export function suggestRegionName(region: VisualAssetRegion, index: number): string {
  const fallback = `section-graphic-${index}`;

  const named = (value: string | null): string | null => {
    if (value === null) return null;
    const base = sanitizeAssetBaseName(value);
    return isLayoutUtilityName(base) ? null : base;
  };

  const semanticClass = region.classTokens.find((token) => !isLayoutUtilityName(token));
  const base =
    named(region.id) ??
    named(region.ariaLabel) ??
    named(region.alt) ??
    (semanticClass !== undefined ? sanitizeAssetBaseName(semanticClass) : null);

  if (region.kind === 'background-image') {
    if (region.inHero) return 'hero-bg';
    if (base === null) return fallback;
    return base.includes('bg') ? base : `${base}-bg`;
  }

  if (region.kind === 'canvas') {
    if (base === null) return 'canvas';
    return base.includes('canvas') ? base : `${base}-canvas`;
  }

  if (region.kind === 'svg') {
    if (base === null) return 'diagram';
    return base.includes('diagram') || base.includes('svg') ? base : `${base}-diagram`;
  }

  // kind === 'image'
  return base !== null ? base : fallback;
}

/** Claims a collision-free name (`hero-bg`, `hero-bg-2`, ...) in `used`. */
function uniqueAssetName(base: string, used: Set<string>): string {
  let name = base;
  let counter = 2;
  while (used.has(name)) {
    name = `${base}-${counter}`;
    counter += 1;
  }
  used.add(name);
  return name;
}

// ---------------------------------------------------------------------------
// pngjs cropping
// ---------------------------------------------------------------------------

/** A pixel region to crop out of a PNG buffer. */
export interface CropRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Crops a bounding-box region out of a PNG buffer with pngjs, clamping the
 * region to the image bounds. Returns null when the region does not overlap
 * the image at all.
 */
export function cropPngToRegion(pngBuffer: Buffer, region: CropRegion): Buffer | null {
  const png = PNG.sync.read(pngBuffer);

  const x0 = Math.max(0, Math.min(png.width, Math.floor(region.x)));
  const y0 = Math.max(0, Math.min(png.height, Math.floor(region.y)));
  const x1 = Math.max(0, Math.min(png.width, Math.ceil(region.x + region.width)));
  const y1 = Math.max(0, Math.min(png.height, Math.ceil(region.y + region.height)));

  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) return null;

  const cropped = new PNG({ width, height });
  for (let row = 0; row < height; row += 1) {
    const sourceStart = ((y0 + row) * png.width + x0) * 4;
    png.data.copy(cropped.data, row * width * 4, sourceStart, sourceStart + width * 4);
  }
  return PNG.sync.write(cropped);
}

// ---------------------------------------------------------------------------
// Extraction driver
// ---------------------------------------------------------------------------

/** Options for {@link extractVisualAssets}. */
export interface ExtractVisualAssetsOptions {
  /** Max regions extracted from one screenshot. Defaults to MAX_VISUAL_ASSETS. */
  maxAssets?: number;
}

/**
 * Visual asset extraction pass: collects visual-surface bounding boxes from
 * the live page, crops them out of the given full-page screenshot, and writes
 * each crop into `assetsDir` under its suggested semantic name
 * (`hero-bg.png`, `map-canvas.png`, ...). Names are collision-safe across
 * routes via `usedNames`. Returns manifest-ready asset entries for the
 * evidence bundle.
 */
export async function extractVisualAssets(
  page: Page,
  screenshotPath: string,
  assetsDir: string,
  usedNames?: Set<string>,
  options: ExtractVisualAssetsOptions = {},
): Promise<AssetEntry[]> {
  let regions: VisualAssetRegion[];
  try {
    regions = await page.evaluate(collectVisualAssetRegionsInPage);
  } catch {
    return []; // Detached frame / navigation raced the pass — skip silently.
  }
  if (regions.length === 0) return [];

  const screenshot = await readFile(screenshotPath);
  const claimed = usedNames ?? new Set<string>();
  const maxAssets = options.maxAssets ?? MAX_VISUAL_ASSETS;

  await mkdir(assetsDir, { recursive: true });

  const entries: AssetEntry[] = [];
  for (const [position, region] of regions.slice(0, maxAssets).entries()) {
    const cropped = cropPngToRegion(screenshot, region);
    if (cropped === null) continue;

    const name = uniqueAssetName(suggestRegionName(region, position + 1), claimed);
    const localPath = join(assetsDir, `${name}.png`);
    await writeFile(localPath, cropped);

    entries.push({
      originalUrl: `visual-extract:${name}`,
      localPath,
      status: 'downloaded',
      mimeType: 'image/png',
      kind: 'visual-extract',
      suggestedName: name,
    });
  }

  return entries;
}

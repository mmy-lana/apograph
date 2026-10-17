/**
 * apograph — Visual bounding-box asset extraction (screenshot-to-code pattern).
 *
 * Hero backgrounds and interactive maps are frequently rendered via CSS
 * `background-image`, `<canvas>`, or full-bleed banner containers that never
 * appear as `<img>` sources — the DOM asset mirror misses them, and the vision
 * model falls back to flat CSS gradient placeholders. This pass identifies
 * those significant visually distinct containers (excluding regions already
 * covered by mirrored `<img>` sources), extracts their bounding boxes with
 * `page.evaluate`, and crops them out of the full-page screenshot with `pngjs`
 * (an existing dependency — no new packages) into the evidence asset
 * directory. The synthesizer's `copyMirroredAssets` then mirrors them into
 * `public/assets/`, and the manifest registration lists them as available
 * local assets (`hero-bg.png`, `map.png`, ...).
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

/** Hero banner threshold: containers taller than this are significant. */
export const HERO_BANNER_MIN_HEIGHT = 300;

/** Max visual assets extracted per screenshot (token / noise bound). */
export const MAX_VISUAL_ASSETS = 12;

/** Max DOM elements scanned per page (mirrors the asset scraper's bound). */
const MAX_SCAN_ELEMENTS = 3_000;

// ---------------------------------------------------------------------------
// In-page region collection
// ---------------------------------------------------------------------------

/**
 * In-page collector: finds significant visually distinct containers lacking
 * mirrored `<img>` sources — elements with a CSS `background-image` url(),
 * `<canvas>` (and map-like `<iframe>`) surfaces, and hero banners taller than
 * 300px — and returns their page-space bounding boxes with a label hint.
 *
 * Serialized into the page by `page.evaluate`: must stay self-contained
 * (no module-scope references).
 */
export function collectVisualAssetRegionsInPage(): VisualAssetRegion[] {
  const MIN_SIZE = 80;
  const HERO_MIN_HEIGHT = 300;
  const MAX_ELEMENTS = 3_000;
  const MAX_REGIONS = 12;

  interface Candidate {
    rect: DOMRect;
    kind: VisualAssetKind;
    label: string;
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

  const labelFor = (el: Element, kind: VisualAssetKind): string => {
    const id = el.getAttribute('id');
    if (id !== null && id.length > 0) return id;
    const className = el.getAttribute('class');
    if (className !== null) {
      for (const token of className.split(/\s+/)) {
        if (token.length >= 3) return token;
      }
    }
    const aria = el.getAttribute('aria-label');
    if (aria !== null && aria.length > 0) return aria;
    const role = el.getAttribute('role');
    if (role !== null && role.length > 0) return role;
    return kind === 'canvas' ? 'canvas' : kind === 'background-image' ? 'bg' : 'hero';
  };

  const candidates: Candidate[] = [];
  const elements = Array.from(document.querySelectorAll('*')).slice(0, MAX_ELEMENTS);

  for (const el of elements) {
    const tag = el.tagName.toUpperCase();
    if (
      tag === 'IMG' ||
      tag === 'PICTURE' ||
      tag === 'VIDEO' ||
      tag === 'SVG' ||
      tag === 'SCRIPT' ||
      tag === 'STYLE'
    ) {
      continue;
    }

    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (Number.parseFloat(style.opacity || '1') < 0.1) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) continue;

    const backgroundImage = style.backgroundImage;
    const hasBackground =
      typeof backgroundImage === 'string' && backgroundImage.includes('url(');

    let kind: VisualAssetKind | null = null;
    if (tag === 'CANVAS') {
      kind = 'canvas';
    } else if (hasBackground) {
      kind = 'background-image';
    } else if (rect.height > HERO_MIN_HEIGHT) {
      kind = 'hero-banner';
    }
    if (kind === null) continue;

    // Regions whose visual area is mostly covered by an <img> source are
    // already mirrored by the DOM asset scraper — skip them.
    let imgArea = 0;
    for (const img of Array.from(el.querySelectorAll('img'))) {
      const imgRect = img.getBoundingClientRect();
      imgArea += imgRect.width * imgRect.height;
    }
    if (imgArea >= area(rect) * 0.5) continue;

    candidates.push({ rect, kind, label: labelFor(el, kind) });
  }

  // Prefer the innermost specific region: largest first, a candidate nested
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

  return selected.map((candidate) => ({
    kind: candidate.kind,
    x: candidate.rect.left + window.scrollX,
    y: candidate.rect.top + window.scrollY,
    width: candidate.rect.width,
    height: candidate.rect.height,
    label: candidate.label,
  }));
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Sanitizes an in-page label into a filesystem-safe asset base name. */
export function sanitizeAssetBaseName(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base.length > 0 ? base : 'asset';
}

/**
 * Derives the suggested file base name for a region (e.g. `hero-bg`, `map`).
 * Background-image regions get a `-bg` suffix unless the label already
 * carries one.
 */
export function nameForRegion(region: Pick<VisualAssetRegion, 'kind' | 'label'>): string {
  const base = sanitizeAssetBaseName(region.label);
  const suffixed =
    region.kind === 'background-image' && !base.endsWith('-bg') && !base.endsWith('-background')
      ? `${base}-bg`
      : base;
  return suffixed.slice(0, 48);
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
 * Visual asset extraction pass: collects significant region bounding boxes
 * from the live page, crops them out of the given full-page screenshot, and
 * writes each crop into `assetsDir` under its suggested name (`hero-bg.png`,
 * `map.png`, ...). Names are collision-safe across routes via `usedNames`.
 * Returns manifest-ready asset entries for the evidence bundle.
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
  for (const region of regions.slice(0, maxAssets)) {
    const cropped = cropPngToRegion(screenshot, region);
    if (cropped === null) continue;

    const name = uniqueAssetName(nameForRegion(region), claimed);
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

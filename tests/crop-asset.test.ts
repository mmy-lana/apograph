/**
 * Visual bounding-box asset extraction tests (screenshot-to-code pattern).
 *
 * Validates the pngjs crop pipeline on synthetic images: bbox extraction,
 * clamping to image bounds, no-overlap rejection, extract naming, and the
 * verifier's alpha-channel normalization used by the visual diff.
 *
 * spec: visual bounding-box asset extraction
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';

import {
  cropPngToRegion,
  isLayoutUtilityName,
  sanitizeAssetBaseName,
  suggestRegionName,
} from '../dist/crawler/visual-assets.js';
import { compareScreenshots, normalizeAlphaChannel } from '../dist/verifier/engine.js';
import type { VisualAssetRegion } from '../dist/types.js';

// ---------------------------------------------------------------------------
// Synthetic image helpers
// ---------------------------------------------------------------------------

type Rgba = [number, number, number, number];

/** Renders a synthetic PNG buffer from a per-pixel painter. */
function syntheticImage(
  width: number,
  height: number,
  paint: (x: number, y: number) => Rgba,
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const [r, g, b, a] = paint(x, y);
      png.data[index] = r;
      png.data[index + 1] = g;
      png.data[index + 2] = b;
      png.data[index + 3] = a;
    }
  }
  return PNG.sync.write(png);
}

/** Reads one RGBA pixel out of a PNG buffer. */
function pixelAt(buffer: Buffer, x: number, y: number): Rgba {
  const png = PNG.sync.read(buffer);
  const index = (y * png.width + x) * 4;
  return [
    png.data[index] as number,
    png.data[index + 1] as number,
    png.data[index + 2] as number,
    png.data[index + 3] as number,
  ];
}

/** Opaque red and blue used across the fixtures. */
const RED: Rgba = [255, 0, 0, 255];
const BLUE: Rgba = [0, 0, 255, 255];

/** 200x100 blue field with an opaque red band at (50,20)-(110,60). */
function bandedImage(): Buffer {
  return syntheticImage(200, 100, (x, y) =>
    x >= 50 && x < 110 && y >= 20 && y < 60 ? RED : BLUE,
  );
}

// ---------------------------------------------------------------------------
// Bounding-box extraction (pngjs crop)
// ---------------------------------------------------------------------------

test('crop > extracts a bounding box from a synthetic image', () => {
  const cropped = cropPngToRegion(bandedImage(), { x: 50, y: 20, width: 60, height: 40 });
  assert.ok(cropped !== null);

  const png = PNG.sync.read(cropped);
  assert.equal(png.width, 60);
  assert.equal(png.height, 40);

  // Every pixel of the crop comes from inside the red band.
  assert.deepEqual(pixelAt(cropped, 0, 0), RED);
  assert.deepEqual(pixelAt(cropped, 59, 39), RED);
  assert.deepEqual(pixelAt(cropped, 30, 20), RED);
});

test('crop > clamps partially overlapping regions to the image bounds', () => {
  const cropped = cropPngToRegion(bandedImage(), { x: -10, y: -5, width: 50, height: 30 });
  assert.ok(cropped !== null);

  const png = PNG.sync.read(cropped);
  assert.equal(png.width, 40);
  assert.equal(png.height, 25);
});

test('crop > clamps oversized regions to the remaining bounds', () => {
  const cropped = cropPngToRegion(bandedImage(), { x: 10, y: 10, width: 500, height: 500 });
  assert.ok(cropped !== null);

  const png = PNG.sync.read(cropped);
  assert.equal(png.width, 190);
  assert.equal(png.height, 90);
  // The offset origin survives the clamp.
  assert.deepEqual(pixelAt(cropped, 0, 0), BLUE);
});

test('crop > returns null for regions with no overlap', () => {
  assert.equal(cropPngToRegion(bandedImage(), { x: 300, y: 300, width: 50, height: 50 }), null);
  assert.equal(cropPngToRegion(bandedImage(), { x: -50, y: 0, width: 30, height: 10 }), null);
});

// ---------------------------------------------------------------------------
// Suggested naming
// ---------------------------------------------------------------------------

/** Builds a minimal region, overriding only the fields under test. */
function region(overrides: Partial<VisualAssetRegion> = {}): VisualAssetRegion {
  return {
    kind: 'background-image',
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    tag: 'div',
    id: null,
    ariaLabel: null,
    alt: null,
    classTokens: [],
    inHero: false,
    ...overrides,
  };
}

test('naming > assigns semantic names from id, aria-label, and semantic tags', () => {
  assert.equal(sanitizeAssetBaseName('Hero Header!'), 'hero-header');
  assert.equal(sanitizeAssetBaseName('***'), 'asset');

  assert.equal(
    suggestRegionName(region({ kind: 'canvas', tag: 'canvas', id: 'map' }), 1),
    'map-canvas',
  );
  assert.equal(
    suggestRegionName(region({ kind: 'svg', tag: 'svg', ariaLabel: 'Network diagram' }), 1),
    'network-diagram',
  );
  assert.equal(
    suggestRegionName(region({ kind: 'svg', tag: 'svg', id: 'network' }), 1),
    'network-diagram',
  );
  assert.equal(
    suggestRegionName(region({ kind: 'image', tag: 'img', alt: 'Resort aerial view' }), 1),
    'resort-aerial-view',
  );
  // Unnamed canvas keeps its semantic tag instead of a utility name.
  assert.equal(
    suggestRegionName(region({ kind: 'canvas', tag: 'canvas', classTokens: ['w-full'] }), 2),
    'canvas',
  );
});

test('naming > hero background-image regions are named hero-bg', () => {
  assert.equal(
    suggestRegionName(region({ kind: 'background-image', inHero: true }), 1),
    'hero-bg',
  );
  assert.equal(
    suggestRegionName(region({ kind: 'background-image', id: 'jungle' }), 1),
    'jungle-bg',
  );
});

test('naming > rejects generic utility class names', () => {
  for (const utility of ['relative', 'absolute', 'container', 'mx-auto', 'w-full', 'space-y-6']) {
    assert.equal(isLayoutUtilityName(utility), true, `${utility} must be rejected`);
  }
  assert.equal(isLayoutUtilityName('hero-bg'), false);
  assert.equal(isLayoutUtilityName('map-canvas'), false);

  // Utility-class-only wrappers fall back to the section-graphic name.
  assert.equal(
    suggestRegionName(
      region({ kind: 'background-image', classTokens: ['relative', 'mx-auto', 'container'] }),
      3,
    ),
    'section-graphic-3',
  );
  // Even an id that is a utility name is rejected.
  assert.equal(
    suggestRegionName(region({ kind: 'image', tag: 'img', id: 'container' }), 4),
    'section-graphic-4',
  );
});

// ---------------------------------------------------------------------------
// Alpha-channel normalization (visual diff resilience)
// ---------------------------------------------------------------------------

test('compare > alpha-only differences do not count as layout mismatches', () => {
  const opaque = syntheticImage(4, 4, () => RED);
  const translucent = syntheticImage(4, 4, () => [255, 0, 0, 64]);
  const transparent = syntheticImage(4, 4, () => [255, 0, 0, 0]);

  const translucentResult = compareScreenshots(opaque, translucent, 'diff.png');
  assert.equal(translucentResult.mismatchPercent, 0);

  const transparentResult = compareScreenshots(opaque, transparent, 'diff.png');
  assert.equal(transparentResult.mismatchPercent, 0);
});

test('compare > real RGB differences still count as mismatches', () => {
  const red = syntheticImage(4, 4, () => RED);
  const blue = syntheticImage(4, 4, () => BLUE);

  const result = compareScreenshots(red, blue, 'diff.png');
  assert.equal(result.mismatchPercent, 100);
});

test('compare > normalizeAlphaChannel forces every pixel opaque', () => {
  const png = PNG.sync.read(syntheticImage(2, 2, () => [10, 20, 30, 0]));
  normalizeAlphaChannel(png);

  for (let index = 3; index < png.data.length; index += 4) {
    assert.equal(png.data[index], 255);
  }
  assert.equal(png.data[0], 10);
});

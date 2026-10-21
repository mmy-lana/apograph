/**
 * Regression tests for canvas overlay capture and replay evidence
 * (remediation record #12):
 *
 * 1. `decodeCanvasDataUrl` decodes valid PNG data URLs and rejects garbage.
 * 2. Producer source invariants: canvas regions capture the element's own
 *    drawing (with screenshot-crop fallback) and record measured overlay
 *    semantics; synthesis annotates viewport overlays in the asset map and
 *    carries a generic overlay-rendering contract.
 *
 * spec: automate-testing-self-fixing.md remediation record #12 (Experiment 5).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeCanvasDataUrl } from '../dist/crawler/visual-assets.js';
import { parseImageDimensions } from '../dist/synthesizer/vision.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 1x1 transparent PNG.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('canvas-overlay > decodes valid PNG data URLs and rejects invalid input', () => {
  const buffer = decodeCanvasDataUrl(`data:image/png;base64,${TINY_PNG_BASE64}`);
  assert.ok(buffer !== null);
  assert.equal(buffer[0], 0x89);
  assert.equal(buffer[1], 0x50);
  assert.equal(buffer[2], 0x4e);
  assert.equal(buffer[3], 0x47);

  assert.equal(decodeCanvasDataUrl('data:image/jpeg;base64,AAAA'), null);
  assert.equal(decodeCanvasDataUrl('data:image/png;base64,'), null);
  assert.equal(decodeCanvasDataUrl('not a data url'), null);
  // Valid base64 that is not a PNG payload.
  assert.equal(decodeCanvasDataUrl('data:image/png;base64,QUJDREVG'), null);
});

test('canvas-overlay > canvas regions capture the element buffer with crop fallback', async () => {
  const source = await readFile(join(SRC_ROOT, 'src', 'crawler', 'visual-assets.ts'), 'utf8');
  // Own-drawing capture via toDataURL, with the screenshot crop as fallback.
  assert.ok(source.includes("canvas.toDataURL('image/png')"));
  assert.ok(source.includes('decodeCanvasDataUrl(region.canvasDataUrl)'));
  assert.ok(source.includes('cropPngToRegion(screenshot, region)'));
  // Measured overlay semantics recorded on both region and entry.
  assert.ok(source.includes('coversViewport'));
  assert.ok(source.includes("source: dataUrl !== undefined ? 'element-buffer' : 'screenshot-crop'"));
  assert.ok(source.includes('canvasOverlay: region.canvasOverlay'));
});

test('canvas-overlay > synthesis annotates and honors viewport overlays', async () => {
  const vision = await readFile(join(SRC_ROOT, 'src', 'synthesizer', 'vision.ts'), 'utf8');
  assert.ok(vision.includes('viewport overlay'));
  assert.ok(vision.includes('overlay.coversViewport'));

  const modular = await readFile(join(SRC_ROOT, 'src', 'synthesizer', 'modular.ts'), 'utf8');
  assert.ok(modular.includes('OVERLAY ASSETS'));
  assert.ok(modular.includes('Never use an overlay asset as a tiling/repeating background'));

  const types = await readFile(join(SRC_ROOT, 'src', 'types.ts'), 'utf8');
  assert.ok(types.includes('canvasOverlay?: CanvasOverlayMeta'));
  assert.ok(types.includes("source: 'element-buffer' | 'screenshot-crop'"));
});

// ---------------------------------------------------------------------------
// Asset map image descriptors (screenshot <-> file mapping evidence)
// ---------------------------------------------------------------------------

test('image descriptors > parseImageDimensions reads PNG/JPEG/GIF/SVG headers', () => {
  // PNG: signature + IHDR width/height.
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(png.buffer).setUint32(16, 1280);
  new DataView(png.buffer).setUint32(20, 800);
  assert.deepEqual(parseImageDimensions(png), { width: 1280, height: 800 });

  // JPEG: SOI + SOF0 frame header (precision, height, width).
  const jpeg = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x80, 0x03,
  ]);
  assert.deepEqual(parseImageDimensions(jpeg), { width: 640, height: 300 });

  // GIF: little-endian u16 dims.
  const gif = new Uint8Array(10);
  gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  new DataView(gif.buffer).setUint16(6, 48, true);
  new DataView(gif.buffer).setUint16(8, 24, true);
  assert.deepEqual(parseImageDimensions(gif), { width: 48, height: 24 });

  // SVG: width/height attributes.
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="48"></svg>');
  assert.deepEqual(parseImageDimensions(svg), { width: 96, height: 48 });

  // Unrecognized headers yield null instead of guessing.
  assert.equal(parseImageDimensions(new Uint8Array(32)), null);
  assert.equal(parseImageDimensions(new TextEncoder().encode('plain text')), null);
});

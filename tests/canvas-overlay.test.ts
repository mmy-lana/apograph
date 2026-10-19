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

/**
 * Regression tests for the capture-state policy (per-viewport fresh-state
 * capture):
 *
 * The crawler must capture each viewport's screenshots and DOM measurements
 * from a document LOADED at that viewport width. Resizing a desktop-loaded
 * page to mobile width produces a distorted rendering (measured: 13–18%
 * pixel delta against a fresh mobile load on an animated target), which made
 * mobile references disagree with the rendering any mobile visitor — and the
 * live verifier's fresh-load capture — actually sees.
 *
 * spec: automate-testing-self-fixing.md remediation record #8 (Experiment 3).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('capture-state > crawler reloads at the capture viewport before capturing', async () => {
  const engineText = await readFile(join(SRC_ROOT, 'src', 'crawler', 'engine.ts'), 'utf8');

  // The helper reloads whenever the effective width changes and redoes the
  // lazy-load scroll pass plus readiness before any capture.
  const helperIndex = engineText.indexOf('const ensureCaptureViewport = ');
  assert.ok(helperIndex !== -1, 'crawler must define the capture-state helper');
  const helperSource = engineText.slice(helperIndex, helperIndex + 1600);
  assert.ok(helperSource.includes('page.reload('), 'helper must reload the document');
  assert.ok(helperSource.includes('autoScrollWithReset(page)'), 'helper must redo lazy-load scrolling');
  assert.ok(helperSource.includes('waitForPageReadiness(page)'), 'helper must redo readiness checks');
  assert.ok(
    helperSource.includes('loadedWidth === size.width'),
    'helper must be a no-op when already loaded at the target width',
  );
});

test('capture-state > screenshots are captured in fresh viewport state', async () => {
  const engineText = await readFile(join(SRC_ROOT, 'src', 'crawler', 'engine.ts'), 'utf8');

  const desktopIndex = engineText.indexOf('ensureCaptureViewport(DESKTOP_VIEWPORT);');
  const mobileIndex = engineText.indexOf('ensureCaptureViewport(MOBILE_VIEWPORT);');
  const desktopShotIndex = engineText.indexOf('screenshot({ path: desktopScreenshot');
  const mobileShotIndex = engineText.indexOf('screenshot({ path: mobileScreenshot');
  assert.ok(desktopIndex !== -1 && mobileIndex !== -1, 'both viewports must go through the helper');
  assert.ok(
    desktopIndex < desktopShotIndex,
    'desktop screenshot must follow the fresh-state switch',
  );
  assert.ok(
    mobileIndex < mobileShotIndex,
    'mobile screenshot must follow the fresh-state switch',
  );

  // The desktop restore (before health/snapshot measurement) is fresh too.
  const restoreIndex = engineText.indexOf('ensureCaptureViewport(DESKTOP_VIEWPORT);\n      }');
  const snapshotIndex = engineText.indexOf('captureDOMSnapshot(page, path)');
  assert.ok(restoreIndex !== -1, 'desktop restore must use the fresh-state helper');
  assert.ok(
    restoreIndex < snapshotIndex,
    'DOM measurements must run in fresh desktop state',
  );
});

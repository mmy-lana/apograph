/**
 * Unit tests for the capture-scrolling patch (patch spec s5):
 * in-page evaluation isolation (s2.1), bounded auto-scroll planning and
 * executor ordering (s3.1), and tier-3 reference cropping (s3.2).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import {
  planAutoScroll,
  autoScrollWithReset,
  MAX_SCROLL_STEPS,
  SETTLE_DELAY_MS,
  RESET_DELAY_MS,
} from '../dist/crawler/scroll.js';
import type { ScrollTickResult } from '../dist/crawler/scroll.js';
import { compareScreenshots } from '../dist/verifier/engine.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// s5.1 - In-page evaluation isolation boundary
// ---------------------------------------------------------------------------

/** Extracts the source of a column-0 function declaration from file text. */
function extractFunctionSource(fileText: string, name: string): string {
  const start = fileText.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  // Scan to the matching closing brace at column 0.
  const end = fileText.indexOf('\n}', start);
  if (end === -1) throw new Error(`closing brace of ${name} not found`);
  return fileText.slice(start, end + 2);
}

/** Collects column-0 module-scope value declaration names in a file. */
function moduleScopeNames(fileText: string): string[] {
  const names: string[] = [];
  const pattern = /^(?:export )?(?:const|let|var|async function|function)\s+([A-Za-z_$][\w$]*)/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(fileText)) !== null) {
    names.push(match[1] as string);
  }
  return names;
}

/** Asserts an in-page function references no module-scope binding. */
function assertSelfContained(fileText: string, fnName: string): void {
  const fnSource = extractFunctionSource(fileText, fnName);
  for (const name of moduleScopeNames(fileText)) {
    if (name === fnName) continue;
    const referenced = new RegExp(`\\b${name}\\b`).test(fnSource);
    assert.ok(
      !referenced,
      `in-page collector ${fnName} references module-scope binding "${name}" ` +
        '(patch spec s2.1: evaluated functions must be fully self-contained)',
    );
  }
}

test('isolation > collectRawTextSpans declares SEMANTIC_ANCESTORS internally', async () => {
  const fileText = await readFile(join(SRC_ROOT, 'src', 'harvester', 'dom.ts'), 'utf8');

  // No module-scope declaration of the set remains.
  assert.ok(
    !/^const SEMANTIC_ANCESTORS/m.test(fileText),
    'SEMANTIC_ANCESTORS must not be declared at module scope (patch spec s2.1)',
  );
  // The collector declares the set and the ancestor helper inside its body.
  const fnSource = extractFunctionSource(fileText, 'collectRawTextSpans');
  assert.ok(fnSource.includes('const SEMANTIC_ANCESTORS = new Set'));
  assert.ok(fnSource.includes('const semanticAncestor'));
});

test('isolation > every in-page collector is lexically self-contained', async () => {
  const domText = await readFile(join(SRC_ROOT, 'src', 'harvester', 'dom.ts'), 'utf8');
  const engineText = await readFile(join(SRC_ROOT, 'src', 'crawler', 'engine.ts'), 'utf8');

  for (const name of ['collectRawTextSpans', 'collectCssText', 'collectBodyComputedStyle']) {
    assertSelfContained(domText, name);
  }
  for (const name of ['countVisibleNodesInPage', 'collectHeadMetadata']) {
    assertSelfContained(engineText, name);
  }
});

test('isolation > pure pipeline exports remain available for Node tests', async () => {
  const { buildTextSpans, isGradientText, isTransparentColor, normalizeColorToHex } =
    await import('../dist/harvester/dom.js');
  assert.equal(typeof buildTextSpans, 'function');
  assert.equal(typeof isGradientText, 'function');
  assert.equal(typeof isTransparentColor, 'function');
  assert.equal(typeof normalizeColorToHex, 'function');
  // Signatures still behave per s8.4.
  assert.equal(normalizeColorToHex('rgb(8, 15, 28)'), '#080f1c');
  assert.deepEqual(
    buildTextSpans([
      {
        text: 'X', color: 'rgb(0, 0, 0)', backgroundImage: 'none', backgroundClip: 'border-box',
        webkitTextFillColor: 'rgb(0, 0, 0)', display: 'block', visibility: 'visible',
        boxWidth: 10, boxHeight: 10, tag: 'span', parentTag: 'p',
      },
    ]).length,
    1,
  );
});

// ---------------------------------------------------------------------------
// s5.2 - Scroll planning
// ---------------------------------------------------------------------------

test('scroll > plan terminates at page bottom', async () => {
  // Converging page: max scroll stops increasing on the first tick to the
  // bottom, then again (bottom reached).
  let current: ScrollTickResult = { scrollY: 0, maxScroll: 3000, scrollHeight: 3800 };
  const plan = await planAutoScroll(
    { ...current, viewportHeight: 800 },
    async () => {
      current = { scrollY: current.maxScroll, maxScroll: current.maxScroll, scrollHeight: current.scrollHeight };
      return current;
    },
    () => 0,
  );
  assert.equal(plan.terminatedBy, 'bottom');
  assert.ok(plan.steps <= MAX_SCROLL_STEPS);
  assert.equal(plan.finalMaxScroll, 3000);
});

test('scroll > plan terminates on step bound for infinite scroll', async () => {
  // Content grows forever; the clock never advances.
  let maxScroll = 3000;
  const plan = await planAutoScroll(
    { scrollY: 0, maxScroll, scrollHeight: maxScroll + 800, viewportHeight: 800 },
    async (target) => {
      maxScroll = target + 1000;
      return { scrollY: target, maxScroll, scrollHeight: maxScroll + 800 };
    },
    () => 0,
  );
  assert.equal(plan.terminatedBy, 'steps');
  assert.equal(plan.steps, MAX_SCROLL_STEPS);
});

test('scroll > plan terminates on time bound', async () => {
  // Growing content with a fast clock; raise the step cap so time trips first.
  let maxScroll = 3000;
  let elapsed = 0;
  const plan = await planAutoScroll(
    { scrollY: 0, maxScroll, scrollHeight: maxScroll + 800, viewportHeight: 800 },
    async (target) => {
      elapsed += 1000;
      maxScroll = target + 1000;
      return { scrollY: target, maxScroll, scrollHeight: maxScroll + 800 };
    },
    () => elapsed,
    { maxSteps: 100, maxDurationMs: 5000 },
  );
  assert.equal(plan.terminatedBy, 'timeout');
  assert.ok(elapsed >= 5000);
  assert.ok(plan.steps < 100);
});

test('scroll > zero-height body terminates immediately with zero steps', async () => {
  const plan = await planAutoScroll(
    { scrollY: 0, maxScroll: 0, scrollHeight: 800, viewportHeight: 800 },
    async () => {
      throw new Error('tick must not be called for a viewport-sized body');
    },
    () => 0,
  );
  assert.deepEqual(plan, { steps: 0, terminatedBy: 'bottom', finalMaxScroll: 0 });
});

// ---------------------------------------------------------------------------
// s5.2 - Capture ordering (reset strictly precedes screenshots)
// ---------------------------------------------------------------------------

interface FakePageCall {
  kind: 'evaluate-tick' | 'evaluate-initial' | 'evaluate-reset' | 'wait';
  ms?: number;
}

function makeFakePage(initialMaxScroll: number, converge: boolean): {
  page: Parameters<typeof autoScrollWithReset>[0];
  calls: FakePageCall[];
} {
  const calls: FakePageCall[] = [];
  let maxScroll = initialMaxScroll;

  const page = {
    evaluate: async (fn: unknown, arg: unknown) => {
      const source = String(fn);
      if (source.includes('window.scrollTo(0, 0)')) {
        calls.push({ kind: 'evaluate-reset' });
        return null;
      }
      if (source.includes('top: target')) {
        calls.push({ kind: 'evaluate-tick' });
        if (!converge) maxScroll = maxScroll + 1000;
        return { scrollY: maxScroll, maxScroll, scrollHeight: maxScroll + 800 };
      }
      calls.push({ kind: 'evaluate-initial' });
      return { scrollY: 0, maxScroll, scrollHeight: maxScroll + 800, viewportHeight: 800 };
    },
    waitForTimeout: async (ms: number) => {
      calls.push({ kind: 'wait', ms });
      return;
    },
  };

  return { page: page as unknown as Parameters<typeof autoScrollWithReset>[0], calls };
}

test('scroll > executor ordering: autoScroll, settle, reset, resetDelay', async () => {
  const { page, calls } = makeFakePage(2000, true);
  const result = await autoScrollWithReset(page);

  assert.deepEqual(result.operations, ['autoScroll', 'settleDelay', 'scrollReset', 'resetDelay']);
  assert.equal(result.terminatedBy, 'bottom');

  // Settle delay is exactly the spec constant; reset delay follows the reset.
  const settle = calls.findIndex((call) => call.kind === 'wait' && call.ms === SETTLE_DELAY_MS);
  const reset = calls.findIndex((call) => call.kind === 'evaluate-reset');
  const resetDelay = calls.findIndex((call) => call.kind === 'wait' && call.ms === RESET_DELAY_MS);
  assert.ok(reset > -1, 'scroll reset to (0, 0) must be performed');
  assert.ok(settle > -1 && settle < reset, 'settle delay must precede the reset');
  assert.ok(reset < resetDelay, 'post-reset delay must follow the reset');
  // At least one tick happened before the reset.
  assert.ok(calls.some((call) => call.kind === 'evaluate-tick'));
});

test('scroll > executor reset happens before any capture-time call site ordering', async () => {
  // Static ordering check on the engine source (patch spec s5.2): the
  // auto-scroll/reset block must precede screenshots, node counting, and
  // the DOM snapshot.
  const engineText = await readFile(join(SRC_ROOT, 'src', 'crawler', 'engine.ts'), 'utf8');
  const scrollIdx = engineText.indexOf('await autoScrollWithReset(page)');
  const screenshotIdx = engineText.indexOf("page.screenshot({ path: desktopScreenshot as string, type: 'png', fullPage: true })");
  const nodeCountIdx = engineText.indexOf('await countVisibleNodes(page)');
  const snapshotIdx = engineText.indexOf('await captureDOMSnapshot(page, path)');
  assert.ok(scrollIdx > -1 && screenshotIdx > -1 && nodeCountIdx > -1 && snapshotIdx > -1);
  assert.ok(scrollIdx < screenshotIdx, 'auto-scroll must precede screenshots');
  assert.ok(scrollIdx < nodeCountIdx, 'auto-scroll must precede the visible-node count');
  assert.ok(scrollIdx < snapshotIdx, 'auto-scroll must precede the DOM snapshot');
  // Full-page capture contract (patch spec s3.2): both viewports.
  assert.equal((engineText.match(/fullPage: true/g) ?? []).length, 2);
});

test('scroll > recrawlRoute adopts full-page captures and the same ordering', async () => {
  const gateText = await readFile(join(SRC_ROOT, 'src', 'plan', 'evidenceGate.ts'), 'utf8');
  assert.equal((gateText.match(/fullPage: true/g) ?? []).length, 2);
  const scrollIdx = gateText.indexOf('await autoScrollWithReset(page)');
  const screenshotIdx = gateText.indexOf("page.screenshot({ path: desktopPath, type: 'png', fullPage: true })");
  assert.ok(scrollIdx > -1 && screenshotIdx > -1);
  assert.ok(scrollIdx < screenshotIdx, 'auto-scroll must precede re-capture screenshots');
});

// ---------------------------------------------------------------------------
// s5.3 - Reference cropping for full-page references
// ---------------------------------------------------------------------------

/** Renders a solid PNG. */
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const idx = i << 2;
    png.data[idx] = rgb[0];
    png.data[idx + 1] = rgb[1];
    png.data[idx + 2] = rgb[2];
    png.data[idx + 3] = 255;
  }
  return PNG.sync.write(png);
}

test('verify > tall full-page reference is top-anchored cropped to viewport', async () => {
  // Reference: top 800px red, rest blue (a "full-page" 1280x2400 capture).
  const reference = new PNG({ width: 1280, height: 2400 });
  for (let y = 0; y < 2400; y++) {
    for (let x = 0; x < 1280; x++) {
      const idx = (1280 * y + x) << 2;
      const [r, g, b] = y < 800 ? [255, 0, 0] : [0, 0, 255];
      reference.data[idx] = r;
      reference.data[idx + 1] = g;
      reference.data[idx + 2] = b;
      reference.data[idx + 3] = 255;
    }
  }
  const referenceBuffer = PNG.sync.write(reference);

  const outputDir = await mkdtemp(join(tmpdir(), 'apograph-crop-'));
  try {
    const diffPath = join(outputDir, 'diff.png');

    // Current viewport capture matches the reference's top 800px exactly.
    const current = solidPng(1280, 800, [255, 0, 0]);
    const result = compareScreenshots(referenceBuffer, current, diffPath, 800);

    // The blue below-the-fold region was cropped away: zero mismatch.
    assert.equal(result.mismatchPercent, 0);
    assert.equal(result.cropNote, 'reference cropped from 2400 px to viewport height');
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('verify > viewport-sized reference compares unchanged without crop note', async () => {
  const reference = solidPng(1280, 800, [8, 15, 28]);
  const current = solidPng(1280, 800, [8, 15, 28]);
  const result = compareScreenshots(reference, current, '/tmp/unused-diff.png', 800);
  assert.equal(result.mismatchPercent, 0);
  assert.equal(result.cropNote, undefined);
});

test('verify > cropped comparison still detects real mismatch', async () => {
  const topRedReference = new PNG({ width: 1280, height: 2400 });
  for (let y = 0; y < 2400; y++) {
    for (let x = 0; x < 1280; x++) {
      const idx = (1280 * y + x) << 2;
      const [r, g, b] = y < 800 ? [255, 0, 0] : [0, 0, 255];
      topRedReference.data[idx] = r;
      topRedReference.data[idx + 1] = g;
      topRedReference.data[idx + 2] = b;
      topRedReference.data[idx + 3] = 255;
    }
  }
  // Current at-top viewport is green: a real mismatch in the compared slice.
  const current = solidPng(1280, 800, [0, 255, 0]);
  const result = compareScreenshots(PNG.sync.write(topRedReference), current, '/tmp/unused-diff.png', 800);
  assert.equal(result.mismatchPercent, 100);
  assert.equal(result.cropNote, 'reference cropped from 2400 px to viewport height');
});

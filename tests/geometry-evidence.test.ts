/**
 * Regression tests for measured rendered-geometry evidence (per-viewport):
 *
 * 1. The harvester captures computed typography metrics (font-size, weight,
 *    line-height, letter-spacing, text-transform, family, align) and the
 *    pure mapping keeps them while dropping unresolvable identity values.
 * 2. The text-corpus prompt formatter surfaces the measured geometry per
 *    span, including the mobile viewport's measurements when a dual-viewport
 *    crawl provided them, and stays metric-free when no evidence exists.
 * 3. Producer/consumer source invariants: the crawler measures the mobile
 *    corpus while the mobile viewport is active and records it on the route;
 *    both synthesis stages pass the mobile corpus and carry the measured
 *    geometry contract.
 *
 * spec: automate-testing-self-fixing.md remediation record #6 (Experiment 3).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTextStyle, buildTextSpans } from '../dist/harvester/dom.js';
import type { RawTextSpan } from '../dist/harvester/dom.js';
import { formatMeasuredMetrics, formatTextSpansForPrompt } from '../dist/synthesizer/vision.js';
import type { TextSpan } from '../dist/types.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function rawSpan(overrides: Partial<RawTextSpan>): RawTextSpan {
  return {
    text: 'Hello',
    color: 'rgb(248, 250, 252)',
    backgroundImage: 'none',
    backgroundClip: 'border-box',
    webkitTextFillColor: 'rgb(248, 250, 252)',
    display: 'block',
    visibility: 'visible',
    boxTop: 0,
    boxLeft: 0,
    boxWidth: 800,
    boxHeight: 40,
    tag: 'span',
    parentTag: 'p',
    ...overrides,
  };
}

function span(overrides: Partial<TextSpan>): TextSpan {
  return {
    text: 'Hello',
    color: 'rgb(248, 250, 252)',
    tag: 'span',
    parentTag: 'p',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Harvester: measured typography capture (pure mapping)
// ---------------------------------------------------------------------------

test('geometry > buildTextStyle keeps measured typography values', () => {
  const style = buildTextStyle(
    rawSpan({
      fontSize: '30px',
      fontWeight: '900',
      lineHeight: '36px',
      letterSpacing: '-0.02em',
      textTransform: 'uppercase',
      fontFamily: '"Inter", system-ui, sans-serif',
      textAlign: 'center',
    }),
  );
  assert.deepEqual(style, {
    fontSize: '30px',
    fontWeight: '900',
    lineHeight: '36px',
    letterSpacing: '-0.02em',
    textTransform: 'uppercase',
    fontFamily: 'Inter',
    textAlign: 'center',
  });
});

test('geometry > buildTextStyle drops identity and unresolvable values', () => {
  const style = buildTextStyle(
    rawSpan({
      lineHeight: 'normal',
      letterSpacing: 'normal',
      textTransform: 'none',
      fontFamily: '',
      textAlign: 'left',
    }),
  );
  // textAlign 'left' is kept in evidence (it is a real measured value);
  // 'normal'/'none'/empty values are not.
  assert.deepEqual(style, { textAlign: 'left' });
  assert.equal(buildTextStyle(rawSpan({})), undefined);
});

test('geometry > buildTextSpans attaches style only when measurable', () => {
  const spans = buildTextSpans([
    rawSpan({ text: 'styled', fontSize: '30px', fontWeight: '900' }),
    rawSpan({ text: 'legacy' }),
  ]);
  assert.equal(spans.length, 2);
  assert.deepEqual(spans[0]?.style, { fontSize: '30px', fontWeight: '900' });
  assert.equal(spans[1]?.style, undefined);
  // Legacy fields unaffected.
  assert.equal(spans[0]?.boundingBox?.width, 800);
});

// ---------------------------------------------------------------------------
// Prompt formatting: measured geometry replay
// ---------------------------------------------------------------------------

test('geometry > formatMeasuredMetrics is compact and empty without evidence', () => {
  const measured = formatMeasuredMetrics(
    span({
      style: { fontSize: '30px', fontWeight: '900', lineHeight: '36px' },
      boundingBox: { top: 169, left: 24, width: 314, height: 72 },
    }),
  );
  assert.match(measured, /fs 30px/);
  assert.match(measured, /fw 900/);
  assert.match(measured, /lh 36px/);
  assert.match(measured, /box 314x72 @24,169/);
  assert.equal(formatMeasuredMetrics(span({})), '');
});

test('geometry > corpus prompt embeds measured geometry and mobile metrics', () => {
  const desktop = [
    span({
      text: 'Muhammad Maulana Yusuf',
      parentTag: 'h1',
      style: { fontSize: '34px', fontWeight: '900' },
      boundingBox: { top: 120, left: 40, width: 500, height: 80 },
    }),
  ];
  const mobile = [
    span({
      text: 'Muhammad Maulana Yusuf',
      parentTag: 'h1',
      style: { fontSize: '30px', fontWeight: '900' },
      boundingBox: { top: 169, left: 24, width: 314, height: 72 },
    }),
  ];

  const prompt = formatTextSpansForPrompt(desktop, mobile);
  assert.match(prompt, /\[desktop: fs 34px/);
  assert.match(prompt, /\[mobile: fs 30px/);
  assert.match(prompt, /box 314x72 @24,169/);
  assert.match(prompt, /MEASURED computed values/);

  // Without mobile evidence the primary metrics are labeled neutrally.
  const single = formatTextSpansForPrompt(desktop);
  assert.match(single, /\[measured: fs 34px/);
  assert.ok(!single.includes('[mobile:'));
});

test('geometry > corpus prompt without metrics omits the measured note', () => {
  const prompt = formatTextSpansForPrompt([
    span({ text: 'Plain', boundingBox: undefined }),
  ]);
  assert.ok(!prompt.includes('MEASURED'));
  assert.match(prompt, /\[p>span\] Plain/);
});

// ---------------------------------------------------------------------------
// Producer source invariants (repo test style: see tests/scroll.test.ts)
// ---------------------------------------------------------------------------

test('geometry > crawler measures the mobile corpus while the mobile viewport is active', async () => {
  const engineText = await readFile(join(SRC_ROOT, 'src', 'crawler', 'engine.ts'), 'utf8');
  const mobileViewportIndex = engineText.indexOf('ensureCaptureViewport(MOBILE_VIEWPORT)');
  const captureIndex = engineText.indexOf('mobileTextSpans = await extractTextSpans(page)');
  const restoreIndex = engineText.indexOf('ensureCaptureViewport(DESKTOP_VIEWPORT);\n      }');
  assert.ok(mobileViewportIndex !== -1, 'crawler must switch to the mobile viewport');
  assert.ok(captureIndex !== -1, 'crawler must measure the mobile text corpus');
  assert.ok(
    mobileViewportIndex < captureIndex,
    'mobile corpus must be measured after switching to the mobile viewport',
  );
  assert.ok(
    captureIndex < restoreIndex,
    'mobile corpus must be measured before the desktop viewport is restored',
  );
  assert.ok(
    engineText.includes('{ mobileTextSpans }'),
    'crawler must record the mobile corpus on the route record',
  );
});

test('geometry > synthesis stages pass mobile corpus and carry the geometry contract', async () => {
  const modularText = await readFile(join(SRC_ROOT, 'src', 'synthesizer', 'modular.ts'), 'utf8');
  assert.ok(
    modularText.includes('formatTextSpansForPrompt(manifestRoute?.textSpans ?? [], manifestRoute?.mobileTextSpans)'),
    'stage-3 must pass the mobile corpus into the prompt formatter',
  );
  assert.ok(
    modularText.includes('formatTextSpansForPrompt(layoutRoute?.textSpans ?? [], layoutRoute?.mobileTextSpans)'),
    'stage-2 must pass the mobile corpus into the prompt formatter',
  );
  assert.ok(
    modularText.includes('MEASURED GEOMETRY CONTRACT'),
    'stage prompts must carry the measured geometry contract',
  );
});

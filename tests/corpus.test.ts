/**
 * Unit tests for visible DOM text corpus harvesting (text spans, gradient
 * headline spans, visibility filtering) and prompt formatting.
 *
 * spec: integration/visual-resilience s8.4
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTextSpans,
  isGradientText,
  isTransparentColor,
} from '../dist/harvester/dom.js';
import type { RawTextSpan } from '../dist/harvester/dom.js';
import { formatTextSpansForPrompt } from '../dist/synthesizer/vision.js';
import type { TextSpan } from '../dist/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Builds a raw in-page span entry with defaults for every field. */
function rawSpan(overrides: Partial<RawTextSpan>): RawTextSpan {
  return {
    text: 'Hello',
    color: 'rgb(248, 250, 252)',
    backgroundImage: 'none',
    backgroundClip: 'border-box',
    webkitTextFillColor: 'rgb(248, 250, 252)',
    display: 'block',
    visibility: 'visible',
    boxWidth: 800,
    boxHeight: 40,
    tag: 'span',
    parentTag: 'p',
    ...overrides,
  };
}

const EXAMPLE_GRADIENT =
  'linear-gradient(90deg, rgb(6, 182, 212), rgb(59, 130, 246))';

// ---------------------------------------------------------------------------
// s8.4 row 1 - Harvests visible text spans in order with correct tags
// ---------------------------------------------------------------------------

test('dom > harvests visible text spans in order', () => {
  // A fixture DOM: h1 > span, then h2 > span, then p — in document order.
  const raw = [
    rawSpan({
      text: '  TECHNOLOGY & AI PARTNER  ',
      tag: 'span',
      parentTag: 'h1',
      color: 'rgb(248, 250, 252)',
    }),
    rawSpan({ text: 'Services', tag: 'span', parentTag: 'h2' }),
    rawSpan({ text: 'We build systems.', tag: 'span', parentTag: 'p' }),
  ];

  const spans = buildTextSpans(raw);
  assert.equal(spans.length, 3);
  // Document order preserved.
  assert.equal(spans[0]?.text, 'TECHNOLOGY & AI PARTNER');
  assert.equal(spans[1]?.text, 'Services');
  assert.equal(spans[2]?.text, 'We build systems.');
  // Tags recorded per spec s5.1.
  assert.equal(spans[0]?.tag, 'span');
  assert.equal(spans[0]?.parentTag, 'h1');
  assert.equal(spans[1]?.parentTag, 'h2');
  assert.equal(spans[2]?.parentTag, 'p');
  // Text is trimmed; computed color carried through.
  assert.equal(spans[0]?.text, spans[0]?.text.trim());
  assert.equal(spans[0]?.color, 'rgb(248, 250, 252)');
});

// ---------------------------------------------------------------------------
// s8.4 row 2 - Captures gradient headline spans verbatim
// ---------------------------------------------------------------------------

test('dom > captures gradient headline spans', () => {
  // background-clip: text route.
  const clip = buildTextSpans([
    rawSpan({
      text: 'TECHNOLOGY & AI PARTNER',
      tag: 'span',
      parentTag: 'h1',
      backgroundImage: EXAMPLE_GRADIENT,
      backgroundClip: 'text',
      webkitTextFillColor: 'transparent',
      color: 'rgb(6, 182, 212)',
    }),
  ]);
  assert.equal(clip.length, 1);
  assert.equal(clip[0]?.gradient, EXAMPLE_GRADIENT);

  // -webkit-text-fill-color: transparent route (without explicit clip).
  const fill = buildTextSpans([
    rawSpan({
      text: 'BUSINESS',
      tag: 'span',
      parentTag: 'h1',
      backgroundImage: EXAMPLE_GRADIENT,
      backgroundClip: 'border-box',
      webkitTextFillColor: 'transparent',
    }),
  ]);
  assert.equal(fill.length, 1);
  assert.equal(fill[0]?.gradient, EXAMPLE_GRADIENT);

  // Gradient background without text-clip/fill-transparent is NOT gradient text.
  const plain = buildTextSpans([
    rawSpan({
      text: 'Banner',
      backgroundImage: EXAMPLE_GRADIENT,
      webkitTextFillColor: 'rgb(255, 255, 255)',
    }),
  ]);
  assert.equal(plain[0]?.gradient, undefined);
});

test('dom > gradient predicate matches clip-text and transparent fill', () => {
  assert.equal(
    isGradientText({
      backgroundImage: EXAMPLE_GRADIENT,
      backgroundClip: 'text',
      webkitTextFillColor: 'rgb(0, 0, 0)',
    }),
    true,
  );
  assert.equal(
    isGradientText({
      backgroundImage: EXAMPLE_GRADIENT,
      backgroundClip: 'border-box',
      webkitTextFillColor: 'rgba(255, 255, 255, 0)',
    }),
    true,
  );
  assert.equal(
    isGradientText({
      backgroundImage: 'none',
      backgroundClip: 'text',
      webkitTextFillColor: 'transparent',
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// s8.4 row 3 - Skips hidden, zero-box, and alpha-0 text elements
// ---------------------------------------------------------------------------

test('dom > skips hidden elements', () => {
  const spans = buildTextSpans([
    rawSpan({ text: 'display none', display: 'none' }),
    rawSpan({ text: 'visibility hidden', visibility: 'hidden' }),
    rawSpan({ text: 'zero box', boxWidth: 0, boxHeight: 0 }),
    rawSpan({ text: 'zero height', boxHeight: 0 }),
    rawSpan({ text: 'alpha zero text', color: 'rgba(248, 250, 252, 0)' }),
    rawSpan({ text: 'transparent text', color: 'transparent' }),
    rawSpan({ text: '   ' }),
    rawSpan({ text: 'kept', color: 'rgba(248, 250, 252, 0.5)' }),
  ]);
  assert.equal(spans.length, 1);
  assert.equal(spans[0]?.text, 'kept');
});

test('dom > transparent color predicate', () => {
  assert.equal(isTransparentColor('transparent'), true);
  assert.equal(isTransparentColor('rgba(0, 0, 0, 0)'), true);
  assert.equal(isTransparentColor('rgba(6, 182, 212, 0)'), true);
  assert.equal(isTransparentColor('rgb(6, 182, 212)'), false);
  assert.equal(isTransparentColor('rgba(6, 182, 212, 0.4)'), false);
  assert.equal(isTransparentColor('rgb(8, 15, 28)'), false);
});

// ---------------------------------------------------------------------------
// Prompt formatting (spec s5.2)
// ---------------------------------------------------------------------------

test('prompt > corpus is priority-ordered with verbatim gradient definitions', () => {
  const spans: TextSpan[] = [
    { text: 'Body paragraph.', color: 'rgb(148, 163, 184)', tag: 'span', parentTag: 'p' },
    { text: 'TECHNOLOGY & AI PARTNER', color: 'rgb(59, 130, 246)', tag: 'span', parentTag: 'h1' },
    { text: 'BUSINESS', color: 'rgb(6, 182, 212)', tag: 'span', parentTag: 'h1', gradient: EXAMPLE_GRADIENT },
    { text: 'Sub heading', color: 'rgb(148, 163, 184)', tag: 'span', parentTag: 'h2' },
  ];

  const prompt = formatTextSpansForPrompt(spans);

  // h1 spans first (document order within rank), then h2, then p.
  const lines = prompt.split('\n').filter((line) => line.includes('[h') || line.includes('[p'));
  assert.match(lines[0] as string, /TECHNOLOGY & AI PARTNER/);
  assert.match(lines[1] as string, /BUSINESS/);
  assert.match(lines[2] as string, /Sub heading/);
  assert.match(lines[3] as string, /Body paragraph\./);
  // Gradient definition embedded verbatim.
  assert.ok(prompt.includes(EXAMPLE_GRADIENT));
  // Verbatim reproduction instruction present.
  assert.ok(prompt.includes('verbatim'));
});

test('prompt > empty corpus reports not captured', () => {
  assert.match(formatTextSpansForPrompt([]), /not captured/);
});

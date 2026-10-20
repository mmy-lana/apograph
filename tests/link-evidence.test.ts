/**
 * Regression tests for link-target and webfont evidence replay
 * (automate-testing-self-fixing.md — Attempt 1 remediation):
 *
 * 1. Text spans capture their nearest anchor's `href` verbatim, and the
 *    prompt formatter renders `[link: ...]` markers so synthesizers reuse
 *    real destinations instead of inventing generic URLs (observed failure:
 *    clone emitted github.com/ + linkedin.com/ homepages and a dead
 *    /resume.pdf link for a button that opens a modal).
 * 2. Cross-origin stylesheet text (Google Fonts et al.) is mined for
 *    `@font-face` webfont evidence with deterministic first-wins merge
 *    (observed failure: computed styles fell back to system fonts because
 *    CDN-hosted @font-face rules were never captured).
 * 3. The interactive-state probe recognizes conventional dialog overlays
 *    (Tailwind z-50 band / viewport-covering fixed layers) — previously it
 *    demanded z-index > 100 and missed standard modals entirely.
 *
 * Fixtures are generic (example.com style URLs, generic CSS) — nothing
 * target-specific.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTextSpans, extractFontTokens, mergeFontTokens } from '../dist/harvester/dom.js';
import type { RawTextSpan } from '../dist/harvester/dom.js';
import { formatMeasuredMetrics, formatTextSpansForPrompt } from '../dist/synthesizer/vision.js';
import type { TextSpan } from '../dist/types.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function rawSpan(overrides: Partial<RawTextSpan> = {}): RawTextSpan {
  return {
    text: 'Hello',
    color: 'rgb(10, 10, 10)',
    backgroundImage: 'none',
    backgroundClip: 'border-box',
    webkitTextFillColor: 'rgb(10, 10, 10)',
    display: 'block',
    visibility: 'visible',
    boxTop: 10,
    boxLeft: 10,
    boxWidth: 100,
    boxHeight: 20,
    tag: 'span',
    parentTag: 'a',
    ...overrides,
  };
}

function span(overrides: Partial<TextSpan> = {}): TextSpan {
  return {
    text: 'Hello',
    color: 'rgb(10, 10, 10)',
    tag: 'span',
    parentTag: 'a',
    boundingBox: { top: 10, left: 10, width: 100, height: 20 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Link-target evidence
// ---------------------------------------------------------------------------

test('link-evidence > buildTextSpans keeps the anchor href verbatim', () => {
  const spans = buildTextSpans([
    rawSpan({ text: 'Profile', href: 'https://example.com/users/ada' }),
    rawSpan({ text: 'Mail', href: 'mailto:ada@example.com' }),
    rawSpan({ text: 'Plain text', href: '' }),
  ]);
  assert.equal(spans[0]?.href, 'https://example.com/users/ada');
  assert.equal(spans[1]?.href, 'mailto:ada@example.com');
  // No anchor → no href key at all (synthesizers must never invent one).
  assert.equal('href' in (spans[2] ?? {}), false);
});

test('link-evidence > prompt corpus marks linked spans and forbids invented links', () => {
  const prompt = formatTextSpansForPrompt([
    span({ text: 'Profile', href: 'https://example.com/users/ada' }),
    span({ text: 'Plain', parentTag: 'button' }),
  ]);

  assert.ok(prompt.includes('[link: https://example.com/users/ada]'), prompt);
  assert.ok(!prompt.includes('[link: ]'));
  // Unlinked text must not carry a marker.
  const plainLine = prompt.split('\n').find((line) => line.includes('Plain'));
  assert.ok(plainLine !== undefined);
  assert.ok(!plainLine.includes('[link:'), plainLine);
  // The contract itself is stated in the prompt.
  assert.match(prompt, /never/i);
});

test('link-evidence > measured metrics surface the computed font family', () => {
  const measured = formatMeasuredMetrics(
    span({ style: { fontSize: '16px', fontFamily: 'Example Sans' } }),
  );
  assert.match(measured, /family Example Sans/);
});

// ---------------------------------------------------------------------------
// 2. Webfont evidence merge (cross-origin stylesheet mining)
// ---------------------------------------------------------------------------

const CDN_FONT_CSS = `
  @font-face {
    font-family: 'Cdn Sans';
    font-style: normal;
    font-weight: 600;
    src: url(https://fonts.example.com/cdn-sans-600.woff2) format('woff2');
  }
`;

test('webfont-merge > mergeFontTokens appends new faces and keeps first-wins dedupe', () => {
  const first = extractFontTokens(`
    @font-face { font-family: 'First'; src: url(https://fonts.example.com/first.woff2); }
  `);
  const base = { fontFaces: [...first.fontFaces], fontVariables: { ...first.fontVariables } };

  mergeFontTokens(base, extractFontTokens(CDN_FONT_CSS));
  mergeFontTokens(base, extractFontTokens(CDN_FONT_CSS)); // duplicate — ignored

  assert.equal(base.fontFaces.length, 2);
  assert.ok(base.fontFaces.some((face) => face.family === 'Cdn Sans' && face.weight === '600'));
  assert.ok(base.fontFaces.some((face) => face.family === 'First'));
});

test('webfont-merge > mergeFontTokens keeps first-wins font variables', () => {
  const base = { fontFaces: [], fontVariables: { '--font-sans': '"First", sans-serif' } };
  mergeFontTokens(base, {
    fontFaces: [],
    fontVariables: { '--font-sans': '"Second", sans-serif', '--font-serif': '"Other", serif' },
  });
  assert.equal(base.fontVariables['--font-sans'], '"First", sans-serif');
  assert.equal(base.fontVariables['--font-serif'], '"Other", serif');
});

test('webfont-merge > extractFontTokens reads CDN stylesheet text', () => {
  const { fontFaces } = extractFontTokens(CDN_FONT_CSS);
  assert.equal(fontFaces.length, 1);
  assert.ok(fontFaces[0]?.src.includes('https://fonts.example.com/cdn-sans-600.woff2'));
});

// ---------------------------------------------------------------------------
// 3. Modal/overlay detection heuristic
// ---------------------------------------------------------------------------

test('overlay-detection > the fixed-layer heuristic accepts conventional dialog bands', async () => {
  const source = await readFile(join(SRC_ROOT, 'src', 'crawler', 'interactions.ts'), 'utf8');

  // The old heuristic demanded z-index > 100 and missed Tailwind z-50
  // dialogs; the replacement accepts elevated layers (>= 30) or fixed
  // layers covering most of the viewport.
  assert.ok(!source.includes('zIndex <= 100'), 'legacy z-index>100 gate must be gone');
  assert.ok(source.includes('zIndex >= 30'), 'elevated-layer gate must be present');
  assert.ok(source.includes('coversViewport'), 'viewport-coverage fallback must be present');
});

test('overlay-detection > the probe still marks before/after overlays for the diff', async () => {
  const source = await readFile(join(SRC_ROOT, 'src', 'crawler', 'interactions.ts'), 'utf8');
  assert.ok(source.includes('markExistingOverlays'));
  assert.ok(source.includes('collectNewOverlays'));
  assert.ok(source.includes('data-apograph-overlay-seen'));
});

// ---------------------------------------------------------------------------
// 4. Source wiring invariants (generic, no target strings)
// ---------------------------------------------------------------------------

test('link-evidence > collectRawTextSpans captures hrefs through a self-contained helper', async () => {
  const source = await readFile(join(SRC_ROOT, 'src', 'harvester', 'dom.ts'), 'utf8');
  assert.ok(source.includes('const anchorHref'), 'anchor lookup must live inside the collector');
  assert.ok(source.includes('href: anchorHref(element)'));
});

test('webfont-merge > extractDesignTokens mines remote stylesheets through an injected fetcher', async () => {
  const source = await readFile(join(SRC_ROOT, 'src', 'harvester', 'dom.ts'), 'utf8');
  assert.ok(source.includes('fetchStylesheetText'));
  assert.ok(source.includes('collectUnreadableStylesheetHrefs'));
  assert.ok(source.includes('mergeFontTokens(fontTokens, extractFontTokens(text))'));
});

test('webfont-merge > extractDesignTokens folds fetched font evidence into tokens', async () => {
  const { extractDesignTokens } = await import('../dist/harvester/dom.js');
  const calls: string[] = [];

  // Minimal fake Page: evaluate dispatches on the in-page function's name.
  const fakePage = {
    evaluate: async (fn: { name?: string }): Promise<unknown> => {
      switch (fn?.name) {
        case 'collectCssText':
          return 'body { color: #101010; }';
        case 'collectBodyComputedStyle':
          return { backgroundColor: 'rgb(255, 255, 255)', color: 'rgb(0, 0, 0)' };
        case 'collectUnreadableStylesheetHrefs':
          return ['https://fonts.example.com/cdn.css'];
        default:
          return null;
      }
    },
  };

  const tokens = await extractDesignTokens(fakePage as never, {
    fetchStylesheetText: async (url: string) => {
      calls.push(url);
      return CDN_FONT_CSS;
    },
  });

  assert.deepEqual(calls, ['https://fonts.example.com/cdn.css']);
  assert.ok(tokens.fontFaces?.some((face) => face.family === 'Cdn Sans'));
});

test('webfont-merge > extractDesignTokens survives fetch failures and caps remote sheets', async () => {
  const { extractDesignTokens } = await import('../dist/harvester/dom.js');
  const fakePage = {
    evaluate: async (fn: { name?: string }): Promise<unknown> => {
      switch (fn?.name) {
        case 'collectCssText':
          return '';
        case 'collectBodyComputedStyle':
          return { backgroundColor: 'rgb(255, 255, 255)', color: 'rgb(0, 0, 0)' };
        case 'collectUnreadableStylesheetHrefs':
          return ['https://a.example.com/x.css', 'https://b.example.com/x.css'];
        default:
          return null;
      }
    },
  };

  const calls: string[] = [];
  const tokens = await extractDesignTokens(fakePage as never, {
    maxRemoteStylesheets: 1,
    fetchStylesheetText: async (url: string) => {
      calls.push(url);
      return null; // failure tolerated
    },
  });

  assert.deepEqual(calls, ['https://a.example.com/x.css'], 'honor the remote stylesheet cap');
  assert.equal(tokens.fontFaces, undefined);
});

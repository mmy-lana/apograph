/**
 * Regression tests for the webfont replay capability:
 *
 * 1. The harvester captures `@font-face` rules and font custom properties
 *    from readable stylesheets as evidence tokens (generic for any site).
 * 2. The deterministic `src/index.css` generator replays captured webfonts
 *    (verbatim `@font-face` rules + captured `--font-sans` / `--font-mono`
 *    stacks) and invents nothing when no evidence was captured.
 * 3. Route-level evidence aggregates deterministically (first wins).
 *
 * Motivated by the verified typography defect in automate-testing-self-fixing.md
 * (source sites loading webfonts while generated projects rendered fallback
 * system fonts). No site-specific constants appear in shared source.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractFontTokens } from '../dist/harvester/dom.js';
import { collectWebFonts, generateIndexCss } from '../dist/synthesizer/modular.js';

const EMPTY_DESIGN_SYSTEM = { colors: {}, fonts: [], spacing: [], radii: [] };

const SAMPLE_CSS = `
  @font-face {
    font-family: 'Inter';
    font-style: normal;
    font-weight: 400;
    font-display: swap;
    src: url(https://fonts.example.com/inter-400.woff2) format('woff2');
  }
  @font-face {
    font-family: "Example Mono";
    font-style: normal;
    font-weight: 700;
    src: url(https://fonts.example.com/mono-700.woff2) format('woff2');
  }
  :root {
    --font-sans: "Inter", system-ui, sans-serif;
    --font-mono: "Example Mono", monospace;
    --color-primary: #123456;
  }
  body { font-family: var(--font-sans); }
`;

test('font-replay > harvester extracts font-face rules and font variables', () => {
  const { fontFaces, fontVariables } = extractFontTokens(SAMPLE_CSS);

  assert.equal(fontFaces.length, 2);
  const inter = fontFaces.find((face) => face.family === 'Inter');
  assert.ok(inter !== undefined);
  assert.equal(inter.weight, '400');
  assert.equal(inter.style, 'normal');
  assert.ok(inter.src.includes('inter-400.woff2'));
  assert.ok(fontFaces.some((face) => face.family === 'Example Mono' && face.weight === '700'));

  assert.equal(fontVariables['--font-sans'], '"Inter",system-ui,sans-serif');
  assert.equal(fontVariables['--font-mono'], '"Example Mono",monospace');
  // Non-font custom properties are not captured.
  assert.ok(!('--color-primary' in fontVariables));
});

test('font-replay > harvester dedupes identical font-face rules', () => {
  const { fontFaces } = extractFontTokens(`${SAMPLE_CSS}\n${SAMPLE_CSS}`);
  assert.equal(fontFaces.length, 2);
});

test('font-replay > index.css replays captured webfonts and font stacks', () => {
  const { fontFaces, fontVariables } = extractFontTokens(SAMPLE_CSS);
  const css = generateIndexCss(EMPTY_DESIGN_SYSTEM, '#ffffff', { fontFaces, fontVariables });

  // Verbatim @font-face replay (family, src, descriptors, swap display).
  assert.ok(css.includes("@font-face {"));
  assert.ok(css.includes("font-family: 'Inter';"));
  assert.ok(css.includes('src: url(https://fonts.example.com/inter-400.woff2) format(\'woff2\');'));
  assert.ok(css.includes('font-display: swap;'));
  assert.ok(css.includes('font-weight: 700;'));

  // Captured stacks land on the Tailwind theme.
  assert.ok(css.includes('--font-sans: "Inter",system-ui,sans-serif;'));
  assert.ok(css.includes('--font-mono: "Example Mono",monospace;'));

  // @import stays first so Tailwind v4 processes the file.
  assert.ok(css.indexOf('@import "tailwindcss";') < css.indexOf('@font-face'));
});

test('font-replay > index.css invents nothing without captured evidence', () => {
  const css = generateIndexCss(EMPTY_DESIGN_SYSTEM, '#ffffff');
  assert.ok(!css.includes('@font-face'));
  assert.ok(!css.includes('--font-sans'));
  assert.ok(!css.includes('--font-mono'));
});

test('font-replay > index-css derives stacks from captured faces and skips var() noise', () => {
  const css = generateIndexCss(
    { colors: {}, fonts: ['var(--default-font-family, ui-sans-serif'], spacing: [], radii: [] },
    '#ffffff',
    {
      fontFaces: [
        { family: 'Only Mono', src: 'url(https://fonts.example.com/only.woff2) format("woff2")' },
      ],
    },
  );
  // Mono-only evidence maps to --font-mono; nothing guessed for --font-sans.
  assert.ok(css.includes("--font-mono: 'Only Mono', monospace;"));
  assert.ok(!css.includes('--font-sans'));
  // Unresolvable var(...) font tokens never become theme families.
  assert.ok(!css.includes('--font-apograph-0'));
});

test('font-replay > route evidence aggregates with deterministic first-wins dedupe', () => {
  const face = { family: 'Inter', src: 'url(https://fonts.example.com/i.woff2)', weight: '400' };
  const aggregated = collectWebFonts([
    { tokens: { colors: {}, fonts: [], spacing: [], radii: [], fontFaces: [face], fontVariables: { '--font-sans': '"Inter", sans-serif' } } },
    { tokens: { colors: {}, fonts: [], spacing: [], radii: [], fontFaces: [face], fontVariables: { '--font-sans': '"Other", sans-serif' } } },
    { tokens: { colors: {}, fonts: [], spacing: [], radii: [] } },
  ]);
  assert.equal(aggregated.fontFaces.length, 1);
  assert.equal(aggregated.fontVariables['--font-sans'], '"Inter", sans-serif');
});

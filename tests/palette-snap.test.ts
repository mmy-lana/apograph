/**
 * Regression tests for the captured-evidence palette snap (deterministic
 * synthesis output normalization):
 *
 * 1. CSS color-literal parsing (hex 3/4/6/8, rgb/rgba with `,` and `/` alpha
 *    separators, percent channels) and rejection of unsupported forms.
 * 2. Snap behavior: tight approximations snap to captured colors, exact and
 *    genuinely distinct colors are left untouched.
 * 3. Rewrite safety: alpha values and separator spacing are preserved
 *    byte-for-byte (Tailwind arbitrary values forbid spaces).
 * 4. Evidence palette construction and dedupe from a synthetic manifest.
 * 5. Source/project-wide snapping counts and file filtering.
 *
 * spec: automate-testing-self-fixing.md remediation record #10 (Experiment 4).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_COLOR_SNAP_DISTANCE,
  buildEvidencePalette,
  colorDistance,
  findSnapTarget,
  parseCssColor,
  rgbToHex,
  snapColorLiteral,
  snapColorsInSource,
  snapProjectColors,
} from '../dist/synthesizer/paletteSnap.js';
import type { CrawlRoute, ProjectFile } from '../dist/types.js';

function route(overrides: Partial<CrawlRoute>): CrawlRoute {
  return {
    url: 'https://example.com/',
    path: '/',
    title: 'Example',
    desktopScreenshot: 'screenshots/index-desktop.png',
    mobileScreenshot: 'screenshots/index-mobile.png',
    a11yTree: { role: 'generic' },
    tokens: { colors: {}, fonts: [], spacing: [], radii: [] },
    ...overrides,
  };
}

const CYAN = { r: 0, g: 240, b: 255 };

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('palette-snap > parses hex and rgb/rgba literals with verbatim alpha', () => {
  assert.deepEqual(parseCssColor('#00f3ff')?.rgb, { r: 0, g: 243, b: 255 });
  assert.equal(parseCssColor('#00f3ff')?.alphaText, undefined);
  // Shorthand expands; alpha stays two hex digits for safe rewriting.
  assert.deepEqual(parseCssColor('#0f38')?.rgb, { r: 0, g: 255, b: 51 });
  assert.equal(parseCssColor('#0f38')?.alphaText, '88');
  assert.equal(parseCssColor('#00f3ff80')?.alphaText, '80');
  assert.deepEqual(parseCssColor('rgba(0,243,255,.3)')?.rgb, { r: 0, g: 243, b: 255 });
  assert.equal(parseCssColor('rgba(0,243,255,.3)')?.alphaText, ',.3');
  assert.equal(parseCssColor('rgb(0, 240, 255 / 50%)')?.alphaText, ' / 50%');
  assert.deepEqual(parseCssColor('rgb(100%, 0%, 50%)')?.rgb, { r: 255, g: 0, b: 128 });
});

test('palette-snap > rejects unsupported color forms', () => {
  assert.equal(parseCssColor('red'), undefined);
  assert.equal(parseCssColor('hsl(180, 100%, 50%)'), undefined);
  assert.equal(parseCssColor('color-mix(in srgb, red, blue)'), undefined);
  assert.equal(parseCssColor('rgb(from red r g b)'), undefined);
  assert.equal(parseCssColor('#12345'), undefined);
  assert.equal(parseCssColor('rgb(1 2 3)'), undefined);
});

// ---------------------------------------------------------------------------
// Snap behavior
// ---------------------------------------------------------------------------

test('palette-snap > tight approximations snap; exact and distinct hues do not', () => {
  const palette = [CYAN, { r: 3, g: 7, b: 18 }];
  // The documented drift pair: model approximation -> captured value.
  assert.equal(snapColorLiteral('#00f3ff', palette), '#00f0ff');
  assert.equal(snapColorLiteral('#050713', palette), '#030712');
  // Exact captured color: untouched (no rewrite churn).
  assert.equal(snapColorLiteral('#00f0ff', palette), undefined);
  // Genuinely distinct hue far outside the snap bound: untouched.
  assert.equal(snapColorLiteral('#145dff', palette), undefined);
  assert.equal(colorDistance({ r: 20, g: 93, b: 255 }, { r: 37, g: 99, b: 235 }) > MAX_COLOR_SNAP_DISTANCE, true);
});

test('palette-snap > rewrites preserve alpha and separator spacing', () => {
  const palette = [CYAN];
  // Tailwind arbitrary values forbid spaces: `rgba(0,243,255,.3)` must keep
  // its exact separator style.
  assert.equal(snapColorLiteral('rgba(0,243,255,.3)', palette), 'rgba(0,240,255,.3)');
  assert.equal(snapColorLiteral('rgba(0, 243, 255, .3)', palette), 'rgba(0, 240, 255, .3)');
  assert.equal(snapColorLiteral('rgb(0,243,255 / 50%)', palette), 'rgb(0,240,255 / 50%)');
  assert.equal(snapColorLiteral('rgb(0, 243, 255)', palette), 'rgb(0, 240, 255)');
  // Hex alpha suffix preserved.
  assert.equal(snapColorLiteral('#00f3ff80', palette), '#00f0ff80');
});

test('palette-snap > nearest palette color wins within the bound', () => {
  const palette = [{ r: 200, g: 200, b: 200 }, { r: 100, g: 100, b: 100 }];
  assert.equal(snapColorLiteral('#656565', palette), '#646464');
  assert.equal(snapColorLiteral('#c6c6c6', palette), '#c8c8c8');
  const target = findSnapTarget({ r: 101, g: 101, b: 101 }, palette);
  assert.deepEqual(target?.color, { r: 100, g: 100, b: 100 });
  assert.equal(findSnapTarget({ r: 150, g: 150, b: 150 }, palette), undefined);
});

// ---------------------------------------------------------------------------
// Evidence palette construction
// ---------------------------------------------------------------------------

test('palette-snap > evidence palette aggregates tokens, canvas, and span colors', () => {
  const routes = [
    route({
      path: '/',
      tokens: {
        colors: { 'a:#00f0ff': '#00f0ff', 'b:rgb(3, 7, 18)': 'rgb(3, 7, 18)', 'c:color-mix(in srgb, red, blue)': 'color-mix(in srgb, red, blue)' },
        fonts: [],
        spacing: [],
        radii: [],
        canvas: { backgroundColor: '#030712', color: 'rgb(255, 255, 255)' },
      },
      textSpans: [
        { text: 'a', color: 'rgb(0, 240, 255)', tag: 'span', parentTag: 'p' },
        { text: 'b', color: 'not-a-color', tag: 'span', parentTag: 'p' },
      ],
    }),
    route({
      path: '/other',
      textSpans: [{ text: 'c', color: '#00f0ff', tag: 'span', parentTag: 'p' }],
      mobileTextSpans: [{ text: 'd', color: 'rgba(9, 9, 18, .7)', tag: 'span', parentTag: 'p' }],
    }),
  ];
  const palette = buildEvidencePalette(routes);
  const hexes = palette.map(rgbToHex).sort();
  // Deduped: #00f0ff (token + span + other route), #030712 (token + canvas),
  // #ffffff (canvas fg), #090912 (span, alpha ignored); junk filtered.
  assert.deepEqual(hexes, ['00f0ff', '030712', '090912', 'ffffff']);
});

// ---------------------------------------------------------------------------
// Source and project snapping
// ---------------------------------------------------------------------------

test('palette-snap > snaps every literal in a source text and counts replacements', () => {
  const palette = [CYAN, { r: 3, g: 7, b: 18 }];
  const source = [
    'const a = "text-[#00f3ff]";',
    'const b = "bg-[rgba(0,243,255,.3)]";',
    'const c = "#00f0ff"; // exact, untouched',
    'const d = "#145dff"; // distinct hue, untouched',
  ].join('\n');
  const result = snapColorsInSource(source, palette);
  assert.equal(result.replacements, 2);
  assert.ok(result.content.includes('text-[#00f0ff]'));
  assert.ok(result.content.includes('bg-[rgba(0,240,255,.3)]'));
  assert.ok(result.content.includes('const c = "#00f0ff";'));
  assert.ok(result.content.includes('const d = "#145dff";'));
});

test('palette-snap > project snapping filters files by extension', () => {
  const palette = [CYAN];
  const files: ProjectFile[] = [
    { path: 'src/App.tsx', content: 'const x = "#00f3ff";' },
    { path: 'src/index.css', content: '.a { color: #00f3ff; }' },
    { path: 'package.json', content: '{ "x": "#00f3ff" }' },
    { path: 'src/notes.md', content: '#00f3ff' },
  ];
  const result = snapProjectColors(files, palette);
  assert.equal(result.replacements, 2);
  assert.equal(result.files[0]?.content, 'const x = "#00f0ff";');
  assert.equal(result.files[1]?.content, '.a { color: #00f0ff; }');
  // Non-source files are never touched.
  assert.equal(result.files[2]?.content, '{ "x": "#00f3ff" }');
  assert.equal(result.files[3]?.content, '#00f3ff');
});

/**
 * Unit tests for canvas theme extraction, dynamic background resolution, and
 * reduced-palette prompt generation.
 *
 * spec: integration/visual-resilience s8.3
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeColorToHex } from '../dist/harvester/dom.js';
import {
  generateAppTsx,
  generateFooterTemplate,
  generateIndexCss,
  generateNavbarTemplate,
  isDarkCanvasColor,
  resolveDominantCanvas,
} from '../dist/synthesizer/modular.js';
import {
  MAX_PROMPT_COLORS,
  formatTokensForVisionPrompt,
} from '../dist/synthesizer/vision.js';
import type { DesignTokens } from '../dist/types.js';
import type { ApographPlan, PlanRoute } from '../dist/plan/schema.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Builds a DesignTokens record with an optional canvas theme. */
function tokensWith(
  canvas?: { backgroundColor: string; color?: string },
  colorCount = 3,
): DesignTokens {
  const colors: Record<string, string> = {};
  for (let i = 0; i < colorCount; i++) {
    colors[`background-color:shade-${i}`] = `#0000${i.toString(16).padStart(2, '0')}`;
  }
  return {
    colors,
    fonts: ['Inter, sans-serif'],
    spacing: ['1rem'],
    radii: ['0.5rem'],
    ...(canvas !== undefined ? { canvas } : {}),
  };
}

function routeWith(tokens: DesignTokens): { tokens: DesignTokens } {
  return { tokens };
}

function makePlan(designSystem: ApographPlan['designSystem']): ApographPlan {
  const route: PlanRoute = {
    path: '/',
    title: 'Home',
    componentName: 'HomePage',
    included: true,
    inferredInteractions: ['none'],
  };
  return {
    targetUrl: 'https://example.com/',
    appName: 'Example',
    stack: 'react-vite-tailwind',
    version: 1,
    approved: true,
    routes: [route],
    designSystem,
    assumptions: [],
    unknowns: [],
  };
}

// ---------------------------------------------------------------------------
// s8.3 row 1 - Extracts computed body background
// ---------------------------------------------------------------------------

test('theme > extracts computed body background', () => {
  // rgb() normalization to canonical #rrggbb (Nirantara canvas).
  assert.equal(normalizeColorToHex('rgb(8, 15, 28)'), '#080f1c');
  assert.equal(normalizeColorToHex('rgba(8, 15, 28, 1)'), '#080f1c');
  // Case and shorthand normalization.
  assert.equal(normalizeColorToHex('#080F1C'), '#080f1c');
  assert.equal(normalizeColorToHex('#fff'), '#ffffff');
  // Transparent and garbage values are rejected, not guessed.
  assert.equal(normalizeColorToHex('rgba(0, 0, 0, 0)'), null);
  assert.equal(normalizeColorToHex('transparent'), null);
  assert.equal(normalizeColorToHex('not-a-color'), null);
});

test('theme > canvas lands on harvested route tokens', () => {
  const tokens = tokensWith({ backgroundColor: '#080f1c', color: '#f8fafc' });
  assert.equal(tokens.canvas?.backgroundColor, '#080f1c');
  assert.equal(tokens.canvas?.color, '#f8fafc');
});

test('theme > dark canvas detection by luminance', () => {
  assert.equal(isDarkCanvasColor('#080f1c'), true);
  assert.equal(isDarkCanvasColor('#ffffff'), false);
  assert.equal(isDarkCanvasColor('not-a-color'), false);
});

// ---------------------------------------------------------------------------
// s8.3 row 2 - Dominant canvas wins across frames (blank frames ignored)
// ---------------------------------------------------------------------------

test('theme > dominant canvas wins across frames', () => {
  const routes = [
    routeWith(tokensWith({ backgroundColor: '#080f1c' })),
    routeWith(tokensWith({ backgroundColor: '#080f1c' })),
    routeWith(tokensWith({ backgroundColor: '#101828' })),
  ];
  assert.equal(resolveDominantCanvas(routes), '#080f1c');
});

test('theme > frames without canvas (blank) are ignored', () => {
  const routes = [
    routeWith(tokensWith()), // no canvas: blank / legacy frame
    routeWith(tokensWith()),
    routeWith(tokensWith({ backgroundColor: '#080f1c' })),
  ];
  assert.equal(resolveDominantCanvas(routes), '#080f1c');
});

test('theme > no captured canvas falls back to white', () => {
  const routes = [routeWith(tokensWith()), routeWith(tokensWith())];
  assert.equal(resolveDominantCanvas(routes), '#ffffff');
});

// ---------------------------------------------------------------------------
// s8.3 rows 3-4 - Templates emit no hardcoded light wrappers
// ---------------------------------------------------------------------------

test('templates > App shell emits no hardcoded light wrapper', () => {
  const appTsx = generateAppTsx(makePlan(tokensWith() as unknown as ApographPlan['designSystem']));
  assert.ok(!appTsx.includes('bg-white'), 'App.tsx must not hardcode bg-white');
  assert.ok(!appTsx.includes('text-neutral-900'), 'App.tsx must not hardcode text-neutral-900');
  assert.ok(appTsx.includes('bg-background'), 'App shell must apply the canvas token');
  assert.ok(appTsx.includes('text-foreground'), 'App shell must use the foreground token');
});

test('templates > index.css background is dynamic', () => {
  const css = generateIndexCss(
    { colors: {}, fonts: [], spacing: [], radii: [] },
    '#080f1c',
  );
  assert.ok(css.includes('--color-background: #080f1c'));
  assert.ok(!css.includes('--color-background: #ffffff'));
  // Foreground flips light on a dark canvas.
  assert.ok(css.includes('--color-foreground: #f8fafc'));
});

test('templates > index.css keeps white only for a genuinely light source', () => {
  const css = generateIndexCss(
    { colors: {}, fonts: [], spacing: [], radii: [] },
    '#ffffff',
  );
  assert.ok(css.includes('--color-background: #ffffff'));
  assert.ok(css.includes('--color-foreground: #171717'));
});

test('templates > Navbar emits no hardcoded light assumptions', () => {
  const navbar = generateNavbarTemplate('Example', [
    { path: '/', title: 'Home', componentName: 'HomePage', included: true, inferredInteractions: ['none'] },
  ]);
  assert.ok(!navbar.includes('bg-white'), 'Navbar must not hardcode bg-white');
  assert.ok(!navbar.includes('border-neutral-200'));
  assert.ok(!navbar.includes('bg-neutral-100'));
  assert.ok(navbar.includes('bg-background/80'));
  assert.ok(navbar.includes('border-border'));
});

test('templates > Footer emits no hardcoded light assumptions', () => {
  const footer = generateFooterTemplate('Example', [
    { path: '/', title: 'Home', componentName: 'HomePage', included: true, inferredInteractions: ['none'] },
  ]);
  assert.ok(!footer.includes('bg-neutral-50'));
  assert.ok(!footer.includes('border-neutral-200'));
  assert.ok(!footer.includes('text-neutral-500'));
  assert.ok(footer.includes('border-border'));
});

// ---------------------------------------------------------------------------
// s8.3 row 5 - Prompt payload uses a reduced palette
// ---------------------------------------------------------------------------

test('prompt > palette is reduced to at most 24 colors', () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < 300; i++) {
    many[`background-color:c${i}`] = `#${(i % 4096).toString(16).padStart(6, '0')}`;
  }
  const tokens: DesignTokens = {
    colors: many,
    fonts: [],
    spacing: [],
    radii: [],
    canvas: { backgroundColor: '#080f1c' },
  };

  const prompt = formatTokensForVisionPrompt(tokens);

  // No --color-apograph-* enumeration anywhere in the payload.
  assert.ok(!prompt.includes('--color-apograph-'));
  // At most MAX_PROMPT_COLORS hex values are listed inside the palette block.
  const paletteBlock = prompt.slice(prompt.indexOf('Reduced palette'));
  const listed = paletteBlock.match(/#[0-9a-f]{6}/g) ?? [];
  assert.ok(listed.length <= MAX_PROMPT_COLORS);
  // Canvas color is surfaced explicitly.
  assert.ok(prompt.includes('#080f1c'));
  // Omission is noted so the model knows to pull hues from screenshots.
  assert.ok(prompt.includes('omitted'));
});

test('prompt > small palette is fully included without omission note', () => {
  const prompt = formatTokensForVisionPrompt(tokensWith({ backgroundColor: '#ffffff' }, 3));
  assert.ok(!prompt.includes('omitted'));
  assert.ok(prompt.includes('Canvas background: #ffffff'));
});

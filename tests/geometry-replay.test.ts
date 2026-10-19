/**
 * Regression tests for measured rendered-geometry replay (generated-project
 * capability):
 *
 * 1. Pure rule building: single-line measured spans enforce nowrap, multi-line
 *    spans enforce their measured wrap width, text-transform is always pinned
 *    (measured value or `none`).
 * 2. Per-viewport rule attribution from the evidence manifest.
 * 3. Rule matching precedence: exact > case-folded > longest contained.
 * 4. The generated module is real, importable code whose matching behaves the
 *    same as the shared pure implementation.
 * 5. Producer source invariants: synthesis emits the module when evidence
 *    exists, wires it into main.tsx, and the TEXT FIDELITY contract honors
 *    measured text-transform.
 *
 * spec: automate-testing-self-fixing.md remediation record #7 (Experiment 3).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildMeasuredRule,
  buildReplayGroups,
  generateGeometryReplayModule,
  isBoxCompatible,
  selectMeasuredRule,
  selectTextSnapTarget,
} from '../dist/synthesizer/geometryReplay.js';
import type { CrawlRoute, TextSpan } from '../dist/types.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function span(overrides: Partial<TextSpan>): TextSpan {
  return {
    text: 'Hello world',
    color: 'rgb(248, 250, 252)',
    tag: 'span',
    parentTag: 'p',
    ...overrides,
  };
}

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

// ---------------------------------------------------------------------------
// Pure rule building
// ---------------------------------------------------------------------------

test('geometry-replay > single-line spans enforce nowrap and pin text-transform', () => {
  const rule = buildMeasuredRule(
    span({
      text: 'PRESET: NEON NIGHT',
      style: {
        fontSize: '10px',
        fontWeight: '700',
        lineHeight: '15px',
        letterSpacing: '0.5px',
        textTransform: 'uppercase',
      },
      boundingBox: { top: 143, left: 79, width: 117, height: 15 },
    }),
  );
  assert.equal(rule?.nowrap, true);
  assert.equal(rule?.width, undefined);
  assert.equal(rule?.top, 143);
  assert.equal(rule?.style.fs, '10px');
  assert.equal(rule?.style.ls, '0.5px');
  assert.equal(rule?.style.tt, 'uppercase');
});

test('geometry-replay > multi-line spans enforce measured wrap width', () => {
  const rule = buildMeasuredRule(
    span({
      text: 'A long paragraph that wraps across several lines.',
      style: { fontSize: '14px', fontWeight: '400', lineHeight: '22.75px' },
      boundingBox: { top: 298, left: 56, width: 277.4, height: 295.75 },
    }),
  );
  assert.equal(rule?.width, 277.4);
  assert.equal(rule?.nowrap, undefined);
  assert.equal(rule?.top, 298);
  // No measured transform pins `none` so invented casing is corrected too.
  assert.equal(rule?.style.tt, 'none');
});

test('geometry-replay > spans without metrics or box produce no rule', () => {
  assert.equal(buildMeasuredRule(span({})), undefined);
});

// ---------------------------------------------------------------------------
// Per-viewport attribution
// ---------------------------------------------------------------------------

test('geometry-replay > rule groups attribute spans to the measured viewport', () => {
  const routes: CrawlRoute[] = [
    route({
      path: '/page',
      textSpans: [span({ text: 'Desktop span', style: { fontSize: '48px' }, boundingBox: { top: 1, left: 1, width: 580, height: 48 } })],
      mobileTextSpans: [span({ text: 'Mobile span', style: { fontSize: '30px' }, boundingBox: { top: 2, left: 2, width: 277, height: 72 } })],
    }),
    route({
      path: '/mobile-only',
      desktopScreenshot: null,
      mobileScreenshot: 'screenshots/m.png',
      textSpans: [span({ text: 'Mobile-only span', style: { fontSize: '20px' }, boundingBox: { top: 3, left: 3, width: 100, height: 24 } })],
    }),
    route({ path: '/bare' }),
  ];

  const groups = buildReplayGroups(routes);
  assert.deepEqual(Object.keys(groups).sort(), ['/mobile-only', '/page']);
  assert.equal(groups['/page']?.d[0]?.text, 'Desktop span');
  assert.equal(groups['/page']?.m[0]?.text, 'Mobile span');
  // Mobile-only crawl: the primary corpus is mobile-measured.
  assert.equal(groups['/mobile-only']?.m[0]?.text, 'Mobile-only span');
  assert.equal(groups['/mobile-only']?.d.length, 0);
});

// ---------------------------------------------------------------------------
// Matching precedence
// ---------------------------------------------------------------------------

test('geometry-replay > matching precedence exact > folded > longest contained', () => {
  const rules = [
    buildMeasuredRule(span({ text: '>', style: { fontSize: '20px' } }))!,
    buildMeasuredRule(span({ text: 'Frontend Developer', style: { fontSize: '20px' } }))!,
    buildMeasuredRule(span({ text: 'FRONTEND DEVELOPER', style: { fontSize: '18px' } }))!,
    buildMeasuredRule(span({ text: 'PRESET: NEON NIGHT', style: { fontSize: '10px' } }))!,
  ];

  // Exact match wins over everything.
  assert.equal(selectMeasuredRule(rules, 'PRESET: NEON NIGHT', new Set())?.style.fs, '10px');
  // Case-folded equality beats containment (first in corpus order wins).
  assert.equal(selectMeasuredRule(rules, 'frontend developer', new Set())?.style.fs, '20px');
  // Containment picks the first-longest rule in corpus order.
  assert.equal(selectMeasuredRule(rules, '> FRONTEND DEVELOPER', new Set())?.style.fs, '20px');
  // Short rules (< 4 chars) never match by containment.
  assert.equal(selectMeasuredRule(rules, 'Some > random text', new Set()), undefined);
  // Claimed rules are skipped so duplicates match successive elements.
  const first = selectMeasuredRule(rules, 'PRESET: NEON NIGHT', new Set())!;
  const claimed = new Set([first]);
  assert.notEqual(selectMeasuredRule(rules, 'PRESET: NEON NIGHT', claimed), first);
});

// ---------------------------------------------------------------------------
// Generated module is real, importable code
// ---------------------------------------------------------------------------

test('geometry-replay > generated module imports and matches like the pure implementation', async () => {
  assert.equal(generateGeometryReplayModule([route({})]), null);

  const file = generateGeometryReplayModule([
    route({
      path: '/cyberpunk',
      textSpans: [span({ text: 'Hero name', style: { fontSize: '48px', fontWeight: '900' }, boundingBox: { top: 1, left: 1, width: 580, height: 48 } })],
      mobileTextSpans: [span({ text: 'Hero name', style: { fontSize: '30px', fontWeight: '900' }, boundingBox: { top: 2, left: 2, width: 277, height: 72 } })],
    }),
  ]);
  assert.ok(file !== null);
  assert.equal(file?.path, 'src/geometry-replay.ts');
  assert.ok(file?.content.includes('installGeometryReplay'));
  assert.ok(file?.content.includes('Hero name'));
  // Vertical rhythm snap: measured tops enforced via margin-top adjustments.
  assert.ok(file?.content.includes("'margin-top'"));
  assert.ok(file?.content.includes('getBoundingClientRect'));

  const dir = await mkdtemp(join(tmpdir(), 'apograph-geometry-'));
  try {
    const modulePath = join(dir, 'geometry-replay.mjs');
    await writeFile(modulePath, file?.content ?? '', 'utf8');
    const generated = await import(pathToFileURL(modulePath).href);
    assert.equal(typeof generated.installGeometryReplay, 'function');
    assert.equal(typeof generated.matchRule, 'function');
    assert.equal(typeof generated.applyMeasuredGeometryPass, 'function');
    assert.ok(generated.RULE_GROUPS['/cyberpunk'] !== undefined);
    // Generated matcher behaves like the shared pure implementation.
    const rules = generated.RULE_GROUPS['/cyberpunk'].m;
    assert.equal(generated.matchRule(rules, 'Hero name', new Set()).style.fs, '30px');
    assert.equal(generated.matchRule(rules, 'HERO NAME', new Set()).style.fs, '30px');
    assert.equal(generated.matchRule(rules, 'nothing alike', new Set()), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Producer source invariants
// ---------------------------------------------------------------------------

test('geometry-replay > synthesis emits and installs the replay module', async () => {
  const modularText = await readFile(join(SRC_ROOT, 'src', 'synthesizer', 'modular.ts'), 'utf8');
  assert.ok(modularText.includes('generateGeometryReplayModule(manifest.routes)'));
  assert.ok(modularText.includes('generateMainTsx(geometryReplay !== null)'));
  assert.ok(modularText.includes("installGeometryReplay } from './geometry-replay'"));
  assert.ok(modularText.includes('installGeometryReplay();'));
});

test('geometry-replay > TEXT FIDELITY contract honors measured text-transform', async () => {
  const modularText = await readFile(join(SRC_ROOT, 'src', 'synthesizer', 'modular.ts'), 'utf8');
  assert.ok(modularText.includes('computed text-transform'));
  // Historical pinned markers must survive the contract correction.
  assert.ok(modularText.split('casing preserved AS RENDERED').length - 1 >= 2);
  assert.ok(modularText.includes('Do not decorate spans with'));
});

// ---------------------------------------------------------------------------
// Corpus text verbatim snap (remediation record #11)
// ---------------------------------------------------------------------------

test('geometry-replay > text snap replaces decorated variants with corpus text', () => {
  // Invented decorative prefix (the reproduced /cyberpunk chip defect).
  assert.equal(
    selectTextSnapTarget('● PRESET: NEON NIGHT', 'PRESET: NEON NIGHT'),
    'PRESET: NEON NIGHT',
  );
  // Swapped bullet glyph around corpus text snaps back to the corpus form.
  assert.equal(
    selectTextSnapTarget('● PRESET: NEON NIGHT', '• PRESET: NEON NIGHT'),
    '• PRESET: NEON NIGHT',
  );
  // Whitespace/punctuation drift normalizes to the corpus string.
  assert.equal(selectTextSnapTarget('Hello,  world!', 'Hello world'), 'Hello world');
});

test('geometry-replay > text snap never clobbers wrapper text or equal text', () => {
  // Contained rule with surrounding words: the element is left untouched.
  assert.equal(selectTextSnapTarget('NEW PRESET: NEON NIGHT SALE', 'PRESET: NEON NIGHT'), undefined);
  // Already verbatim: no rewrite.
  assert.equal(selectTextSnapTarget('PRESET: NEON NIGHT', 'PRESET: NEON NIGHT'), undefined);
  // Empty corpus text can never snap.
  assert.equal(selectTextSnapTarget('anything', ''), undefined);
  // Symbol-only strings never snap (unrelated glyphs are distinct text).
  assert.equal(selectTextSnapTarget('●', '•'), undefined);
  assert.equal(selectTextSnapTarget('→', '•'), undefined);
});

test('geometry-replay > generated module exposes and applies the text snap', async () => {
  const file = generateGeometryReplayModule([
    route({
      path: '/cyberpunk',
      textSpans: [span({ text: 'PRESET: NEON NIGHT', style: { fontSize: '10px' }, boundingBox: { top: 1, left: 1, width: 117, height: 15 } })],
    }),
  ]);
  assert.ok(file !== null);
  assert.ok(file?.content.includes('selectTextSnapTarget'));
  assert.ok(file?.content.includes('isTextOnly'));
  assert.ok(file?.content.includes('element.textContent = snap'));

  const dir = await mkdtemp(join(tmpdir(), 'apograph-geometry-'));
  try {
    const modulePath = join(dir, 'geometry-replay.mjs');
    await writeFile(modulePath, file?.content ?? '', 'utf8');
    const generated = await import(pathToFileURL(modulePath).href);
    assert.equal(typeof generated.selectTextSnapTarget, 'function');
    // The emitted implementation behaves like the shared pure implementation.
    assert.equal(generated.selectTextSnapTarget('● PRESET: NEON NIGHT', 'PRESET: NEON NIGHT'), 'PRESET: NEON NIGHT');
    assert.equal(generated.selectTextSnapTarget('NEW PRESET: NEON NIGHT SALE', 'PRESET: NEON NIGHT'), undefined);
    assert.equal(generated.selectTextSnapTarget('●', '•'), undefined);
    // Rules embed the verbatim corpus text for snapping.
    assert.equal(generated.RULE_GROUPS['/cyberpunk'].d[0].text, 'PRESET: NEON NIGHT');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Horizontal position snap (remediation record #13)
// ---------------------------------------------------------------------------

test('geometry-replay > rules carry measured left and box width', () => {
  const rule = buildMeasuredRule(span({
    text: 'Experienced Frontend Developer',
    style: { fontSize: '14px', lineHeight: '22.75px' },
    boundingBox: { top: 280.5, left: 38, width: 314, height: 250.25 },
  }));
  assert.ok(rule !== undefined);
  assert.equal(rule?.left, 38);
  assert.equal(rule?.boxWidth, 314);
  // Multi-line spans keep their measured wrap width as before.
  assert.equal(rule?.width, 314);
  assert.equal(rule?.top, 280.5);
});

test('geometry-replay > box compatibility gates position snaps to same-surface boxes', () => {
  // Same-surface: rendered width within tolerance of the measured box.
  assert.equal(isBoxCompatible({ text: 'a', style: {}, boxWidth: 314 }, 318), true);
  assert.equal(isBoxCompatible({ text: 'a', style: {}, boxWidth: 117 }, 121), true);
  // Structure mismatch (measured inner text box vs rendered decorated
  // container): never force-move the container onto the inner coordinates.
  assert.equal(isBoxCompatible({ text: 'a', style: {}, boxWidth: 117 }, 135), false);
  // Legacy rules without a measured width are always compatible.
  assert.equal(isBoxCompatible({ text: 'a', style: {} }, 500), true);
});

test('geometry-replay > generated module snaps horizontal positions', async () => {
  const file = generateGeometryReplayModule([
    route({
      path: '/cyberpunk',
      textSpans: [span({
        text: 'Experienced Frontend Developer',
        style: { fontSize: '14px', lineHeight: '22.75px' },
        boundingBox: { top: 280.5, left: 38, width: 314, height: 250.25 },
      })],
    }),
  ]);
  assert.ok(file !== null);
  assert.ok(file?.content.includes("'margin-left'"));
  assert.ok(file?.content.includes('boxCompatible'));
  assert.ok(file?.content.includes('window.scrollX'));

  const dir = await mkdtemp(join(tmpdir(), 'apograph-geometry-'));
  try {
    const modulePath = join(dir, 'geometry-replay.mjs');
    await writeFile(modulePath, file?.content ?? '', 'utf8');
    const generated = await import(pathToFileURL(modulePath).href);
    assert.equal(typeof generated.boxCompatible, 'function');
    // The emitted guard behaves like the shared pure implementation.
    assert.equal(generated.boxCompatible({ boxWidth: 314 }, 318), true);
    assert.equal(generated.boxCompatible({ boxWidth: 117 }, 135), false);
    assert.equal(generated.boxCompatible({}, 500), true);
    // Rules embed the measured horizontal geometry.
    assert.equal(generated.RULE_GROUPS['/cyberpunk'].d[0].left, 38);
    assert.equal(generated.RULE_GROUPS['/cyberpunk'].d[0].boxWidth, 314);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

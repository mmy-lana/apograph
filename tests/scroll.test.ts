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
  planConfirmTop,
  scrollResetDiagnostic,
  waitForPageReadiness,
  readinessDiagnostic,
  MAX_SCROLL_STEPS,
  SETTLE_DELAY_MS,
  LAYOUT_SETTLE_MS,
  IMAGE_POLL_INTERVAL_MS,
  SCROLL_TIMEOUT_MS,
  POST_SCROLL_READINESS_TIMEOUT_MS,
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

  for (const name of ['collectRawTextSpans', 'collectCssText', 'collectBodyComputedStyle', 'collectUnreadableStylesheetHrefs']) {
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
        boxTop: 0, boxLeft: 0, boxWidth: 10, boxHeight: 10, tag: 'span', parentTag: 'p',
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
  kind:
    | 'evaluate-tick'
    | 'evaluate-initial'
    | 'evaluate-reset'
    | 'evaluate-observe'
    | 'evaluate-restore'
    | 'wait';
  ms?: number;
}

interface FakePageOptions {
  initialMaxScroll: number;
  converge: boolean;
  /** Post-reset scrollY the fake page reports (simulates a locked scroll). */
  lockedScrollY?: number;
}

function makeFakePage(options: FakePageOptions): {
  page: Parameters<typeof autoScrollWithReset>[0];
  calls: FakePageCall[];
} {
  const { initialMaxScroll, converge, lockedScrollY = 0 } = options;
  const calls: FakePageCall[] = [];
  let maxScroll = initialMaxScroll;

  const page = {
    evaluate: async (fn: unknown, arg: unknown) => {
      const source = String(fn);
      if (source.includes("removeProperty('scroll-behavior')")) {
        calls.push({ kind: 'evaluate-restore' });
        return null;
      }
      if (source.includes("setProperty('scroll-behavior'")) {
        // R1+R2 atomic hardened reset: style override plus instant multi-
        // target scroll. Post-reset scrollY is the locked offset if any.
        calls.push({ kind: 'evaluate-reset' });
        return lockedScrollY;
      }
      if (source.includes('window.scrollY') && !source.includes('scrollHeight')) {
        // R3 zero-scroll observation poll.
        calls.push({ kind: 'evaluate-observe' });
        return lockedScrollY;
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

test('scroll > executor ordering: autoScroll, settle, reset, confirmTop, restore', async () => {
  const { page, calls } = makeFakePage({ initialMaxScroll: 2000, converge: true });
  const result = await autoScrollWithReset(page, {}, { sleep: async () => {} });

  assert.deepEqual(result.operations, [
    'autoScroll',
    'settleDelay',
    'scrollReset',
    'confirmTop',
    'restoreStyles',
  ]);
  assert.equal(result.scrollTerminatedBy, 'bottom');
  // Amendment A1: the reset confirmed the top position.
  assert.equal(result.confirmedTop, true);
  assert.equal(result.finalScrollY, 0);

  // Settle delay is exactly the spec constant; the hardened reset and the
  // zero-scroll confirmation follow it; restoration closes the sequence.
  const settle = calls.findIndex((call) => call.kind === 'wait' && call.ms === SETTLE_DELAY_MS);
  const reset = calls.findIndex((call) => call.kind === 'evaluate-reset');
  const confirm = calls.findIndex((call) => call.kind === 'evaluate-observe');
  const restore = calls.findIndex((call) => call.kind === 'evaluate-restore');
  assert.ok(reset > -1, 'hardened scroll reset must be performed');
  assert.ok(settle > -1 && settle < reset, 'settle delay must precede the reset');
  assert.ok(confirm > -1 && reset < confirm, 'zero-scroll confirmation must follow the reset');
  assert.ok(restore > -1 && confirm < restore, 'style restoration must follow the guard');
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
// Post-scroll readiness (fonts, network settle, lazy images)
// ---------------------------------------------------------------------------

interface ReadinessCall {
  kind: 'fonts' | 'images' | 'network' | 'settle';
  ms?: number;
}

interface ReadinessBehavior {
  fonts?: 'ok' | 'hang' | 'fail';
  network?: 'ok' | 'hang' | 'reject' | 'absent';
  /** Per-poll image results; the last value repeats when polls overrun. */
  images?: boolean[];
}

/** Fake readiness page: dispatches evaluate calls by in-page source markers. */
function makeReadinessPage(behavior: ReadinessBehavior): {
  page: Parameters<typeof waitForPageReadiness>[0];
  calls: ReadinessCall[];
} {
  const calls: ReadinessCall[] = [];

  const page: Record<string, unknown> = {
    evaluate: async (fn: unknown, _arg: unknown): Promise<unknown> => {
      const source = String(fn);
      if (source.includes('document.fonts')) {
        calls.push({ kind: 'fonts' });
        if (behavior.fonts === 'hang') return new Promise(() => {});
        return behavior.fonts !== 'fail';
      }
      if (source.includes('naturalWidth')) {
        calls.push({ kind: 'images' });
        const results = behavior.images ?? [true];
        const poll = calls.filter((call) => call.kind === 'images').length - 1;
        return results[Math.min(poll, results.length - 1)] ?? true;
      }
      throw new Error(`unexpected evaluate: ${source.slice(0, 60)}`);
    },
    waitForTimeout: async (ms: number): Promise<void> => {
      calls.push({ kind: 'settle', ms });
    },
  };

  if (behavior.network !== 'absent') {
    page.waitForLoadState = async (_state?: string, _options?: { timeout?: number }): Promise<void> => {
      calls.push({ kind: 'network' });
      if (behavior.network === 'hang') return new Promise<void>(() => {});
      if (behavior.network === 'reject') throw new Error('Timeout 5000ms exceeded');
    };
  }

  return {
    page: page as unknown as Parameters<typeof waitForPageReadiness>[0],
    calls,
  };
}

/** Tiny caps so timeout-guard tests stay fast. */
const FAST_CAPS = { fontsMs: 25, networkMs: 25, imagesMs: 100, settleMs: 5 };

test('readiness > budgets match the spec caps', () => {
  assert.equal(SCROLL_TIMEOUT_MS, 20000);
  assert.equal(POST_SCROLL_READINESS_TIMEOUT_MS, 8000);
  assert.equal(LAYOUT_SETTLE_MS, 500);
  assert.equal(IMAGE_POLL_INTERVAL_MS, 200);
});

test('readiness > step ordering: fonts, network, images poll, layout settle', async () => {
  const { page, calls } = makeReadinessPage({ fonts: 'ok', network: 'ok', images: [true] });
  const readiness = await waitForPageReadiness(page, {
    stepCaps: { fontsMs: 200, networkMs: 200, imagesMs: 200, settleMs: 10 },
  });

  assert.equal(readiness.fontsReady, true);
  assert.equal(readiness.networkSettled, true);
  assert.equal(readiness.imagesReady, true);
  assert.equal(readiness.cappedAt, undefined);
  assert.equal(readinessDiagnostic(readiness), null);

  const fontsIdx = calls.findIndex((call) => call.kind === 'fonts');
  const networkIdx = calls.findIndex((call) => call.kind === 'network');
  const imagesIdx = calls.findIndex((call) => call.kind === 'images');
  const settleIdx = calls.findIndex((call) => call.kind === 'settle' && call.ms === 10);
  assert.ok(fontsIdx > -1, 'fonts wait must run');
  assert.ok(networkIdx > fontsIdx, 'network settle must follow the fonts wait');
  assert.ok(imagesIdx > networkIdx, 'the image poll must follow the network settle');
  assert.ok(settleIdx > imagesIdx, 'the final layout settle must close the sequence');
});

test('readiness > fonts wait is bounded and records cappedAt fonts', async () => {
  const { page } = makeReadinessPage({ fonts: 'hang', network: 'ok', images: [true] });
  const startedAt = Date.now();
  const readiness = await waitForPageReadiness(page, { stepCaps: FAST_CAPS });

  assert.equal(readiness.fontsReady, false);
  assert.equal(readiness.cappedAt, 'fonts');
  assert.ok(Date.now() - startedAt < 2000, 'the fonts guard must not hang');
  assert.notEqual(readinessDiagnostic(readiness), null);
});

test('readiness > persistent connections cannot hang the pipeline', async () => {
  const { page } = makeReadinessPage({ fonts: 'ok', network: 'hang', images: [true] });
  const startedAt = Date.now();
  const readiness = await waitForPageReadiness(page, { stepCaps: FAST_CAPS });

  assert.equal(readiness.networkSettled, false);
  assert.equal(readiness.cappedAt, 'network');
  assert.ok(Date.now() - startedAt < 2000, 'networkidle must be wrapped in a bounded guard');

  // A rejected networkidle settle (timeout) degrades the same way.
  const rejected = makeReadinessPage({ fonts: 'ok', network: 'reject', images: [true] });
  const after = await waitForPageReadiness(rejected.page, { stepCaps: FAST_CAPS });
  assert.equal(after.networkSettled, false);
  assert.equal(after.cappedAt, 'network');
});

test('readiness > image poll retries at 200ms intervals until settled', async () => {
  const { page, calls } = makeReadinessPage({
    fonts: 'ok',
    network: 'ok',
    images: [false, false, true],
  });
  const readiness = await waitForPageReadiness(page, {
    stepCaps: { fontsMs: 200, networkMs: 200, imagesMs: 2000, settleMs: 5 },
  });

  assert.equal(readiness.imagesReady, true);
  assert.equal(readiness.cappedAt, undefined);
  assert.equal(calls.filter((call) => call.kind === 'images').length, 3);
  const intervals = calls.filter(
    (call) => call.kind === 'settle' && call.ms === IMAGE_POLL_INTERVAL_MS,
  );
  assert.equal(intervals.length, 2, 'two 200ms interval waits between three polls');
});

test('readiness > image poll is bounded by its cap', async () => {
  const { page } = makeReadinessPage({ fonts: 'ok', network: 'ok', images: [false] });
  const startedAt = Date.now();
  const readiness = await waitForPageReadiness(page, { stepCaps: FAST_CAPS });

  assert.equal(readiness.imagesReady, false);
  assert.equal(readiness.cappedAt, 'images');
  assert.ok(Date.now() - startedAt < 2000, 'the image poll must terminate');
});

test('readiness > overall budget bounds the total added time', async () => {
  const { page } = makeReadinessPage({ fonts: 'hang', network: 'ok', images: [true] });
  const startedAt = Date.now();
  const readiness = await waitForPageReadiness(page, {
    timeoutMs: 60,
    stepCaps: { fontsMs: 10000, networkMs: 10000, imagesMs: 10000, settleMs: 5000 },
  });

  assert.equal(readiness.fontsReady, false);
  assert.equal(readiness.cappedAt, 'budget', 'the overall budget is what capped the fonts step');
  assert.ok(Date.now() - startedAt < 2000);
  assert.notEqual(readinessDiagnostic(readiness), null);
});

test('readiness > readinessDiagnostic names gaps and stays null when ready', () => {
  assert.equal(
    readinessDiagnostic({ fontsReady: true, networkSettled: true, imagesReady: true }),
    null,
  );
  const note = readinessDiagnostic({
    fontsReady: false,
    networkSettled: true,
    imagesReady: false,
    cappedAt: 'fonts',
  });
  assert.ok(note !== null);
  assert.match(note, /fonts/);
  assert.match(note, /images/);
  assert.ok(!note.includes('network idle'));
});

test('readiness > in-page readiness probes are lexically self-contained', async () => {
  const scrollText = await readFile(join(SRC_ROOT, 'src', 'crawler', 'scroll.ts'), 'utf8');
  assertSelfContained(scrollText, 'fontsReadyInPage');
  assertSelfContained(scrollText, 'imagesSettledInPage');
});

test('readiness > engine and recrawlRoute gate readiness before captures', async () => {
  const engineText = await readFile(join(SRC_ROOT, 'src', 'crawler', 'engine.ts'), 'utf8');
  const scrollIdx = engineText.indexOf('await autoScrollWithReset(page)');
  const readinessIdx = engineText.indexOf('await waitForPageReadiness(page)');
  const screenshotIdx = engineText.indexOf(
    "page.screenshot({ path: desktopScreenshot as string, type: 'png', fullPage: true })",
  );
  assert.ok(scrollIdx > -1 && readinessIdx > -1 && screenshotIdx > -1);
  assert.ok(readinessIdx > scrollIdx, 'readiness must follow the scroll reset');
  assert.ok(readinessIdx < screenshotIdx, 'readiness must precede screenshots');

  const gateText = await readFile(join(SRC_ROOT, 'src', 'plan', 'evidenceGate.ts'), 'utf8');
  const gateScrollIdx = gateText.indexOf('await autoScrollWithReset(page)');
  const gateReadinessIdx = gateText.indexOf('await waitForPageReadiness(page)');
  const gateShotIdx = gateText.indexOf(
    "page.screenshot({ path: desktopPath, type: 'png', fullPage: true })",
  );
  assert.ok(gateScrollIdx > -1 && gateReadinessIdx > -1 && gateShotIdx > -1);
  assert.ok(gateReadinessIdx > gateScrollIdx, 're-crawl readiness must follow the scroll reset');
  assert.ok(gateReadinessIdx < gateShotIdx, 're-crawl readiness must precede screenshots');
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

// ---------------------------------------------------------------------------
// s8.5 (Amendment A1) - Hardened scroll reset contract
// ---------------------------------------------------------------------------

/** Reads the executor's hardened reset function source for static checks. */
async function readScrollSource(): Promise<string> {
  return readFile(join(SRC_ROOT, 'src', 'crawler', 'scroll.ts'), 'utf8');
}

test('reset > smooth scroll is overridden to auto', async () => {
  const source = await readScrollSource();

  // R1 is declared inside the atomic reset body: inline style with
  // !important, on both scrolling elements, BEFORE any scrollTo call.
  const resetIdx = source.indexOf("operations.push('scrollReset')");
  const body = source.slice(resetIdx, source.indexOf('confirmTop', resetIdx));
  const overrideDocEl = body.indexOf("docEl.style.setProperty('scroll-behavior', 'auto', 'important')");
  const overrideBody = body.indexOf("body.style.setProperty('scroll-behavior', 'auto', 'important')");
  const scrollTo = body.indexOf("window.scrollTo({ top: 0, left: 0, behavior: 'instant'");
  assert.ok(overrideDocEl > -1, 'documentElement override must exist');
  assert.ok(overrideBody > -1, 'body override must exist');
  assert.ok(overrideDocEl < scrollTo && overrideBody < scrollTo, 'overrides must precede the reset scroll');

  // Executor-level: the override evaluate happens before confirmation.
  const { page, calls } = makeFakePage({ initialMaxScroll: 500, converge: true });
  const result = await autoScrollWithReset(page, {}, { sleep: async () => {} });
  assert.equal(result.confirmedTop, true);
  const resetCall = calls.findIndex((call) => call.kind === 'evaluate-reset');
  assert.ok(resetCall > -1);
  assert.ok(resetCall < calls.findIndex((call) => call.kind === 'evaluate-observe'));
});

test('reset > zero-scroll position is verified before proceeding', async () => {
  // Page reports a non-zero offset that settles to 0: guard polls until 0.
  const { page, calls } = makeFakePage({ initialMaxScroll: 500, converge: true });
  const result = await autoScrollWithReset(page, {}, { sleep: async () => {} });
  assert.equal(result.terminatedBy, 'confirmed');
  assert.equal(result.confirmedTop, true);
  // At least one observation poll ran after the reset and before restore.
  const resetIdx = calls.findIndex((call) => call.kind === 'evaluate-reset');
  const firstObserve = calls.findIndex((call) => call.kind === 'evaluate-observe');
  const restoreIdx = calls.findIndex((call) => call.kind === 'evaluate-restore');
  assert.ok(firstObserve > resetIdx, 'confirmation poll must follow the reset');
  assert.ok(restoreIdx > firstObserve, 'capture-affecting restoration must follow the guard');

  // Pure planner: a page already at 0 needs exactly one observation.
  let observations = 0;
  const immediate = await planConfirmTop(
    async () => {
      observations += 1;
      return 0;
    },
    async () => {},
    () => 0,
  );
  assert.equal(observations, 1);
  assert.deepEqual(immediate, { confirmedTop: true, finalScrollY: 0, terminatedBy: 'confirmed' });

  // Pure planner: 500 -> 500 -> 0 confirms on the third poll.
  const seq = [500, 500, 0];
  let index = 0;
  const polled = await planConfirmTop(
    async () => seq[Math.min(index++, seq.length - 1)] as number,
    async () => {},
    () => 0,
  );
  assert.equal(index, 3);
  assert.deepEqual(polled, { confirmedTop: true, finalScrollY: 0, terminatedBy: 'confirmed' });
});

test('reset > timeout guard terminates safely when scroll is locked', async () => {
  // Locked page: every observation reports 500 px; the clock advances 100 ms
  // per poll so the 1000 ms deadline trips.
  let elapsed = 0;
  let observations = 0;
  const outcome = await planConfirmTop(
    async () => {
      observations += 1;
      elapsed += 100;
      return 500;
    },
    async () => {},
    () => elapsed,
  );
  assert.deepEqual(outcome, { confirmedTop: false, finalScrollY: 500, terminatedBy: 'timeout' });
  assert.ok(observations >= 1);

  // The diagnostic names the locked offset and is a note, not an error.
  const diagnostic = scrollResetDiagnostic(outcome);
  assert.ok(diagnostic.includes('captured at offset 500 px'));

  // Executor level: the timeout path completes without throwing and still
  // performs unconditional style restoration.
  const { page, calls } = makeFakePage({ initialMaxScroll: 2000, converge: true, lockedScrollY: 500 });
  const executorNow = (() => {
    let polls = 0;
    return () => {
      // The first observation happens immediately; each subsequent poll
      // advances the clock by 600 ms so the 1000 ms deadline trips on the
      // second observation.
      polls += 1;
      return polls <= 1 ? 0 : (polls - 1) * 600;
    };
  })();
  const result = await autoScrollWithReset(page, {}, { now: executorNow, sleep: async () => {} });
  assert.equal(result.confirmedTop, false);
  assert.equal(result.finalScrollY, 500);
  assert.equal(result.terminatedBy, 'timeout');
  assert.ok(calls.some((call) => call.kind === 'evaluate-restore'), 'R4 restoration must run on the timeout path');
});

test('reset > multi-target reset issues all three scroll paths', async () => {
  const source = await readScrollSource();
  const resetIdx = source.indexOf("operations.push('scrollReset')");
  const body = source.slice(resetIdx, source.indexOf('operations.push(\'confirmTop\')', resetIdx));
  assert.ok(body.includes("window.scrollTo({ top: 0, left: 0, behavior: 'instant'"));
  assert.ok(body.includes('docEl.scrollTop = 0'));
  assert.ok(body.includes('body.scrollTop = 0'));
});

test('reset > virtual scroll adapter is null-safe', async () => {
  const source = await readScrollSource();
  const resetIdx = source.indexOf("operations.push('scrollReset')");
  const body = source.slice(resetIdx, source.indexOf("operations.push('confirmTop')", resetIdx));
  assert.ok(body.includes('lenis'), 'Lenis dispatch must be present');
  assert.ok(body.includes('?.scrollTo?.(0, { immediate: true })'), 'dispatch must be null-safe (optional chaining)');
  assert.ok(body.includes('window.lenis?.scrollTo(0, { immediate: true })'), 'canonical dispatch shape documented');

  // A fake page without a `lenis` global completes the reset without error.
  const { page } = makeFakePage({ initialMaxScroll: 500, converge: true });
  const result = await autoScrollWithReset(page, {}, { sleep: async () => {} });
  assert.equal(result.confirmedTop, true);
});

test('reset > style restoration always runs', async () => {
  const source = await readScrollSource();
  const restoreIdx = source.indexOf("operations.push('restoreStyles')");
  const confirmIdx = source.indexOf('planConfirmTop(', source.indexOf("operations.push('scrollReset')"));
  assert.ok(restoreIdx > -1 && confirmIdx > -1);
  // Restoration is unconditional: it follows the guard without any branch
  // between them inspecting the outcome.
  const between = source.slice(confirmIdx, restoreIdx);
  assert.ok(!between.includes('return '), 'no early return may skip R4 restoration');

  // Confirmed path restores.
  const confirmed = makeFakePage({ initialMaxScroll: 500, converge: true });
  await autoScrollWithReset(confirmed.page, {}, { sleep: async () => {} });
  assert.ok(confirmed.calls.some((call) => call.kind === 'evaluate-restore'));

  // Timeout path restores too.
  const locked = makeFakePage({ initialMaxScroll: 2000, converge: true, lockedScrollY: 500 });
  let polls = 0;
  await autoScrollWithReset(
    locked.page,
    {},
    {
      now: () => {
        polls += 1;
        return polls <= 1 ? 0 : (polls - 1) * 600;
      },
      sleep: async () => {},
    },
  );
  assert.ok(locked.calls.some((call) => call.kind === 'evaluate-restore'));

  // The in-page restoration clears the override on both scrolling elements.
  const restoreBodyIdx = source.indexOf("operations.push('restoreStyles')");
  const restoreBody = source.slice(restoreBodyIdx, source.indexOf('scrollTerminatedBy', restoreBodyIdx));
  assert.ok(restoreBody.includes("document.documentElement.style.removeProperty('scroll-behavior')"));
  assert.ok(restoreBody.includes("body.style.removeProperty('scroll-behavior')"));
});

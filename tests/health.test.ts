/**
 * Unit tests for capture health checks and instant redirect classification.
 *
 * spec: integration/visual-resilience s8.1, s8.2
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';

import {
  analyzeUniformity,
  checkCaptureHealth,
  classifyRedirect,
  detectBotBlock,
  BotBlockedError,
  BOT_BLOCK_MESSAGE,
  MIN_VISIBLE_TEXT_NODES,
  UNIFORMITY_THRESHOLD,
} from '../dist/crawler/health.js';
import type { CaptureHealth } from '../dist/crawler/health.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Renders a PNG where each pixel's color comes from pixelFn(x, y). */
function makePng(
  width: number,
  height: number,
  pixelFn: (x: number, y: number) => [number, number, number],
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      const [r, g, b] = pixelFn(x, y);
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** A fully uniform single-color PNG. */
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  return makePng(width, height, () => rgb);
}

/** A PNG that is `uniformFraction` white and the rest a gradient of colors. */
function mostlyWhitePng(width: number, height: number, uniformFraction: number): Buffer {
  const cutoff = Math.floor(width * uniformFraction);
  return makePng(width, height, (x, y) => {
    if (x < cutoff) return [255, 255, 255];
    return [(x * 7) % 256, (y * 13) % 256, (x + y) % 256];
  });
}

/** A PNG that is `uniformFraction` of one dark color, the rest a gradient. */
function mostlyDarkPng(
  width: number,
  height: number,
  rgb: [number, number, number],
  uniformFraction: number,
): Buffer {
  const cutoff = Math.floor(width * uniformFraction);
  return makePng(width, height, (x, y) => {
    if (x < cutoff) return rgb;
    return [(x * 7) % 256, (y * 13) % 256, (x + y) % 256];
  });
}

/** A horizontal gradient: every column a distinct color (spec s8.2 row 4). */
function gradientPng(width: number, height: number): Buffer {
  return makePng(width, height, (x) => [Math.floor((x / width) * 255), 64, 192]);
}

/** A pre-populated healthy verdict (for redirect classification inputs). */
function healthyVerdict(nodeCount: number): CaptureHealth {
  return {
    blank: false,
    reason: null,
    uniformityRatio: 0.02,
    dominantColor: '#080f1c',
    visibleNodeCount: nodeCount,
  };
}

/** A blank verdict for redirect classification inputs. */
function blankVerdict(nodeCount = 0): CaptureHealth {
  return {
    blank: true,
    reason: 'uniform-pixels',
    uniformityRatio: 1,
    dominantColor: '#ffffff',
    visibleNodeCount: nodeCount,
  };
}

// ---------------------------------------------------------------------------
// s8.2 - Blank capture classification
// ---------------------------------------------------------------------------

test('health > zero DOM nodes classifies blank', () => {
  // A noisy (non-uniform) frame with an empty DOM: pure no-dom-nodes verdict.
  const noisy = mostlyWhitePng(64, 64, 0.5);
  const verdict = checkCaptureHealth(noisy, 0);
  assert.equal(verdict.blank, true);
  assert.equal(verdict.reason, 'no-dom-nodes');
  assert.equal(verdict.visibleNodeCount, 0);
});

test('health > uniform pixels classify blank', () => {
  // 97% white 1280x800 frame with a sparse DOM: uniform-pixels verdict.
  const white = mostlyWhitePng(1280, 800, 0.97);
  const verdict = checkCaptureHealth(white, 5);
  assert.equal(verdict.blank, true);
  assert.equal(verdict.reason, 'uniform-pixels');
  assert.ok(verdict.uniformityRatio >= UNIFORMITY_THRESHOLD);
  assert.equal(verdict.dominantColor, '#ffffff');
});

test('health > fully solid white frame with empty DOM reports both', () => {
  const white = solidPng(320, 200, [255, 255, 255]);
  const verdict = checkCaptureHealth(white, 0);
  assert.equal(verdict.blank, true);
  assert.equal(verdict.reason, 'both');
  assert.equal(verdict.uniformityRatio, 1);
});

test('health > dark canvas is not blank', () => {
  // A real dark page: 97% #080f1c but a substantively populated DOM. The
  // node count disambiguates it from a blank dark frame (spec s8.2).
  const dark = mostlyDarkPng(1280, 800, [8, 15, 28], 0.97);
  const verdict = checkCaptureHealth(dark, 380);
  assert.equal(verdict.blank, false);
  assert.equal(verdict.reason, null);
  assert.ok(verdict.uniformityRatio >= 0.95);
  assert.equal(verdict.dominantColor, '#080f1c');
  assert.equal(verdict.visibleNodeCount, 380);
});

test('health > gradient hero is not uniform', () => {
  // A gradient headline spanning the frame keeps uniformity far below 0.95.
  const gradient = gradientPng(1280, 800);
  const analysis = analyzeUniformity(gradient);
  assert.ok(analysis.uniformityRatio < UNIFORMITY_THRESHOLD);
  const verdict = checkCaptureHealth(gradient, 120);
  assert.equal(verdict.blank, false);
});

test('health > healthy contentful page is not blank', () => {
  const noisy = mostlyWhitePng(1280, 800, 0.5);
  const verdict = checkCaptureHealth(noisy, 412);
  assert.equal(verdict.blank, false);
  assert.equal(verdict.reason, null);
});

// ---------------------------------------------------------------------------
// s8.1 - Redirect aliasing
// ---------------------------------------------------------------------------

test('classifyRedirect > aliases instant client-side redirect', () => {
  // / settled in 50ms onto /en; pre-redirect frame blank, /en healthy.
  const pre = checkCaptureHealth(solidPng(64, 64, [255, 255, 255]), 0);
  const post = healthyVerdict(412);
  const verdict = classifyRedirect('https://example-spa.com/', 'https://example-spa.com/en', 50, pre, post);
  assert.deepEqual(verdict, { alias: true, from: 'https://example-spa.com/', to: 'https://example-spa.com/en' });
});

test('classifyRedirect > preserves slow-transition frame', () => {
  // A non-blank frame that settled after 1200ms is a standalone route.
  const pre = healthyVerdict(6);
  const post = healthyVerdict(412);
  const verdict = classifyRedirect('https://example.com/', 'https://example.com/en', 1200, pre, post);
  assert.equal(verdict.alias, false);
  assert.equal(verdict.from, 'https://example.com/');
  assert.equal(verdict.to, 'https://example.com/en');
});

test('classifyRedirect > blank frame without healthy target stays suspect', () => {
  // Blank pre-redirect frame whose resolved target is itself blank: no
  // alias; the frame is classified suspect by the caller instead.
  const pre = blankVerdict(0);
  const post = blankVerdict(0);
  const verdict = classifyRedirect('https://example.com/x', 'https://example.com/y', 40, pre, post);
  assert.equal(verdict.alias, false);
  assert.equal(pre.blank, true);
});

test('classifyRedirect > same-url settle is not an alias', () => {
  const pre = blankVerdict(0);
  const post = healthyVerdict(412);
  const verdict = classifyRedirect('https://example.com/en', 'https://example.com/en', 50, pre, post);
  assert.equal(verdict.alias, false);
});

test('classifyRedirect > alias target receives redirect route entry', () => {
  // When the classifier aliases / -> /en, the generated plan registers "/"
  // as a redirect to "/en" with no component synthesis for "/" (spec s2.2):
  // the alias record carries exactly the mapping the router needs.
  const pre = blankVerdict(0);
  const post = healthyVerdict(412);
  const verdict = classifyRedirect('https://example.com/', 'https://example.com/en', 50, pre, post);
  assert.equal(verdict.alias, true);
  assert.equal(verdict.from, 'https://example.com/');
  assert.equal(verdict.to, 'https://example.com/en');
  assert.notEqual(verdict.from, verdict.to);
});

// ---------------------------------------------------------------------------
// Uniformity analysis pipeline
// ---------------------------------------------------------------------------

test('analyzeUniformity > reports dominant color and ratio', () => {
  const analysis = analyzeUniformity(mostlyDarkPng(100, 100, [8, 15, 28], 0.9));
  assert.equal(analysis.dominantColor, '#080f1c');
  assert.ok(analysis.uniformityRatio >= 0.9);
  assert.ok(analysis.uniformityRatio <= 1);
});

// ---------------------------------------------------------------------------
// Pre-flight bot / WAF challenge detection
// ---------------------------------------------------------------------------

test('bot-check > challenge and restriction titles are blocked', () => {
  const cases: Array<[string, string]> = [
    ['Just a moment...', 'challenge-title'],
    ['Attention Required! | Cloudflare', 'challenge-title'],
    ['Checking your browser before accessing example.com', 'challenge-title'],
    ['Access Denied', 'access-restriction-title'],
  ];
  for (const [title, signature] of cases) {
    const verdict = detectBotBlock({ title, httpStatus: 200, visibleTextNodeCount: 120 });
    assert.equal(verdict.verdict, 'blocked', `title "${title}" must block`);
    assert.equal(verdict.signature, signature, `title "${title}" signature`);
  }
});

test('bot-check > HTTP 403/404 responses are blocked', () => {
  for (const status of [403, 404]) {
    const verdict = detectBotBlock({ title: 'Some page', httpStatus: status, visibleTextNodeCount: 80 });
    assert.equal(verdict.verdict, 'blocked', `HTTP ${status} must block`);
    assert.equal(verdict.signature, 'blocked-http-status');
    assert.ok(verdict.detail.includes(String(status)));
  }
  // Other statuses never block on their own.
  for (const status of [200, 301, 401, 500]) {
    const verdict = detectBotBlock({ title: 'Some page', httpStatus: status, visibleTextNodeCount: 80 });
    assert.equal(verdict.verdict, 'clean', `HTTP ${status} alone must not block`);
  }
});

test('bot-check > near-empty DOMs are blocked', () => {
  const verdict = detectBotBlock({
    title: 'Example',
    httpStatus: 200,
    visibleTextNodeCount: MIN_VISIBLE_TEXT_NODES - 1,
  });
  assert.equal(verdict.verdict, 'blocked');
  assert.equal(verdict.signature, 'sparse-dom');

  const atThreshold = detectBotBlock({
    title: 'Example',
    httpStatus: 200,
    visibleTextNodeCount: MIN_VISIBLE_TEXT_NODES,
  });
  assert.equal(atThreshold.verdict, 'clean', 'threshold itself is a real page');
});

test('bot-check > unknown DOM evidence is never treated as blocked', () => {
  const verdict = detectBotBlock({ title: 'Example', httpStatus: 200, visibleTextNodeCount: null });
  assert.equal(verdict.verdict, 'clean');
  assert.ok(verdict.detail.includes('unavailable'));
});

test('bot-check > clean pages pass and record evidence detail', () => {
  const verdict = detectBotBlock({ title: 'Example Domain', httpStatus: 200, visibleTextNodeCount: 42 });
  assert.equal(verdict.verdict, 'clean');
  assert.equal(verdict.signature, null);
  assert.ok(verdict.detail.includes('Example Domain'));
  assert.ok(verdict.detail.includes('42'));
});

test('bot-check > BotBlockedError aborts with the exact message', () => {
  const verdict = detectBotBlock({ title: 'Just a moment...', httpStatus: 403, visibleTextNodeCount: 1 });
  const error = new BotBlockedError(verdict, 'https://example.com/');
  assert.equal(
    error.message,
    '[BLOCKED] Bot challenge or access restriction detected on target URL. Crawl aborted before synthesis.',
  );
  assert.equal(error.message, BOT_BLOCK_MESSAGE);
  assert.equal(error.name, 'BotBlockedError');
  assert.equal(error.url, 'https://example.com/');
  assert.equal(error.verdict, verdict);
});

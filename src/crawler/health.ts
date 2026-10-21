/**
 * apograph — Capture health checks, instant redirect classification, and
 * pre-flight bot / WAF challenge detection (Layer 1b: Crawl resilience).
 *
 * Implements `specs/integration/visual-resilience.md` sections 2.1 and 2.2:
 *
 * - Blank screenshot detection: a captured frame is blank when its DOM
 *   snapshot has 0 visible nodes, or when more than 95% of its pixels fall
 *   within Euclidean RGB distance 16 of the single dominant color.
 * - Instant redirect detection: an initial navigation whose pre-redirect
 *   frame is blank and which settles (< 500ms by default) onto a healthy
 *   final URL is aliased instead of recorded as a dead route.
 *
 * Also implements the pre-flight bot-block detector: immediately after
 * navigation, challenge signatures (interstitial titles, 403/404 responses,
 * near-empty DOMs) abort the crawl with an explicit `[BLOCKED]` error before
 * any synthesis work happens.
 *
 * spec: integration/visual-resilience s2
 */

import { PNG } from 'pngjs';
import type { BotBlockSignature, CanvasTheme, RouteBotCheck } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Why a captured frame was classified blank (null when healthy). */
export type BlankReason = 'no-dom-nodes' | 'uniform-pixels' | 'both' | null;

/** Structured health verdict for one captured frame (spec s2.1). */
export interface CaptureHealth {
  /** True when the frame must never enter synthesis. */
  blank: boolean;
  /** Machine-readable reason for the blank classification. */
  reason: BlankReason;
  /** Fraction of pixels matching the dominant color, in [0, 1]. */
  uniformityRatio: number;
  /** Dominant color as lowercase `#rrggbb`, or null for empty frames. */
  dominantColor: string | null;
  /** Count of visible DOM nodes harvested for the frame. */
  visibleNodeCount: number;
}

/** Result of instant redirect classification (spec s2.2). */
export interface RedirectAlias {
  alias: boolean;
  from: string;
  to: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** A frame is blank when at least this fraction of pixels share one color. */
export const UNIFORMITY_THRESHOLD = 0.95;

/** Maximum Euclidean RGB distance for a pixel to count as the dominant color. */
export const RGB_DISTANCE_TOLERANCE = 16;

/** Settle window (ms) under which a navigation counts as an instant redirect. */
export const INSTANT_REDIRECT_SETTLE_MS = 500;

/**
 * A uniformly colored frame with at least this many visible DOM nodes is a
 * real (if minimal) page, not a blank transition frame. The node count
 * disambiguates a genuine dark canvas (e.g. 97% #080f1c with 380 nodes)
 * from a blank dark frame (spec s8.2).
 */
export const MIN_NODES_FOR_REAL_PAGE = 32;

// ---------------------------------------------------------------------------
// Blank screenshot detection (spec s2.1)
// ---------------------------------------------------------------------------

/**
 * Decodes a PNG buffer and computes pixel-uniformity statistics against the
 * dominant color. Exported for focused testing of the pixel pipeline.
 */
export function analyzeUniformity(screenshotBuffer: Buffer): {
  uniformityRatio: number;
  dominantColor: string | null;
} {
  const png = PNG.sync.read(screenshotBuffer);
  const { width, height, data } = png;

  const totalPixels = width * height;
  if (totalPixels === 0) {
    return { uniformityRatio: 1, dominantColor: null };
  }

  // Coarse histogram over the high byte of each channel to find the dominant
  // color bin without allocating a full 16M-entry map. Two-pass: bin, then
  // count exact-color pixels within the winning bins.
  const bins = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4) {
    const key = ((data[i] as number) << 16) | ((data[i + 1] as number) << 8) | (data[i + 2] as number);
    bins.set(key, (bins.get(key) ?? 0) + 1);
  }

  // Dominant bin = most common exact color key.
  let dominantKey = 0;
  let dominantCount = 0;
  for (const [key, count] of bins) {
    if (count > dominantCount) {
      dominantKey = key;
      dominantCount = count;
    }
  }

  const dr = (dominantKey >> 16) & 0xff;
  const dg = (dominantKey >> 8) & 0xff;
  const db = dominantKey & 0xff;

  let within = 0;
  const toleranceSq = RGB_DISTANCE_TOLERANCE * RGB_DISTANCE_TOLERANCE;
  for (let i = 0; i < data.length; i += 4) {
    const diffR = (data[i] as number) - dr;
    const diffG = (data[i + 1] as number) - dg;
    const diffB = (data[i + 2] as number) - db;
    if (diffR * diffR + diffG * diffG + diffB * diffB <= toleranceSq) {
      within += 1;
    }
  }

  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  return {
    uniformityRatio: within / totalPixels,
    dominantColor: `#${hex(dr)}${hex(dg)}${hex(db)}`,
  };
}

/**
 * Derives the canvas theme from rendered pixels (spec s4.1 grounding
 * fallback). Pages that paint no computed background on `<body>`/`<html>`
 * (fully transparent canvas) get their `tokens.canvas.backgroundColor`
 * grounded in the dominant rendered frame color — a measured value, never a
 * silent default to white. Returns undefined for empty frames.
 */
export function deriveRenderedCanvasTheme(screenshotBuffer: Buffer): CanvasTheme | undefined {
  const { dominantColor } = analyzeUniformity(screenshotBuffer);
  if (dominantColor === null || !/^#[0-9a-f]{6}$/.test(dominantColor)) return undefined;
  return { backgroundColor: dominantColor, source: 'rendered-pixels' };
}

/**
 * Classifies one captured frame per spec s2.1. A frame is blank when its
 * visible DOM node count is 0, or when at least 95% of its screenshot pixels
 * lie within Euclidean RGB distance 16 of the dominant color while the DOM
 * is too sparse to be a real page (see {@link MIN_NODES_FOR_REAL_PAGE}).
 */
export function checkCaptureHealth(
  screenshotBuffer: Buffer,
  visibleNodeCount: number,
): CaptureHealth {
  const { uniformityRatio, dominantColor } = analyzeUniformity(screenshotBuffer);

  const noDomNodes = visibleNodeCount === 0;
  const uniformPixels =
    uniformityRatio >= UNIFORMITY_THRESHOLD && visibleNodeCount < MIN_NODES_FOR_REAL_PAGE;

  let reason: BlankReason = null;
  if (noDomNodes && uniformPixels) reason = 'both';
  else if (noDomNodes) reason = 'no-dom-nodes';
  else if (uniformPixels) reason = 'uniform-pixels';

  return {
    blank: reason !== null,
    reason,
    uniformityRatio,
    dominantColor,
    visibleNodeCount,
  };
}

// ---------------------------------------------------------------------------
// Instant redirect detection (spec s2.2)
// ---------------------------------------------------------------------------

/**
 * Classifies an instant client-side redirect per spec s2.2. All must hold:
 * the navigation settled within 500ms, the pre-redirect frame is blank, and
 * the final URL resolved to its own healthy frame. Only then is the initial
 * URL aliased to the final one instead of recorded as a route.
 */
export function classifyRedirect(
  initialUrl: string,
  finalUrl: string,
  settleTimeMs: number,
  preRedirectHealth: CaptureHealth,
  postRedirectHealth: CaptureHealth,
): RedirectAlias {
  const instant = settleTimeMs < INSTANT_REDIRECT_SETTLE_MS;
  const distinct = initialUrl !== finalUrl;
  const blankPre = preRedirectHealth.blank;
  const healthyPost = !postRedirectHealth.blank;

  const alias = instant && distinct && blankPre && healthyPost;

  return { alias, from: initialUrl, to: finalUrl };
}

// ---------------------------------------------------------------------------
// Pre-flight bot / WAF challenge detection
// ---------------------------------------------------------------------------

/**
 * The exact message surfaced when a challenge or access restriction is
 * detected. The crawl aborts with it before any synthesis work happens.
 */
export const BOT_BLOCK_MESSAGE =
  '[BLOCKED] Bot challenge or access restriction detected on target URL. Crawl aborted before synthesis.';

/** Document-title challenge / restriction signatures. */
export const CHALLENGE_TITLE_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  signature: BotBlockSignature;
}> = [
  { pattern: /just a moment/i, signature: 'challenge-title' },
  { pattern: /cloudflare/i, signature: 'challenge-title' },
  { pattern: /attention required/i, signature: 'challenge-title' },
  { pattern: /checking your browser/i, signature: 'challenge-title' },
  { pattern: /access denied/i, signature: 'access-restriction-title' },
];

/** HTTP statuses that mark an access restriction (403 / 404). */
export const BLOCKED_HTTP_STATUSES: ReadonlySet<number> = new Set([403, 404]);

/**
 * A DOM with fewer than this many visible text nodes is a challenge shell /
 * interstitial, not a real page.
 */
export const MIN_VISIBLE_TEXT_NODES = 5;

/** Input for {@link detectBotBlock}: what the pre-flight check observes. */
export interface BotCheckInput {
  /** Document title captured right after navigation. */
  title: string;
  /** HTTP status of the final main-frame document response (null when unknown). */
  httpStatus?: number | null;
  /**
   * Count of visible (non-whitespace) text nodes in the DOM. Null when the
   * DOM could not be evaluated — the sparse-DOM check then stays inert
   * (unknown is never treated as blocked).
   */
  visibleTextNodeCount?: number | null;
}

/**
 * Fatal bot-block abort. Thrown instead of continuing the crawl so a
 * challenge page can never reach evidence capture — and therefore never
 * reaches synthesis.
 */
export class BotBlockedError extends Error {
  /** The verdict that fired. */
  readonly verdict: RouteBotCheck;
  /** The URL whose navigation tripped the detector. */
  readonly url: string;

  constructor(verdict: RouteBotCheck, url: string) {
    super(BOT_BLOCK_MESSAGE);
    this.name = 'BotBlockedError';
    this.verdict = verdict;
    this.url = url;
  }
}

/**
 * Automated bot-block / WAF challenge detector, run immediately after every
 * navigation. A page is blocked when any of these fire:
 *
 * - a challenge or restriction title (`Just a moment…`, `Cloudflare`,
 *   `Attention Required!`, `Access Denied`);
 * - a blocking HTTP status (403, 404);
 * - a near-empty DOM (fewer than {@link MIN_VISIBLE_TEXT_NODES} visible
 *   text nodes).
 *
 * Pure and exported for focused testing.
 */
export function detectBotBlock(input: BotCheckInput): RouteBotCheck {
  const title = input.title.trim();

  for (const { pattern, signature } of CHALLENGE_TITLE_PATTERNS) {
    if (pattern.test(title)) {
      return {
        verdict: 'blocked',
        signature,
        detail: `document title "${title}" matches a bot challenge / access restriction signature`,
      };
    }
  }

  const status = input.httpStatus ?? null;
  if (status !== null && BLOCKED_HTTP_STATUSES.has(status)) {
    return {
      verdict: 'blocked',
      signature: 'blocked-http-status',
      detail: `main document responded with HTTP ${status}`,
    };
  }

  const textNodes = input.visibleTextNodeCount ?? null;
  if (textNodes !== null && textNodes < MIN_VISIBLE_TEXT_NODES) {
    return {
      verdict: 'blocked',
      signature: 'sparse-dom',
      detail:
        `DOM has only ${textNodes} visible text node(s) ` +
        `(< ${MIN_VISIBLE_TEXT_NODES}) — challenge shell, not a real page`,
    };
  }

  return {
    verdict: 'clean',
    signature: null,
    detail:
      `no challenge signatures (title "${title}", ` +
      `HTTP ${status ?? 'unknown'}, ` +
      `${textNodes === null ? 'DOM text nodes unavailable' : `${textNodes} visible text node(s)`})`,
  };
}

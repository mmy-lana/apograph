/**
 * apograph — Bounded auto-scroll planner and executor (Layer 1b: Crawl).
 *
 * Implements `specs/integration/patch-capture-scrolling.md` s3.1: lazy-load
 * triggering via incremental auto-scroll with dual mandatory bounds, a
 * settle delay at the bottom, and a mandatory scroll reset before capture.
 *
 * The planner is pure (async tick + injectable clock) and unit-testable
 * without Chromium; the executor drives a minimal page-like surface.
 */

// ---------------------------------------------------------------------------
// Constants (patch spec s3.1)
// ---------------------------------------------------------------------------

/** Maximum number of scroll steps per route (infinite-scroll guard). */
export const MAX_SCROLL_STEPS = 30;

/** Maximum wall-clock duration of the whole scroll pass, in ms. */
export const SCROLL_TIMEOUT_MS = 5000;

/** Settle delay at the bottom before capture, in ms. */
export const SETTLE_DELAY_MS = 750;

/** Delay after the scroll reset before capture, in ms. */
export const RESET_DELAY_MS = 150;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Why the scroll pass terminated. */
export type ScrollTermination = 'bottom' | 'steps' | 'timeout';

/** Result of one scroll observation, read in-page. */
export interface ScrollTickResult {
  /** Current vertical scroll position. */
  scrollY: number;
  /** Maximum reachable scroll position (`scrollHeight - viewportHeight`). */
  maxScroll: number;
  /** Total document scroll height. */
  scrollHeight: number;
}

/** Initial observation plus the viewport height. */
export interface ScrollInitial extends ScrollTickResult {
  viewportHeight: number;
}

/** Configurable bounds for one scroll pass. */
export interface ScrollLimits {
  maxSteps: number;
  maxDurationMs: number;
}

/** Outcome of one planned scroll pass. */
export interface ScrollPlanResult {
  /** Number of scroll steps actually executed. */
  steps: number;
  /** Why the pass terminated. */
  terminatedBy: ScrollTermination;
  /** The maximum scroll position observed at termination. */
  finalMaxScroll: number;
}

/** Minimal page surface the executor needs (Playwright Page satisfies it). */
export interface ScrollablePage {
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
}

/** Default limits. */
export function defaultScrollLimits(): ScrollLimits {
  return { maxSteps: MAX_SCROLL_STEPS, maxDurationMs: SCROLL_TIMEOUT_MS };
}

// ---------------------------------------------------------------------------
// Pure planner
// ---------------------------------------------------------------------------

/**
 * Plans and simulates the bounded auto-scroll pass against an async `tick`
 * that performs one scroll step and returns the post-scroll observation,
 * with an injectable monotonic `now` clock. Pure: no browser dependency.
 *
 * Termination order of checks after each step: bottom convergence first,
 * then the step bound, then the time bound. A body whose scroll height does
 * not exceed the viewport terminates immediately with zero scroll steps
 * (zero-height / cookie-wall shells, patch spec s4).
 */
export async function planAutoScroll(
  initial: ScrollInitial,
  tick: (targetScrollY: number) => Promise<ScrollTickResult>,
  now: () => number = () => 0,
  limits: Partial<ScrollLimits> = {},
): Promise<ScrollPlanResult> {
  const maxSteps = limits.maxSteps ?? MAX_SCROLL_STEPS;
  const maxDurationMs = limits.maxDurationMs ?? SCROLL_TIMEOUT_MS;
  const startedAt = now();

  // Zero-height or viewport-sized body: nothing to scroll.
  if (initial.scrollHeight <= initial.viewportHeight) {
    return { steps: 0, terminatedBy: 'bottom', finalMaxScroll: 0 };
  }

  let previousMaxScroll = initial.maxScroll;
  let steps = 0;

  while (steps < maxSteps) {
    // Scroll to the current maximum; instant positioning avoids smooth
    // scroll races (patch spec s4).
    const observed = await tick(previousMaxScroll);
    steps += 1;

    if (observed.maxScroll <= previousMaxScroll) {
      // Page bottom reached: max scroll stopped increasing.
      return {
        steps,
        terminatedBy: 'bottom',
        finalMaxScroll: observed.maxScroll,
      };
    }

    previousMaxScroll = observed.maxScroll;

    if (steps >= maxSteps) {
      return { steps, terminatedBy: 'steps', finalMaxScroll: previousMaxScroll };
    }

    if (now() - startedAt >= maxDurationMs) {
      return { steps, terminatedBy: 'timeout', finalMaxScroll: previousMaxScroll };
    }
  }

  return { steps, terminatedBy: 'steps', finalMaxScroll: previousMaxScroll };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Runs the bounded auto-scroll pass on a live page and then performs the
 * mandatory capture-ordering tail: settle delay at the bottom, scroll reset
 * to (0, 0), and the post-reset delay (patch spec s3.1). Returns the plan
 * result plus the ordered operation log for testability (patch spec s5.2).
 */
export async function autoScrollWithReset(
  page: ScrollablePage,
  limits: Partial<ScrollLimits> = {},
): Promise<ScrollPlanResult & { operations: string[] }> {
  const operations: string[] = [];

  const initial = await page.evaluate(() => {
    const scrollHeight = document.documentElement.scrollHeight;
    const viewportHeight = window.innerHeight;
    return {
      scrollY: window.scrollY,
      maxScroll: Math.max(0, scrollHeight - viewportHeight),
      scrollHeight,
      viewportHeight,
    };
  }, null);

  const plan = await planAutoScroll(
    initial,
    async (targetScrollY) =>
      // Scroll instantly to the target, then re-observe. The in-page body
      // is fully self-contained (patch spec s2.1 Rule 1).
      page.evaluate((target: number) => {
        window.scrollTo({ top: target, behavior: 'instant' as ScrollBehavior });
        const scrollHeight = document.documentElement.scrollHeight;
        const viewportHeight = window.innerHeight;
        return {
          scrollY: window.scrollY,
          maxScroll: Math.max(0, scrollHeight - viewportHeight),
          scrollHeight,
        };
      }, targetScrollY),
    undefined,
    limits,
  );
  operations.push('autoScroll');

  operations.push('settleDelay');
  await page.waitForTimeout(SETTLE_DELAY_MS);

  operations.push('scrollReset');
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  }, null);

  operations.push('resetDelay');
  await page.waitForTimeout(RESET_DELAY_MS);

  return { ...plan, operations };
}

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
export const SCROLL_TIMEOUT_MS = 20000;

/** Settle delay at the bottom before capture, in ms. */
export const SETTLE_DELAY_MS = 750;

/**
 * Hard budget for the post-scroll readiness pipeline, in ms. Together with
 * the step caps below it bounds the added per-page time at 8s.
 */
export const POST_SCROLL_READINESS_TIMEOUT_MS = 8000;

/** Cap for the `document.fonts.ready` wait, in ms. */
export const FONTS_READY_TIMEOUT_MS = 3000;

/** Cap for the networkidle settle wait, in ms. */
export const NETWORK_IDLE_TIMEOUT_MS = 5000;

/** Cap for the image-completion poll, in ms. */
export const IMAGES_READY_TIMEOUT_MS = 3000;

/** Poll interval for the image-completion check, in ms. */
export const IMAGE_POLL_INTERVAL_MS = 200;

/** Final layout settle after the readiness gates, in ms. */
export const LAYOUT_SETTLE_MS = 500;

/** Poll interval for the verified zero-scroll guard, in ms (amendment A1 R3). */
export const CONFIRM_TOP_INTERVAL_MS = 50;

/** Hard timeout for the verified zero-scroll guard, in ms (amendment A1 R3). */
export const CONFIRM_TOP_TIMEOUT_MS = 1000;

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

/** Outcome of the hardened scroll reset guard (amendment A1 R3). */
export interface ConfirmTopOutcome {
  /** True when `window.scrollY === 0` was observed before the deadline. */
  confirmedTop: boolean;
  /** The last observed scroll position. */
  finalScrollY: number;
  /** How the guard terminated. */
  terminatedBy: 'confirmed' | 'timeout';
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
// Verified zero-scroll guard (amendment A1 R3, pure planner)
// ---------------------------------------------------------------------------

/** Configurable bounds for the zero-scroll confirmation guard. */
export interface ConfirmTopLimits {
  intervalMs: number;
  timeoutMs: number;
}

/** Default confirm-top limits (patch spec s8.2 R3). */
export function defaultConfirmTopLimits(): ConfirmTopLimits {
  return { intervalMs: CONFIRM_TOP_INTERVAL_MS, timeoutMs: CONFIRM_TOP_TIMEOUT_MS };
}

/**
 * Pure planner for the verified zero-scroll guard (amendment A1 R3): polls
 * the injectable `observe` (returning the current `window.scrollY`) at
 * `intervalMs` until it observes 0, or until the injectable clock exceeds
 * `timeoutMs`. Never throws; the timeout path is a safe, diagnostic-grade
 * termination. The `sleep` injectable lets tests run without real timers.
 */
export async function planConfirmTop(
  observe: () => Promise<number>,
  sleep: (ms: number) => Promise<void>,
  now: () => number = () => 0,
  limits: Partial<ConfirmTopLimits> = {},
): Promise<ConfirmTopOutcome> {
  const { intervalMs, timeoutMs } = { ...defaultConfirmTopLimits(), ...limits };
  const startedAt = now();

  for (;;) {
    const scrollY = await observe();
    if (scrollY === 0) {
      return { confirmedTop: true, finalScrollY: 0, terminatedBy: 'confirmed' };
    }
    if (now() - startedAt >= timeoutMs) {
      return { confirmedTop: false, finalScrollY: scrollY, terminatedBy: 'timeout' };
    }
    await sleep(intervalMs);
  }
}

/** Builds the consumer-facing diagnostic for an unconfirmed reset (A1 R3). */
export function scrollResetDiagnostic(outcome: ConfirmTopOutcome): string {
  return `scroll reset could not confirm top position; captured at offset ${outcome.finalScrollY} px`;
}

// ---------------------------------------------------------------------------
// Executor (amendment A1: hardened reset sequence R1-R4)
// ---------------------------------------------------------------------------

/** Hooks the executor accepts for testability (all optional). */
export interface ScrollExecutorHooks {
  /** Monotonic clock for the confirm-top guard. Defaults to Date.now. */
  now?: () => number;
  /** Sleep primitive for polls and settle delays. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs the bounded auto-scroll pass on a live page and then performs the
 * mandatory capture-ordering tail with the HARDENED reset sequence
 * (amendment A1):
 *
 *   R1  force `scroll-behavior: auto !important` on html and body inline;
 *   R2  instant multi-target reset (scrollTo instant, scrollTop on html and
 *       body, null-safe virtualizer dispatch);
 *   R3  poll `window.scrollY === 0` (50 ms interval, 1000 ms hard timeout,
 *       safe termination with diagnostic on timeout);
 *   R4  unconditional best-effort restoration of the temporary override.
 *
 * Returns the plan result, the ordered operation log, and the reset outcome
 * for consumer diagnostics (patch spec s8.2, s5.2).
 */
export async function autoScrollWithReset(
  page: ScrollablePage,
  limits: Partial<ScrollLimits> = {},
  hooks: ScrollExecutorHooks = {},
): Promise<Omit<ScrollPlanResult, 'terminatedBy'> & {
  /** Why the auto-scroll pass terminated ('bottom' | 'steps' | 'timeout'). */
  scrollTerminatedBy: ScrollTermination;
} & ConfirmTopOutcome & { operations: string[] }> {
  const operations: string[] = [];
  const now = hooks.now ?? (() => Date.now());
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

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

  // --- R1 + R2: atomic in-page hardened reset. Self-contained body (patch
  // spec s2.1 Rule 1): the style override, the multi-target instant reset,
  // and the null-safe virtualizer dispatch all live inside this closure.
  operations.push('scrollReset');
  await page.evaluate(() => {
    const docEl = document.documentElement;
    const body = document.body;
    // R1: neutralize CSS smooth scrolling at the source.
    docEl.style.setProperty('scroll-behavior', 'auto', 'important');
    if (body !== null) body.style.setProperty('scroll-behavior', 'auto', 'important');
    // R2: instant multi-target reset across every scrolling element.
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
    docEl.scrollTop = 0;
    if (body !== null) body.scrollTop = 0;
    // R2: null-safe virtual smooth-scroll library dispatch. The canonical
    // call shape is `window.lenis?.scrollTo(0, { immediate: true })`; the
    // double optional chain also guards a lenis object without scrollTo.
    const lenisHost = window as unknown as {
      lenis?: { scrollTo?: (target: number, options?: { immediate?: boolean }) => void };
    };
    lenisHost.lenis?.scrollTo?.(0, { immediate: true });
  }, null);

  // --- R3: verified zero-scroll guard (replaces the blind fixed delay).
  operations.push('confirmTop');
  const outcome = await planConfirmTop(
    () =>
      page.evaluate(() => window.scrollY, null),
    (ms) => sleep(ms),
    now,
  );

  // --- R4: unconditional best-effort style restoration (both paths).
  operations.push('restoreStyles');
  await page.evaluate(() => {
    document.documentElement.style.removeProperty('scroll-behavior');
    const body = document.body;
    if (body !== null) body.style.removeProperty('scroll-behavior');
  }, null);

  return {
    ...plan,
    scrollTerminatedBy: plan.terminatedBy,
    ...outcome,
    operations,
  };
}

// ---------------------------------------------------------------------------
// Post-scroll page readiness (fonts, network settle, lazy images)
// ---------------------------------------------------------------------------

/** Outcome of the bounded post-scroll readiness pipeline. */
export interface PageReadiness {
  /** True when `document.fonts.ready` resolved within its cap. */
  fontsReady: boolean;
  /** True when the page reached networkidle within its cap. */
  networkSettled: boolean;
  /** True when every sourced `<img>` completed with real pixels. */
  imagesReady: boolean;
  /** Name of the step that hit its time cap ('fonts' | 'network' | 'images' | 'budget'). */
  cappedAt?: string;
}

/** Minimal page surface the readiness pipeline needs (Playwright Page fits). */
export interface ReadinessPage {
  evaluate<A, R>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  waitForTimeout(ms: number): Promise<void>;
  /** Absent only on test fakes: network settle then cannot be verified. */
  waitForLoadState?(state?: string, options?: { timeout?: number }): Promise<unknown>;
}

/** Configurable bounds for the readiness pipeline (tests inject tiny caps). */
export interface PageReadinessOptions {
  /** Overall budget in ms. Defaults to POST_SCROLL_READINESS_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Per-step caps override (tests keep the guards fast). */
  stepCaps?: {
    fontsMs?: number;
    networkMs?: number;
    imagesMs?: number;
    settleMs?: number;
  };
}

/** In-page probe: true once `document.fonts.ready` has resolved. */
async function fontsReadyInPage(): Promise<boolean> {
  try {
    await document.fonts.ready;
    return true;
  } catch {
    return false;
  }
}

/** In-page probe: true when every sourced <img> is complete with pixels. */
function imagesSettledInPage(): boolean {
  for (const img of Array.from(document.querySelectorAll('img'))) {
    const sourced =
      img.getAttribute('src') !== null || img.getAttribute('srcset') !== null;
    if (!sourced) continue;
    if (!img.complete) return false;
    if (img.naturalWidth <= 0) return false;
  }
  return true;
}

/** Resolves with the promise's value, or null when `ms` elapses first. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** Polls the in-page image probe until all images settle or the cap hits. */
async function pollImagesReady(page: ReadinessPage, budgetMs: number): Promise<boolean> {
  const maxPolls = Math.max(1, Math.ceil(budgetMs / IMAGE_POLL_INTERVAL_MS) + 1);
  for (let poll = 0; poll < maxPolls; poll += 1) {
    let ready = false;
    try {
      ready = (await page.evaluate(imagesSettledInPage, null)) === true;
    } catch {
      ready = false;
    }
    if (ready) return true;
    if (poll < maxPolls - 1) {
      try {
        await page.waitForTimeout(
          Math.max(0, Math.min(IMAGE_POLL_INTERVAL_MS, budgetMs - poll * IMAGE_POLL_INTERVAL_MS)),
        );
      } catch {
        return false;
      }
    }
  }
  return false;
}

/**
 * Bounded post-scroll readiness pipeline, run after the hardened scroll
 * reset and immediately before any capture: fonts ready (3s cap) ->
 * networkidle (5s cap, wrapped so persistent connections can never hang
 * the crawl) -> lazy-image completion poll (200ms interval, 3s cap) ->
 * a final layout settle (500ms). The whole pipeline is bounded by
 * POST_SCROLL_READINESS_TIMEOUT_MS (8s) by default. Never throws: each
 * step records its own outcome and `cappedAt` names the first step that
 * ran out of budget ('fonts' | 'network' | 'images' | 'budget').
 */
export async function waitForPageReadiness(
  page: ReadinessPage,
  options: PageReadinessOptions = {},
): Promise<PageReadiness> {
  const readiness: PageReadiness = {
    fontsReady: false,
    networkSettled: false,
    imagesReady: false,
  };
  let cappedAt: string | undefined;
  const markCap = (step: string): void => {
    if (cappedAt === undefined) cappedAt = step;
  };

  try {
    const caps = {
      fontsMs: options.stepCaps?.fontsMs ?? FONTS_READY_TIMEOUT_MS,
      networkMs: options.stepCaps?.networkMs ?? NETWORK_IDLE_TIMEOUT_MS,
      imagesMs: options.stepCaps?.imagesMs ?? IMAGES_READY_TIMEOUT_MS,
      settleMs: options.stepCaps?.settleMs ?? LAYOUT_SETTLE_MS,
    };
    const budgetMs = options.timeoutMs ?? POST_SCROLL_READINESS_TIMEOUT_MS;
    const startedAt = Date.now();
    const remainingMs = (): number => budgetMs - (Date.now() - startedAt);

    // Step 1: fonts (bounded).
    const fontsWindow = Math.min(caps.fontsMs, remainingMs());
    if (fontsWindow <= 0) {
      markCap('budget');
    } else {
      const fonts = await withTimeout(page.evaluate(fontsReadyInPage, null), fontsWindow);
      readiness.fontsReady = fonts === true;
      if (fonts !== true) markCap(fontsWindow < caps.fontsMs ? 'budget' : 'fonts');
    }

    // Step 2: network settle (bounded; networkidle must never hang).
    const networkWindow = Math.min(caps.networkMs, remainingMs());
    if (networkWindow <= 0) {
      markCap('budget');
    } else if (typeof page.waitForLoadState !== 'function') {
      readiness.networkSettled = false;
      markCap('network');
    } else {
      const settled = await withTimeout(
        (async () => {
          try {
            await page.waitForLoadState?.('networkidle', { timeout: networkWindow });
            return true;
          } catch {
            return false;
          }
        })(),
        networkWindow,
      );
      readiness.networkSettled = settled === true;
      if (settled !== true) markCap(networkWindow < caps.networkMs ? 'budget' : 'network');
    }

    // Step 3: lazy-image completion poll (bounded).
    const imagesWindow = Math.min(caps.imagesMs, remainingMs());
    if (imagesWindow <= 0) {
      markCap('budget');
    } else {
      readiness.imagesReady = await pollImagesReady(page, imagesWindow);
      if (!readiness.imagesReady) {
        markCap(imagesWindow < caps.imagesMs ? 'budget' : 'images');
      }
    }

    // Step 4: final layout settle (bounded).
    const settleWindow = Math.min(caps.settleMs, remainingMs());
    if (settleWindow > 0) {
      try {
        await page.waitForTimeout(settleWindow);
      } catch {
        // Page tore down mid-settle — readiness flags already recorded.
      }
    }
  } catch {
    // Never throws: unexpected failures leave the recorded flags as-is.
  }

  return cappedAt === undefined ? readiness : { ...readiness, cappedAt };
}

/**
 * Consumer-facing diagnostic when the readiness pipeline could not confirm
 * a fully settled page (mirror of scrollResetDiagnostic). Returns null when
 * every gate passed.
 */
export function readinessDiagnostic(readiness: PageReadiness): string | null {
  if (readiness.fontsReady && readiness.networkSettled && readiness.imagesReady) {
    return null;
  }
  const gaps: string[] = [];
  if (!readiness.fontsReady) gaps.push('fonts');
  if (!readiness.networkSettled) gaps.push('network idle');
  if (!readiness.imagesReady) gaps.push('images');
  const cap = readiness.cappedAt !== undefined ? ` (capped at: ${readiness.cappedAt})` : '';
  return `post-scroll readiness incomplete: ${gaps.join(', ')}${cap}; capture proceeded`;
}

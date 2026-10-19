/**
 * apograph — resilient navigation readiness (remediation record #16).
 *
 * Several real sites never reach Playwright's `networkidle` state within the
 * navigation timeout (persistent analytics/streaming connections), which made
 * hard `waitUntil: 'networkidle'` navigations fail outright: whole routes were
 * dropped and capture-state reloads proceeded on half-loaded documents. This
 * helper keeps `networkidle` as the preferred settle state but treats a
 * timeout on an *committed* navigation as "settled without idle": the caller
 * receives an explicit outcome and decides how to proceed (the crawler records
 * a diagnostic and runs its readiness passes instead of losing the page).
 *
 * Genuine navigation failures (DNS, refused connection, no committed
 * navigation) still throw — only idle-wait timeouts degrade gracefully.
 */

import type { Page } from 'playwright';

/** Outcome of a navigation attempt. */
export interface NavigationOutcome {
  /** True when the navigation committed (the page shows a live http(s) URL). */
  navigated: boolean;
  /** True when network idle settled within the timeout. */
  settled: boolean;
  /** Diagnostic note when the navigation committed without a clean settle. */
  note?: string;
}

/** Options for {@link gotoWithReadiness} / {@link reloadWithReadiness}. */
export interface NavigationReadinessOptions {
  /** Preferred settle timeout for `networkidle`, in ms. */
  timeoutMs?: number;
  /** Post-timeout settle delay used before capture, in ms. */
  settleMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SETTLE_MS = 2_000;

function isTimeoutError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'TimeoutError';
}

function isLiveHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function committedWithoutIdle(
  page: Page,
  action: string,
  options: NavigationReadinessOptions,
): Promise<NavigationOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  try {
    await page.waitForTimeout(settleMs);
  } catch {
    // Page may be navigating away; the caller's readiness pass will observe it.
  }
  return {
    navigated: true,
    settled: false,
    note:
      `${action} committed but network idle did not settle within ${timeoutMs}ms ` +
      `(persistent connections); capture proceeded after a ${settleMs}ms settle`,
  };
}

/**
 * Navigates to `url` preferring a `networkidle` settle. A timeout on a
 * committed navigation degrades to `settled: false` with a diagnostic note;
 * real navigation failures still throw.
 */
export async function gotoWithReadiness(
  page: Page,
  url: string,
  options: NavigationReadinessOptions = {},
): Promise<NavigationOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
    return { navigated: true, settled: true };
  } catch (cause) {
    if (isTimeoutError(cause) && isLiveHttpUrl(page.url())) {
      return committedWithoutIdle(page, 'navigation', options);
    }
    throw cause;
  }
}

/**
 * Reloads the current document with the same settle semantics as
 * {@link gotoWithReadiness}. A reload timeout on a live document degrades to
 * `settled: false` (the existing document remains capturable).
 */
export async function reloadWithReadiness(
  page: Page,
  options: NavigationReadinessOptions = {},
): Promise<NavigationOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    await page.reload({ waitUntil: 'networkidle', timeout: timeoutMs });
    return { navigated: true, settled: true };
  } catch (cause) {
    if (isTimeoutError(cause) && isLiveHttpUrl(page.url())) {
      return committedWithoutIdle(page, 'reload', options);
    }
    throw cause;
  }
}

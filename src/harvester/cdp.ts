/**
 * apograph — CDP attach/detach primitives (Layer 1: Capture).
 *
 * Attaches to an already-running Chrome instance over the Chrome DevTools
 * Protocol, preserving the user's logged-in browser state. Harvest hooks
 * (network, a11y) are wired elsewhere; this module only manages the
 * connection lifecycle.
 */

import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';

/** Options for attaching to a running Chrome instance over CDP. */
export interface AttachOptions {
  /** Remote debugging port. Defaults to 9222. */
  port?: number;
  /** Host running Chrome. Defaults to 'localhost'. */
  host?: string;
}

/** Connection handle returned by {@link attachToCDP}. */
export interface CDPConnection {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 9222;

/**
 * Attaches to a running Chrome instance via `chromium.connectOverCDP`.
 *
 * Acquires the first active context (or creates one) and the first active
 * tab (or opens a new page). If the connection is refused, throws an Error
 * with instructions for launching Chrome with remote debugging enabled.
 */
export async function attachToCDP(options: AttachOptions = {}): Promise<CDPConnection> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const endpoint = `http://${host}:${port}`;

  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(endpoint);
  } catch (cause) {
    throw new Error(
      `Failed to attach to Chrome over CDP at ${endpoint}. ` +
        'Launch Chrome with remote debugging enabled, e.g.:\n' +
        '  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\\n' +
        `    --remote-debugging-port=${port}\n` +
        `Caused by: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  const context: BrowserContext = browser.contexts()[0] ?? (await browser.newContext());
  const page: Page = context.pages()[0] ?? (await context.newPage());

  return { browser, context, page };
}

/**
 * Closes the CDP connection cleanly. Because the connection was established
 * with `connectOverCDP`, the user's host Chrome instance keeps running —
 * only the Playwright attachment is severed.
 */
export async function disconnectCDP(browser: Browser): Promise<void> {
  await browser.close();
}

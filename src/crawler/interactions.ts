/**
 * apograph — SPA-aware interactive state discovery (Layer 1b).
 *
 * Complements the href-following crawl engine with modal & overlay
 * detection: probes up to 15 clickable elements per page (buttons,
 * `[role="button"]`, `a` without href or with `href="#"`), and records a
 * `ModalCapture` whenever clicking an element reveals a NEW overlay
 * (`[role="dialog"]`, `.modal`, `[aria-modal="true"]`, or a visible
 * `position: fixed` element that is elevated (z-index >= 30) or covers
 * most of the viewport) that was not present before the click.
 *
 * All in-page evaluate functions are fully self-contained (no
 * module-scope references), per patch spec s2.1. Per-element failures are
 * caught and skipped silently so one stubborn widget can never break a
 * crawl.
 */

import { join } from 'node:path';
import type { ElementHandle, Page } from 'playwright';
import type { CrawlRoute, ModalCapture } from '../types.js';

// ---------------------------------------------------------------------------
// Options & constants
// ---------------------------------------------------------------------------

/** Max clickable elements probed per page (infinite-loop guard). */
const MAX_INTERACTIVE_ELEMENTS = 15;

/** Wait after a click for modal open animations to settle. */
const MODAL_SETTLE_MS = 800;

/** Wait after dismissing a modal for its close animation. */
const DISMISS_SETTLE_MS = 400;

/** Per-element click timeout (hidden / off-screen elements). */
const CLICK_TIMEOUT_MS = 2_000;

/** Desktop capture viewport (mirrors engine.ts). */
const DESKTOP_VIEWPORT = { width: 1280, height: 800 } as const;

/** Mobile capture viewport (mirrors engine.ts). */
const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;

/** Union selector for clickable elements probed on each page. */
const CLICKABLE_SELECTOR = 'button, [role="button"], a:not([href]), a[href="#"]';

/** Union selector for modal / overlay containers. */
const OVERLAY_SELECTOR = '[role="dialog"], .modal, [aria-modal="true"]';

/**
 * Cap on elements scanned for the fixed-layer overlay heuristic (elevated
 * z-index or viewport-covering), so huge DOMs cannot blow the per-page time
 * budget.
 */
const MAX_FIXED_OVERLAY_SCAN = 2_000;

// ---------------------------------------------------------------------------
// Self-contained in-page collectors (patch spec s2.1)
// ---------------------------------------------------------------------------

/**
 * In-page descriptor builder: renders a readable selector for one probed
 * clickable element (`button#cta.primary ( "Get started" )`).
 */
function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  let selector = tag;
  if (el.id.length > 0) selector += `#${el.id}`;
  const className = typeof el.className === 'string' ? el.className.trim() : '';
  if (className.length > 0) {
    selector += className
      .split(/\s+/)
      .slice(0, 3)
      .map((cls) => `.${cls}`)
      .join('');
  }
  const label =
    el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 24);
  return label.length > 0 ? `${selector} ( "${label}" )` : selector;
}

/**
 * In-page "before" snapshot: records `document.body`'s child count and tags
 * every currently visible overlay with a marker attribute, so the "after"
 * pass can tell NEW overlays apart from ones that already existed (including
 * ones that were merely hidden before the click).
 */
function markExistingOverlays(): { bodyChildCount: number; markedOverlays: number } {
  const isVisible = (el: Element): boolean => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const collectOverlays = (): Element[] => {
    const found: Element[] = [];
    for (const el of Array.from(document.querySelectorAll('[role="dialog"], .modal, [aria-modal="true"]'))) {
      if (isVisible(el)) found.push(el);
    }
    if (document.body !== null) {
      let scanned = 0;
      for (const el of Array.from(document.body.querySelectorAll('*'))) {
        scanned += 1;
        if (scanned > 2000) break;
        const style = window.getComputedStyle(el);
        if (style.position !== 'fixed') continue;
        const zIndex = Number.parseInt(style.zIndex, 10);
        const rect = el.getBoundingClientRect();
        // Modal heuristic (generic): an elevated fixed layer (z-index >= 30 —
        // the conventional Tailwind z-50 dialog band) or a fixed layer
        // covering most of the viewport (full-screen drawers/sheets).
        const coversViewport =
          rect.width >= window.innerWidth * 0.6 && rect.height >= window.innerHeight * 0.6;
        const elevated = !Number.isNaN(zIndex) && zIndex >= 30;
        if (!elevated && !coversViewport) continue;
        if (isVisible(el)) found.push(el);
      }
    }
    return found;
  };

  let markedOverlays = 0;
  for (const el of collectOverlays()) {
    el.setAttribute('data-apograph-overlay-seen', '1');
    markedOverlays += 1;
  }

  return {
    bodyChildCount: document.body !== null ? document.body.children.length : 0,
    markedOverlays,
  };
}

/**
 * In-page "after" snapshot: collects overlays that are visible now and were
 * NOT tagged by the "before" pass (i.e. genuinely new state revealed by the
 * click), resolves each one's accessible name, and cleans up the markers.
 */
function collectNewOverlays(): Array<{ name: string | null }> {
  const isVisible = (el: Element): boolean => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const collectOverlays = (): Element[] => {
    const found: Element[] = [];
    for (const el of Array.from(document.querySelectorAll('[role="dialog"], .modal, [aria-modal="true"]'))) {
      if (isVisible(el)) found.push(el);
    }
    if (document.body !== null) {
      let scanned = 0;
      for (const el of Array.from(document.body.querySelectorAll('*'))) {
        scanned += 1;
        if (scanned > 2000) break;
        const style = window.getComputedStyle(el);
        if (style.position !== 'fixed') continue;
        const zIndex = Number.parseInt(style.zIndex, 10);
        const rect = el.getBoundingClientRect();
        // Modal heuristic (generic): an elevated fixed layer (z-index >= 30 —
        // the conventional Tailwind z-50 dialog band) or a fixed layer
        // covering most of the viewport (full-screen drawers/sheets).
        const coversViewport =
          rect.width >= window.innerWidth * 0.6 && rect.height >= window.innerHeight * 0.6;
        const elevated = !Number.isNaN(zIndex) && zIndex >= 30;
        if (!elevated && !coversViewport) continue;
        if (isVisible(el)) found.push(el);
      }
    }
    return found;
  };

  const accessibleName = (el: Element): string | null => {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel !== null && ariaLabel.trim().length > 0) {
      return ariaLabel.trim();
    }
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy !== null && labelledBy.trim().length > 0) {
      const label = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
        .filter((text) => text.length > 0)
        .join(' ');
      if (label.length > 0) return label;
    }
    const heading = el.querySelector('h1, h2, h3');
    const headingText = heading?.textContent?.trim();
    if (headingText !== undefined && headingText.length > 0) {
      return headingText;
    }
    return null;
  };

  const overlays = collectOverlays();
  const fresh: Array<{ name: string | null }> = [];
  for (const el of overlays) {
    if (!el.hasAttribute('data-apograph-overlay-seen')) {
      fresh.push({ name: accessibleName(el) });
    }
    el.removeAttribute('data-apograph-overlay-seen');
  }
  return fresh;
}

// ---------------------------------------------------------------------------
// Interactive state discovery
// ---------------------------------------------------------------------------

/** Derives a filesystem-safe slug from a route path (`/` -> `index`). */
function slugFromPath(pathname: string): string {
  const slug = pathname
    .split('/')
    .filter(Boolean)
    .join('-')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length > 0 ? slug : 'index';
}

/**
 * Probes up to 15 clickable elements on the page and records a
 * `ModalCapture` (dual-viewport screenshots + accessible name + trigger
 * selector) for every element whose click reveals a new modal or overlay.
 *
 * Each probed element is dismissed again (Escape, then a body click at
 * 0,0) before moving on, so the page returns to its resting state. Any
 * per-element error is caught and skipped silently.
 *
 * `deadlineAt` bounds the total added time for this page (shared with the
 * hash-anchor pass in the engine) so SPA probing never exceeds the
 * per-page budget.
 */
export async function discoverInteractiveStates(
  page: Page,
  route: Pick<CrawlRoute, 'path'>,
  screenshotsDir: string,
  deadlineAt?: number,
): Promise<ModalCapture[]> {
  const captures: ModalCapture[] = [];
  const slug = slugFromPath(route.path);

  let handles: ElementHandle[] = [];
  try {
    handles = await page.$$(CLICKABLE_SELECTOR);
  } catch {
    return captures;
  }

  for (let index = 0; index < handles.length && index < MAX_INTERACTIVE_ELEMENTS; index += 1) {
    if (deadlineAt !== undefined && Date.now() > deadlineAt) break;
    const handle = handles[index];
    if (handle === undefined) continue;

    // Per-element isolation: any failure skips this element silently.
    try {
      const triggerSelector = await handle.evaluate(describeElement);

      // "Before" DOM snapshot: body child count + markers on existing overlays.
      await page.evaluate(markExistingOverlays);

      await handle.click({ timeout: CLICK_TIMEOUT_MS });
      await page.waitForTimeout(MODAL_SETTLE_MS);

      const newOverlays = await page.evaluate(collectNewOverlays);
      if (newOverlays.length > 0) {
        const modalName = newOverlays[0]?.name ?? 'Unnamed modal';
        const desktopScreenshot = join(screenshotsDir, `${slug}-modal-${index}-desktop.png`);
        const mobileScreenshot = join(screenshotsDir, `${slug}-modal-${index}-mobile.png`);

        await page.setViewportSize({ ...DESKTOP_VIEWPORT });
        await page.screenshot({ path: desktopScreenshot, type: 'png' });
        await page.setViewportSize({ ...MOBILE_VIEWPORT });
        await page.screenshot({ path: mobileScreenshot, type: 'png' });
        await page.setViewportSize({ ...DESKTOP_VIEWPORT });

        captures.push({
          triggerSelector,
          modalName,
          desktopScreenshot,
          mobileScreenshot,
        });
      }

      // Dismiss whatever the click opened: Escape first, then a click at
      // the page's top-left corner (outside any centered overlay).
      try {
        await page.keyboard.press('Escape');
      } catch {
        // Keyboard unavailable — the outside click below still applies.
      }
      try {
        await page.mouse.click(0, 0);
      } catch {
        // Pointer events unavailable — Escape above still applies.
      }
      await page.waitForTimeout(DISMISS_SETTLE_MS);
    } catch {
      // Broken / hidden / flaky element — continue silently (constraint).
      continue;
    }
  }

  return captures;
}

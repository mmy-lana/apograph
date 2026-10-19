/**
 * apograph — Evidence Review Gate (Gate 1, spec s3).
 *
 * No evidence enters synthesis without either explicit human approval
 * (interactive mode, s3.1) or automated health-check filtering
 * (non-interactive mode, s3.2):
 *
 * - Interactive: evidence summary table, file manager launcher over
 *   `.apograph/evidence/screenshots/`, selective re-crawl by route index
 *   (`2,5,7`, `2-5`), route prune/alias controls, approve/abort.
 * - Non-interactive: automatic aliasing of instant redirect transition
 *   frames (s2.2) and pruning of blank frames (s2.1), with every decision
 *   recorded in `evidence-gate.json` for later audit.
 *
 * spec: integration/visual-resilience s3, s8.5
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import type { A11yNode, CrawlRoute, EvidenceManifest } from '../types.js';
import { checkCaptureHealth } from '../crawler/health.js';
import type { CaptureHealth } from '../crawler/health.js';
import { resolveEvidenceReference, toEvidenceRelativePath } from '../utils/fs-safe.js';
import {
  autoScrollWithReset,
  readinessDiagnostic,
  scrollResetDiagnostic,
  waitForPageReadiness,
} from '../crawler/scroll.js';
import { captureDOMSnapshot } from '../harvester/dom.js';
import { launchHeadlessChromium } from '../crawler/engine.js';
import { validateNetworkUrl } from '../crawler/network-policy.js';

// ---------------------------------------------------------------------------
// Index parsing (spec s8.5)
// ---------------------------------------------------------------------------

/**
 * Parses a route-index selection such as `2,5,7` or `2-5` into a sorted,
 * deduplicated list of 1-based indices. Bounds are validated against
 * `maxIndex`; invalid input throws a clear, actionable error (s8.5).
 */
export function parseRouteIndices(input: string, maxIndex: number): number[] {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error('No route indices given. Enter indices like `2,5,7` or a range like `2-5`.');
  }
  if (!Number.isInteger(maxIndex) || maxIndex < 1) {
    throw new Error(`No routes available to select (max index ${maxIndex}).`);
  }

  const selected = new Set<number>();
  for (const token of trimmed.split(',')) {
    const part = token.trim();
    if (part.length === 0) {
      throw new Error(
        `Empty selection between commas in "${input}". Use indices like \`2,5,7\`.`,
      );
    }

    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch !== null) {
      const from = Number(rangeMatch[1]);
      const to = Number(rangeMatch[2]);
      if (from < 1 || to > maxIndex || from > to) {
        throw new Error(
          `Range "${part}" is out of bounds: indices run 1-${maxIndex} and the range start must not exceed its end.`,
        );
      }
      for (let i = from; i <= to; i++) selected.add(i);
      continue;
    }

    if (!/^\d+$/.test(part)) {
      throw new Error(
        `Invalid selection token "${part}". Use route indices like \`2,5,7\` or ranges like \`2-5\`.`,
      );
    }

    const index = Number(part);
    if (index < 1 || index > maxIndex) {
      throw new Error(
        `Route index ${index} is out of bounds: this evidence set has ${maxIndex} route(s) (indices 1-${maxIndex}).`,
      );
    }
    selected.add(index);
  }

  return [...selected].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Gate records (spec s3.2)
// ---------------------------------------------------------------------------

/** Status of one route through the gate. */
export type GateRouteStatus = 'ok' | 'aliased' | 'pruned' | 'error';

/** Per-route health verdict recorded by the gate. */
export interface GateRouteVerdict {
  /** 1-based route index (as shown in the summary table). */
  index: number;
  url: string;
  path: string;
  status: GateRouteStatus;
  health: CaptureHealth | null;
  screenshot: string | null;
}

/** The complete decision record persisted to `evidence-gate.json`. */
export interface EvidenceGateRecord {
  mode: 'interactive' | 'non-interactive';
  generatedAt: string;
  verdicts: GateRouteVerdict[];
  pruned: Array<{ path: string; reason: string }>;
  aliases: Array<{ from: string; to: string }>;
  reCrawled: string[];
}

/** Thrown when the reviewer aborts the interactive gate. */
export class EvidenceGateAbortedError extends Error {
  constructor() {
    super('Evidence review gate aborted by the reviewer.');
    this.name = 'EvidenceGateAbortedError';
  }
}

/** Options for {@link runEvidenceReviewGate}. */
export interface EvidenceGateOptions {
  /** Skip interactive review entirely (also implied when stdout is not a TTY). */
  nonInteractive?: boolean;
  /**
   * Re-captures one route (1-based index into the manifest) and returns the
   * updated route. Omit to disable selective re-crawl in interactive mode.
   */
  reCrawlRoute?: (routeIndex: number) => Promise<CrawlRoute>;
}

// ---------------------------------------------------------------------------
// Health evaluation on persisted evidence
// ---------------------------------------------------------------------------

/** Counts nodes in an a11y tree (proxy for visible DOM node count). */
function countA11yNodes(node: A11yNode): number {
  let count = 1;
  for (const child of node.children ?? []) count += countA11yNodes(child);
  return count;
}

/**
 * Re-evaluates capture health for a route from its persisted screenshot.
 * Manifest screenshot references may be bundle-relative (preferred) or
 * absolute (older bundles); both resolve to the same evidence file.
 */
async function routeHealth(route: CrawlRoute, evidenceDir: string): Promise<CaptureHealth | null> {
  const reference = route.desktopScreenshot;
  if (reference === null) return null;
  const screenshot = resolveEvidenceReference(evidenceDir, reference);
  if (!existsSync(screenshot)) return null;
  try {
    const png = await readFile(screenshot);
    return checkCaptureHealth(png, countA11yNodes(route.a11yTree));
  } catch {
    return null;
  }
}

/**
 * Records a capture path into the manifest in the bundle-relative form when
 * possible, keeping the absolute form only for legacy out-of-bundle paths.
 */
function captureReference(evidenceDir: string, absolutePath: string): string {
  try {
    return toEvidenceRelativePath(evidenceDir, absolutePath);
  } catch {
    return absolutePath;
  }
}

// ---------------------------------------------------------------------------
// Non-interactive filtering (spec s3.2)
// ---------------------------------------------------------------------------

/**
 * Automated gate pass: aliases instant redirect transition frames (s2.2),
 * prunes blank frames (s2.1) from the active synthesis inputs, and writes
 * `evidence-gate.json` recording every verdict and action taken.
 */
export async function filterEvidenceNonInteractive(
  manifest: EvidenceManifest,
  evidenceDir: string,
): Promise<{ manifest: EvidenceManifest; record: EvidenceGateRecord }> {
  const verdicts: GateRouteVerdict[] = [];
  const pruned: Array<{ path: string; reason: string }> = [];
  const aliases: Array<{ from: string; to: string }> = [];
  const activeRoutes: CrawlRoute[] = [];

  const crawlAliases = manifest.diagnostics.redirectAliases ?? [];

  for (const [arrayIndex, route] of manifest.routes.entries()) {
    const index = arrayIndex + 1;
    const health = await routeHealth(route, evidenceDir);

    const crawlAlias = crawlAliases.find((alias) => alias.from === route.url);
    if (crawlAlias !== undefined) {
      verdicts.push({
        index,
        url: route.url,
        path: route.path,
        status: 'aliased',
        health,
        screenshot: route.desktopScreenshot,
      });
      aliases.push({ from: crawlAlias.from, to: crawlAlias.to });
      continue;
    }

    if (health?.blank === true) {
      verdicts.push({
        index,
        url: route.url,
        path: route.path,
        status: 'pruned',
        health,
        screenshot: route.desktopScreenshot,
      });
      pruned.push({ path: route.path, reason: `blank capture frame (${health.reason ?? 'unknown'})` });
      continue;
    }

    verdicts.push({
      index,
      url: route.url,
      path: route.path,
      status: 'ok',
      health,
      screenshot: route.desktopScreenshot,
    });
    activeRoutes.push(route);
  }

  const record: EvidenceGateRecord = {
    mode: 'non-interactive',
    generatedAt: new Date().toISOString(),
    verdicts,
    pruned,
    aliases,
    reCrawled: [],
  };

  await writeFile(
    join(evidenceDir, 'evidence-gate.json'),
    JSON.stringify(record, null, 2),
    'utf8',
  );

  return {
    manifest: { ...manifest, routes: activeRoutes },
    record,
  };
}

// ---------------------------------------------------------------------------
// Interactive gate (spec s3.1)
// ---------------------------------------------------------------------------

/** Renders the evidence summary table (s3.1 step 1). */
function renderSummaryTable(verdicts: GateRouteVerdict[]): void {
  console.log('');
  console.log('Evidence summary:');
  console.log(
    '#   Path                 Status   Health   DOM nodes   Uniformity        Screenshot',
  );
  for (const verdict of verdicts) {
    const health = verdict.health;
    const uniformity =
      health === null
        ? '-'
        : `${(health.uniformityRatio * 100).toFixed(1)}% (${health.dominantColor ?? 'n/a'})`;
    const domNodes = health === null ? '-' : String(health.visibleNodeCount);
    const flag =
      verdict.status === 'pruned' || verdict.status === 'aliased' ? '  <-- suspect' : '';
    console.log(
      `${String(verdict.index).padEnd(4)}` +
        `${verdict.path.padEnd(21)}` +
        `${verdict.status.padEnd(9)}` +
        `${(health === null ? '-' : health.blank ? 'SUSPECT' : 'HEALTHY').padEnd(9)}` +
        `${domNodes.padEnd(12)}` +
        `${uniformity.padEnd(18)}` +
        `${verdict.screenshot ?? '-'}${flag}`,
    );
  }
  console.log('');
}

/** Opens the platform file manager at the screenshots directory (s3.1 step 2). */
export async function openScreenshotsDir(screenshotsDir: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const opener =
    platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'cmd.exe' : 'xdg-open';
  const args = platform() === 'win32' ? ['/c', 'start', '', screenshotsDir] : [screenshotsDir];
  execFile(opener, args);
}

/** Re-evaluates one route's verdict after a re-crawl. */
function refreshVerdict(
  verdicts: GateRouteVerdict[],
  index: number,
  route: CrawlRoute,
  health: CaptureHealth | null,
): void {
  const verdict = verdicts.find((entry) => entry.index === index);
  if (verdict === undefined) return;
  verdict.url = route.url;
  verdict.path = route.path;
  verdict.health = health;
  verdict.screenshot = route.desktopScreenshot;
  verdict.status = health !== null && health.blank ? 'pruned' : 'ok';
}

/**
 * Runs Gate 1 (s3). Non-interactive mode (or a non-TTY session) delegates to
 * {@link filterEvidenceNonInteractive}. Interactive mode presents the summary
 * table, the file manager launcher, and prune/alias/re-crawl/approve/abort
 * controls until the reviewer approves the evidence set.
 */
export async function runEvidenceReviewGate(
  manifest: EvidenceManifest,
  evidenceDir: string,
  options: EvidenceGateOptions = {},
): Promise<{ manifest: EvidenceManifest; record: EvidenceGateRecord }> {
  const nonInteractive =
    options.nonInteractive === true || process.stdout.isTTY !== true;

  if (nonInteractive) {
    return filterEvidenceNonInteractive(manifest, evidenceDir);
  }

  const verdicts: GateRouteVerdict[] = [];
  for (const [arrayIndex, route] of manifest.routes.entries()) {
    verdicts.push({
      index: arrayIndex + 1,
      url: route.url,
      path: route.path,
      status: 'ok',
      health: await routeHealth(route, evidenceDir),
      screenshot: route.desktopScreenshot,
    });
  }

  const pruned: Array<{ path: string; reason: string }> = [];
  const aliases: Array<{ from: string; to: string }> = [];
  const reCrawled: string[] = [];
  const activeRoutes = new Map<number, CrawlRoute>(
    manifest.routes.map((route, arrayIndex) => [arrayIndex + 1, route]),
  );

  renderSummaryTable(verdicts);

  for (;;) {
    const action = await p.select({
      message: 'Evidence review action',
      options: [
        { value: 'open', label: 'Open screenshots folder', hint: 'inspect full-resolution captures' },
        ...(options.reCrawlRoute !== undefined
          ? [{ value: 'recrawl', label: 'Re-crawl routes by index (e.g. 2,5,7 or 2-5)' }]
          : []),
        { value: 'prune', label: 'Prune routes by index' },
        { value: 'alias', label: 'Alias a route to another route' },
        { value: 'approve', label: 'Approve evidence and continue' },
        { value: 'abort', label: 'Abort' },
      ],
    });
    if (p.isCancel(action)) throw new EvidenceGateAbortedError();

    if (action === 'open') {
      await openScreenshotsDir(join(evidenceDir, 'screenshots'));
      continue;
    }

    if (action === 'approve') break;

    if (action === 'abort') throw new EvidenceGateAbortedError();

    if (action === 'recrawl' && options.reCrawlRoute !== undefined) {
      const answer = await p.text({
        message: `Route indices to re-crawl (1-${manifest.routes.length}, e.g. 2,5,7 or 2-5)`,
      });
      if (p.isCancel(answer)) throw new EvidenceGateAbortedError();
      let indices: number[];
      try {
        indices = parseRouteIndices(answer, manifest.routes.length);
      } catch (cause) {
        console.error(`x ${(cause as Error).message}`);
        continue;
      }
      for (const index of indices) {
        const route = await options.reCrawlRoute(index);
        activeRoutes.set(index, route);
        reCrawled.push(route.path);
        refreshVerdict(verdicts, index, route, await routeHealth(route, evidenceDir));
      }
      renderSummaryTable(verdicts);
      continue;
    }

    if (action === 'prune') {
      const answer = await p.text({
        message: `Route indices to prune (1-${manifest.routes.length}, e.g. 2,5,7)`,
      });
      if (p.isCancel(answer)) throw new EvidenceGateAbortedError();
      let indices: number[];
      try {
        indices = parseRouteIndices(answer, manifest.routes.length);
      } catch (cause) {
        console.error(`x ${(cause as Error).message}`);
        continue;
      }
      for (const index of indices) {
        const verdict = verdicts.find((entry) => entry.index === index);
        if (verdict === undefined || verdict.status === 'pruned') continue;
        verdict.status = 'pruned';
        activeRoutes.delete(index);
        pruned.push({ path: verdict.path, reason: 'pruned by reviewer' });
      }
      renderSummaryTable(verdicts);
      continue;
    }

    if (action === 'alias') {
      const fromAnswer = await p.text({
        message: `Index of the route to alias (1-${manifest.routes.length})`,
      });
      if (p.isCancel(fromAnswer)) throw new EvidenceGateAbortedError();
      const toAnswer = await p.text({
        message: `Index of the healthy route to alias it to (1-${manifest.routes.length})`,
      });
      if (p.isCancel(toAnswer)) throw new EvidenceGateAbortedError();

      let fromIndex = Number.NaN;
      let toIndex = Number.NaN;
      try {
        const from = parseRouteIndices(fromAnswer, manifest.routes.length);
        const to = parseRouteIndices(toAnswer, manifest.routes.length);
        fromIndex = from[0] ?? Number.NaN;
        toIndex = to[0] ?? Number.NaN;
      } catch (cause) {
        console.error(`x ${(cause as Error).message}`);
        continue;
      }
      if (Number.isNaN(fromIndex) || Number.isNaN(toIndex)) continue;

      const fromVerdict = verdicts.find((entry) => entry.index === fromIndex);
      const toVerdict = verdicts.find((entry) => entry.index === toIndex);
      if (fromVerdict === undefined || toVerdict === undefined) continue;
      if (toVerdict.status === 'pruned' || toVerdict.health?.blank === true) {
        console.error('x Alias target must be a healthy route.');
        continue;
      }

      fromVerdict.status = 'aliased';
      activeRoutes.delete(fromIndex);
      aliases.push({ from: fromVerdict.url, to: toVerdict.url });
      renderSummaryTable(verdicts);
      continue;
    }
  }

  const record: EvidenceGateRecord = {
    mode: 'interactive',
    generatedAt: new Date().toISOString(),
    verdicts,
    pruned,
    aliases,
    reCrawled,
  };

  await writeFile(
    join(evidenceDir, 'evidence-gate.json'),
    JSON.stringify(record, null, 2),
    'utf8',
  );

  return {
    manifest: { ...manifest, routes: [...activeRoutes.entries()].map(([, route]) => route) },
    record,
  };
}

// ---------------------------------------------------------------------------
// Selective re-crawl (spec s3.1 step 3)
// ---------------------------------------------------------------------------

/**
 * Re-captures one manifest route in place: navigation, dual-viewport
 * screenshots (same paths), DOM snapshot (a11y + tokens + text corpus),
 * then rewrites the evidence manifest. Used by the interactive gate's
 * selective re-crawl action.
 */
export async function recrawlRoute(
  manifest: EvidenceManifest,
  routeIndex: number,
  evidenceDir: string,
): Promise<CrawlRoute> {
  if (routeIndex < 1 || routeIndex > manifest.routes.length) {
    throw new Error(
      `Route index ${routeIndex} is out of bounds: this evidence set has ${manifest.routes.length} route(s).`,
    );
  }
  const route = manifest.routes[routeIndex - 1] as CrawlRoute;
  // Stored references may be bundle-relative (preferred) or absolute (older
  // bundles); resolve to concrete capture targets, and record the result back
  // in the bundle-relative form so the manifest stays relocatable.
  const desktopPath = route.desktopScreenshot === null
    ? join(evidenceDir, 'screenshots', 'recrawl-desktop.png')
    : resolveEvidenceReference(evidenceDir, route.desktopScreenshot);
  const mobilePath = route.mobileScreenshot === null
    ? join(evidenceDir, 'screenshots', 'recrawl-mobile.png')
    : resolveEvidenceReference(evidenceDir, route.mobileScreenshot);

  const browser = await launchHeadlessChromium();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.route('**/*', async (requestRoute) => {
      const resourceUrl = requestRoute.request().url();
      if (/^(data:|blob:|about:)/i.test(resourceUrl)) {
        await requestRoute.continue();
        return;
      }
      try {
        await validateNetworkUrl(resourceUrl);
        await requestRoute.continue();
      } catch {
        await requestRoute.abort('blockedbyclient');
      }
    });
    await validateNetworkUrl(route.url);
    const page = await context.newPage();
    await page.goto(route.url, { waitUntil: 'networkidle', timeout: 30_000 });
    const title = await page.title();

    // Patch spec s3.1 + amendment A1: bounded auto-scroll, settle delay,
    // and the hardened scroll reset (R1-R4) before capture (same ordering
    // as the crawl engine).
    const scroll = await autoScrollWithReset(page);
    if (!scroll.confirmedTop) {
      // Amendment A1 R3: unconfirmed reset is a diagnostic, never an error.
      console.warn(
        `[apograph] re-crawl ${route.path}: ${scrollResetDiagnostic(scroll)}`,
      );
    }

    // Post-scroll readiness (fonts, network settle, lazy images) before any
    // capture; incomplete readiness is a diagnostic, never an error.
    const readinessNote = readinessDiagnostic(await waitForPageReadiness(page));
    if (readinessNote !== null) {
      console.warn(`[apograph] re-crawl ${route.path}: ${readinessNote}`);
    }

    // Full-page captures for both viewports (patch spec s3.2).
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: desktopPath, type: 'png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: mobilePath, type: 'png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 800 });

    const snapshot = await captureDOMSnapshot(page, route.path);
    await context.close();

    const updated: CrawlRoute = {
      ...route,
      title: title.length > 0 ? title : route.title,
      desktopScreenshot: captureReference(evidenceDir, desktopPath),
      mobileScreenshot: captureReference(evidenceDir, mobilePath),
      a11yTree: snapshot.a11yTree,
      tokens: snapshot.tokens,
      textSpans: snapshot.textSpans,
    };

    manifest.routes[routeIndex - 1] = updated;
    await writeFile(
      join(evidenceDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );
    return updated;
  } finally {
    await browser.close();
  }
}

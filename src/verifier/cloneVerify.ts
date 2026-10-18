/**
 * apograph — Clone-vs-live comparison engine (clone-verify).
 *
 * Unlike the 3-tier verifier (which diffs the clone against stored evidence
 * screenshots), clone-verify compares the cloned project's dev server
 * side-by-side against the LIVE original site:
 *
 *   1. Boots the cloned project's Vite dev server (default port 5174).
 *   2. Launches two headless Chromium instances — one against the live
 *      original URL, one against the local dev server.
 *   3. For every discovered route: navigates both browsers, captures
 *      viewport screenshots, extracts computed font families, colors, and
 *      CSS animation names, and runs pixelmatch between the screenshots.
 *   4. Writes `<outputDir>/clone-verify-report.json` and returns the result.
 *
 * The Vite child process and both browsers are always torn down in
 * `finally` blocks — no orphaned processes.
 */

import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import type { ViewportMode } from '../types.js';
import { compareScreenshots } from './engine.js';
import { isDarkCanvasColor } from '../synthesizer/modular.js';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Font family comparison between original and cloned pages. */
export interface CloneVerifyFontReport {
  /** Font families computed on the original page. */
  original: string[];
  /** Font families computed on the cloned page. */
  cloned: string[];
  /** Original families that also appear on the clone. */
  matched: string[];
  /** Original families the clone is missing. */
  missing: string[];
}

/** Computed color comparison between original and cloned pages. */
export interface CloneVerifyColorReport {
  /** Hex colors computed on the original page. */
  original: string[];
  /** Hex colors computed on the cloned page. */
  cloned: string[];
  /** Original colors that also appear on the clone. */
  matched: string[];
  /** Original colors the clone is missing. */
  missing: string[];
}

/** One route's side-by-side comparison record. */
export interface CloneVerifyRoute {
  /** Route path (e.g. `/about`). */
  path: string;
  /** Local path of the original site's screenshot PNG. */
  originalScreenshot: string;
  /** Local path of the cloned dev server's screenshot PNG. */
  clonedScreenshot: string;
  /** Local path of the pixelmatch diff overlay PNG. */
  diffScreenshot: string;
  /** Pixel similarity 0–100 (higher is better). */
  pixelSimilarity: number;
  /** Font family comparison for this route. */
  fontReport: CloneVerifyFontReport;
  /** Computed color comparison for this route. */
  colorReport: CloneVerifyColorReport;
  /** CSS animation/keyframes names found in the original but not the clone. */
  animationsDetected: string[];
  /** True when pixelSimilarity >= threshold. */
  passed: boolean;
}

/** Aggregate scores across all compared routes. */
export interface CloneVerifySummary {
  /** Mean pixel similarity across routes (0–100). */
  averageSimilarity: number;
  /** Percentage of original font families present in the clones (0–100). */
  fontMatchScore: number;
  /** Percentage of original colors present in the clones (0–100). */
  colorMatchScore: number;
  /** Number of compared routes. */
  totalRoutes: number;
  /** Routes whose pixelSimilarity met the threshold. */
  passedRoutes: number;
}

/** Full clone-verify result (also persisted as clone-verify-report.json). */
export interface CloneVerifyResult {
  /** The original site URL the clone was compared against. */
  url: string;
  /** The cloned project directory. */
  outputDir: string;
  /** ISO-8601 timestamp of the comparison run. */
  generatedAt: string;
  /** Per-route comparison records. */
  routes: CloneVerifyRoute[];
  /** Aggregate scores. */
  summary: CloneVerifySummary;
}

/** Options for {@link runCloneVerify}. */
export interface CloneVerifyOptions {
  /** Original (live) site URL. */
  url: string;
  /** Cloned project directory (must contain an installable Vite project). */
  outputDir: string;
  /** Port for the cloned dev server. Defaults to 5174 (5173 may host the clone workflow itself). */
  port?: number;
  /** Minimum pixel similarity (0–100) for a route to pass. Defaults to 70. */
  threshold?: number;
  /** Viewport to compare. Defaults to `desktop`. */
  viewport?: ViewportMode;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default dev server port (avoids Vite's own 5173 default). */
const DEFAULT_PORT = 5174;

/** Default pixel similarity pass threshold (percent). */
const DEFAULT_THRESHOLD = 70;

/** How long to wait for the dev server port to become responsive. */
const DEV_SERVER_START_TIMEOUT_MS = 15_000;

/** Polling interval while waiting for the dev server. */
const DEV_SERVER_POLL_INTERVAL_MS = 250;

/** Per-navigation timeout. */
const NAVIGATION_TIMEOUT_MS = 30_000;

/** Desktop comparison viewport (mirrors the evidence crawl). */
const DESKTOP_VIEWPORT = { width: 1280, height: 800 } as const;

/** Mobile comparison viewport (mirrors the evidence crawl). */
const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;

/** Directory (inside outputDir) holding comparison screenshots. */
const SCREENSHOTS_DIRNAME = 'clone-verify';

/** Report filename written into outputDir. */
export const CLONE_VERIFY_REPORT_FILENAME = 'clone-verify-report.json';

// ---------------------------------------------------------------------------
// Self-contained in-page collectors
// ---------------------------------------------------------------------------

/** In-page collector: unique computed font families (max 20). */
function collectFontFamilies(): string[] {
  const families = new Set<string>();
  for (const el of Array.from(document.querySelectorAll('*'))) {
    const family = getComputedStyle(el).fontFamily;
    if (family.length > 0) families.add(family);
  }
  return [...families].slice(0, 20);
}

/** In-page collector: unique computed colors (max 30, `rgb(...)` form). */
function collectColors(): string[] {
  const colors = new Set<string>();
  for (const el of Array.from(document.querySelectorAll('*'))) {
    const style = getComputedStyle(el);
    colors.add(style.color);
    colors.add(style.backgroundColor);
  }
  return [...colors].filter((c) => c.startsWith('rgb')).slice(0, 30);
}

/** In-page collector: CSS rule texts defining animations (max 20). */
function collectAnimationRules(): string[] {
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        rules.push(rule.cssText);
      }
    } catch {
      // Cross-origin stylesheets throw on cssRules access; skip them.
    }
  }
  return rules
    .filter((rule) => rule.includes('@keyframes') || rule.includes('animation:'))
    .slice(0, 20);
}

// ---------------------------------------------------------------------------
// Dev server lifecycle
// ---------------------------------------------------------------------------

/** Vite dev server child process handle with guaranteed teardown. */
interface DevServerHandle {
  origin: string;
  kill(): Promise<void>;
}

/** True when an HTTP GET to the origin succeeds (any status). */
function probeOrigin(origin: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const request = httpGet(origin, (response) => {
      response.resume();
      resolveProbe(true);
    });
    request.on('error', () => resolveProbe(false));
  });
}

/**
 * Starts the cloned project's Vite dev server on `port` and waits up to
 * 15 seconds for the port to become responsive. Throws a clear actionable
 * error when the server never comes up (typically missing node_modules).
 */
async function startDevServer(outputDir: string, port: number): Promise<DevServerHandle> {
  const origin = `http://127.0.0.1:${port}`;

  const child = execFile(
    'npx',
    ['--no-install', 'vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: outputDir },
    () => {
      // Output is discarded; liveness is tracked via the port probe below.
    },
  );

  const deadline = Date.now() + DEV_SERVER_START_TIMEOUT_MS;
  let responsive = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    if (await probeOrigin(origin)) {
      responsive = true;
      break;
    }
    await new Promise((sleep) => setTimeout(sleep, DEV_SERVER_POLL_INTERVAL_MS));
  }

  if (!responsive) {
    await killProcessTree(child);
    throw new Error(
      `Could not start cloned dev server. Run pnpm install inside ${outputDir} first.`,
    );
  }

  return {
    origin,
    kill: () => killProcessTree(child),
  };
}

/** Terminates a child process, escalating from SIGTERM to SIGKILL. */
async function killProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;

  const exited = new Promise<void>((resolveExit) => {
    const timer = setTimeout(resolveExit, 3_000);
    const check = (): void => {
      if (child.exitCode !== null) {
        clearTimeout(timer);
        resolveExit();
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });

  child.kill('SIGTERM');
  await exited;
  if (child.exitCode === null) {
    child.kill('SIGKILL');
  }
}

// ---------------------------------------------------------------------------
// Route discovery
// ---------------------------------------------------------------------------

/** Extracts route paths from an evidence manifest's routes. */
async function detectedColorScheme(): Promise<'dark' | 'light'> {
  try {
    const raw: unknown = JSON.parse(await readFile(resolve('.apograph', 'evidence', 'manifest.json'), 'utf8'));
    if (typeof raw !== 'object' || raw === null || !('routes' in raw)) return 'light';
    const routes = (raw as { routes?: Array<{ tokens?: { canvas?: { backgroundColor?: unknown } } }> }).routes;
    if (!Array.isArray(routes)) return 'light';
    return routes.some((route) => {
      const background = route.tokens?.canvas?.backgroundColor;
      return typeof background === 'string' && isDarkCanvasColor(background);
    }) ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** Extracts route paths from an evidence manifest's routes. */
async function routesFromManifest(manifestPath: string): Promise<string[] | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (typeof raw !== 'object' || raw === null || !('routes' in raw)) return null;
    const routes = (raw as { routes: Array<{ path?: unknown }> }).routes;
    if (!Array.isArray(routes)) return null;
    const paths = routes
      .map((route) => (typeof route.path === 'string' ? route.path : null))
      .filter((path): path is string => path !== null);
    return paths.length > 0 ? paths : null;
  } catch {
    return null;
  }
}

/** Extracts route paths from the cloned project's generated `App.tsx`. */
async function routesFromAppTsx(outputDir: string): Promise<string[] | null> {
  try {
    const appTsx = await readFile(join(outputDir, 'src', 'App.tsx'), 'utf8');
    const paths = [...appTsx.matchAll(/<Route\s+path="([^"]*)"/g)]
      .map((match) => match[1] ?? '')
      .filter((path) => path !== '*' && path.length > 0);
    return paths.length > 0 ? [...new Set(paths)] : null;
  } catch {
    return null;
  }
}

/**
 * Discovers the route paths to compare:
 * 1. the evidence manifest beside the plan (`.apograph/evidence/manifest.json`,
 *    resolved against cwd and outputDir) when present;
 * 2. otherwise the generated `src/App.tsx` route table of the cloned project;
 * 3. otherwise just `/`.
 */
async function discoverRoutePaths(outputDir: string): Promise<string[]> {
  const manifestCandidates = [
    join('.apograph', 'evidence', 'manifest.json'),
    join(outputDir, '.apograph', 'evidence', 'manifest.json'),
    join(outputDir, 'evidence', 'manifest.json'),
  ];

  for (const candidate of manifestCandidates) {
    const paths = await routesFromManifest(resolve(candidate));
    if (paths !== null) return paths;
  }

  const appTsxRoutes = await routesFromAppTsx(outputDir);
  if (appTsxRoutes !== null) return appTsxRoutes;

  return ['/'];
}

// ---------------------------------------------------------------------------
// Extracted-artefact post-processing
// ---------------------------------------------------------------------------

/** Splits a computed font-family string into individual family names. */
function splitFontFamilies(families: string[]): string[] {
  const split = new Set<string>();
  for (const family of families) {
    for (const name of family.split(',')) {
      const normalized = name.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
      if (normalized.length > 0) split.add(normalized);
    }
  }
  return [...split];
}

/** Normalizes an `rgb(r, g, b)` / `rgba(...)` string to `#rrggbb` (alpha dropped). */
function rgbToHex(value: string): string | null {
  const match = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (match === null) return null;
  const r = Number.parseInt(match[1] as string, 10);
  const g = Number.parseInt(match[2] as string, 10);
  const b = Number.parseInt(match[3] as string, 10);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** Extracts animation names from collected CSS rule texts. */
function animationNames(rules: string[]): string[] {
  const names = new Set<string>();
  for (const rule of rules) {
    for (const match of rule.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)) {
      names.add(match[1] as string);
    }
    for (const match of rule.matchAll(/animation(?:-name)?\s*:\s*([^;]+)/g)) {
      for (const token of (match[1] as string).split(/\s+/)) {
        if (token.length === 0) continue;
        // Timing keywords and durations are not animation names.
        if (/^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|infinite|alternate|reverse|both|forwards|backwards|normal|none|running|paused)$/i.test(token)) continue;
        if (/^(\d|\.)[a-z]*$/i.test(token)) continue; // 0.3s, 300ms, 2s
        if (/^var\(|^[a-z-]+\(.*\)$/.test(token)) continue; // functions
        names.add(token);
      }
    }
  }
  return [...names];
}

/** Builds a matched/missing report for fonts. */
function buildFontReport(
  originalFamilies: string[],
  clonedFamilies: string[],
): CloneVerifyFontReport {
  const original = splitFontFamilies(originalFamilies);
  const cloned = new Set(splitFontFamilies(clonedFamilies));
  const matched = original.filter((family) => cloned.has(family));
  return {
    original: originalFamilies,
    cloned: clonedFamilies,
    matched,
    missing: original.filter((family) => !cloned.has(family)),
  };
}

/** Builds a matched/missing report for colors. */
function buildColorReport(
  originalColors: string[],
  clonedColors: string[],
): CloneVerifyColorReport {
  const toHexSet = (values: string[]): Set<string> => {
    const hexes = new Set<string>();
    for (const value of values) {
      const hex = rgbToHex(value);
      if (hex !== null) hexes.add(hex);
    }
    return hexes;
  };

  const originalHexes = toHexSet(originalColors);
  const clonedHexes = toHexSet(clonedColors);
  const matched = [...originalHexes].filter((hex) => clonedHexes.has(hex));
  const missing = [...originalHexes].filter((hex) => !clonedHexes.has(hex));

  return {
    original: [...originalHexes],
    cloned: [...clonedHexes],
    matched,
    missing,
  };
}

// ---------------------------------------------------------------------------
// Per-route comparison
// ---------------------------------------------------------------------------

/** Derives a filesystem-safe slug from a route path (`/` -> `index`). */
function slugForPath(pathname: string): string {
  const slug = pathname
    .split('/')
    .filter(Boolean)
    .join('-')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length > 0 ? slug : 'index';
}

/** Viewport size to compare for the selected mode (desktop wins for `both`). */
function comparisonViewport(viewport: ViewportMode): { size: typeof DESKTOP_VIEWPORT | typeof MOBILE_VIEWPORT; label: 'desktop' | 'mobile' } {
  if (viewport === 'mobile') return { size: { ...MOBILE_VIEWPORT }, label: 'mobile' };
  return { size: { ...DESKTOP_VIEWPORT }, label: 'desktop' };
}

/** Navigates the original page (networkidle) and the cloned page (load) in parallel. */
async function navigateBoth(
  originalPage: Page,
  clonedPage: Page,
  originalUrl: string,
  clonedUrl: string,
): Promise<void> {
  await Promise.all([
    originalPage.goto(originalUrl, {
      waitUntil: 'networkidle',
      timeout: NAVIGATION_TIMEOUT_MS,
    }),
    clonedPage.goto(clonedUrl, {
      waitUntil: 'load',
      timeout: NAVIGATION_TIMEOUT_MS,
    }),
  ]);

  // Give the cloned SPA a beat to mount React before screenshotting.
  try {
    await clonedPage.waitForSelector('#root > *', { timeout: 5_000 });
  } catch {
    // Never mounted — the screenshot records whatever rendered.
  }
  await clonedPage.waitForTimeout(250);
}

/** Captures a screenshot from a page at the comparison viewport. */
async function captureScreenshot(page: Page, size: { width: number; height: number }, path: string): Promise<void> {
  await page.setViewportSize({ ...size });
  await page.waitForTimeout(150);
  await page.screenshot({ path, type: 'png' });
}

/** Compares one route across the two browsers and builds its record. */
async function compareRoute(
  path: string,
  originalPage: Page,
  clonedPage: Page,
  originalOrigin: string,
  clonedOrigin: string,
  screenshotsDir: string,
  viewport: ViewportMode,
  threshold: number,
): Promise<CloneVerifyRoute> {
  const { size, label } = comparisonViewport(viewport);
  const slug = slugForPath(path);

  const originalScreenshot = join(screenshotsDir, `original-${slug}-${label}.png`);
  const clonedScreenshot = join(screenshotsDir, `cloned-${slug}-${label}.png`);
  const diffScreenshot = join(screenshotsDir, `diff-${slug}-${label}.png`);

  await navigateBoth(
    originalPage,
    clonedPage,
    originalOrigin + path,
    clonedOrigin + path,
  );

  const [originalFonts, clonedFonts, originalColors, clonedColors, originalRules, clonedRules] =
    await Promise.all([
      originalPage.evaluate(collectFontFamilies),
      clonedPage.evaluate(collectFontFamilies),
      originalPage.evaluate(collectColors),
      clonedPage.evaluate(collectColors),
      originalPage.evaluate(collectAnimationRules),
      clonedPage.evaluate(collectAnimationRules),
    ]);

  await captureScreenshot(originalPage, size, originalScreenshot);
  await captureScreenshot(clonedPage, size, clonedScreenshot);

  const comparison = compareScreenshots(
    await readFile(originalScreenshot),
    await readFile(clonedScreenshot),
    diffScreenshot,
    size.height,
  );
  await writeFile(diffScreenshot, comparison.diffBuffer);

  const pixelSimilarity = Math.max(0, 100 - comparison.mismatchPercent);
  const originalAnimations = new Set(animationNames(originalRules));
  const clonedAnimations = new Set(animationNames(clonedRules));

  return {
    path,
    originalScreenshot,
    clonedScreenshot,
    diffScreenshot,
    pixelSimilarity,
    fontReport: buildFontReport(originalFonts, clonedFonts),
    colorReport: buildColorReport(originalColors, clonedColors),
    animationsDetected: [...originalAnimations].filter(
      (name) => !clonedAnimations.has(name),
    ),
    passed: pixelSimilarity >= threshold,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Mean of values (0 when empty). */
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Coverage percentage: matched / original across all routes (0–100). */
function coveragePercent(matchedCounts: number[], originalCounts: number[]): number {
  const matched = matchedCounts.reduce((sum, value) => sum + value, 0);
  const original = originalCounts.reduce((sum, value) => sum + value, 0);
  if (original === 0) return 100;
  return (matched / original) * 100;
}

/**
 * Runs the full live-vs-clone comparison: starts the cloned project's Vite
 * dev server, drives two headless Chromium instances through every
 * discovered route, pixel-diffs the screenshots, extracts fonts, colors,
 * and animations, and writes `<outputDir>/clone-verify-report.json`.
 */
export async function runCloneVerify(options: CloneVerifyOptions): Promise<CloneVerifyResult> {
  const url = options.url;
  const outputDir = resolve(options.outputDir);
  const port = options.port ?? DEFAULT_PORT;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const viewport: ViewportMode = options.viewport ?? 'desktop';

  let originalOrigin: string;
  try {
    originalOrigin = new URL(url).origin;
  } catch {
    throw new Error(`Invalid original site URL: ${url}`);
  }

  const routePaths = await discoverRoutePaths(outputDir);
  const detectedScheme = await detectedColorScheme();

  const devServer = await startDevServer(outputDir, port);

  let originalBrowser: Browser | null = null;
  let clonedBrowser: Browser | null = null;
  const routes: CloneVerifyRoute[] = [];

  try {
    originalBrowser = await chromium.launch({ headless: true });
    clonedBrowser = await chromium.launch({ headless: true });

    const originalContext = await originalBrowser.newContext({
      viewport: { ...comparisonViewport(viewport).size },
      colorScheme: detectedScheme,
    });
    const clonedContext = await clonedBrowser.newContext({
      viewport: { ...comparisonViewport(viewport).size },
      colorScheme: detectedScheme,
    });
    const originalPage = await originalContext.newPage();
    const clonedPage = await clonedContext.newPage();

    // Fail fast when the original site is unreachable: the comparison is
    // meaningless without it, and every route would time out.
    try {
      await originalPage.goto(originalOrigin, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT_MS,
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Could not reach the original site at ${url}: ${reason}`);
    }

    const screenshotsDir = join(outputDir, SCREENSHOTS_DIRNAME);
    await mkdir(screenshotsDir, { recursive: true });

    for (const path of routePaths) {
      routes.push(
        await compareRoute(
          path,
          originalPage,
          clonedPage,
          originalOrigin,
          devServer.origin,
          screenshotsDir,
          viewport,
          threshold,
        ),
      );
    }

    await originalContext.close();
    await clonedContext.close();
  } finally {
    // Both browsers and the dev server are always torn down — no orphans.
    await originalBrowser?.close().catch(() => undefined);
    await clonedBrowser?.close().catch(() => undefined);
    await devServer.kill();
  }

  const result: CloneVerifyResult = {
    url,
    outputDir,
    generatedAt: new Date().toISOString(),
    routes,
    summary: {
      averageSimilarity: mean(routes.map((route) => route.pixelSimilarity)),
      fontMatchScore: coveragePercent(
        routes.map((route) => route.fontReport.matched.length),
        routes.map((route) => route.fontReport.original.length),
      ),
      colorMatchScore: coveragePercent(
        routes.map((route) => route.colorReport.matched.length),
        routes.map((route) => route.colorReport.original.length),
      ),
      totalRoutes: routes.length,
      passedRoutes: routes.filter((route) => route.passed).length,
    },
  };

  await writeFile(
    join(outputDir, CLONE_VERIFY_REPORT_FILENAME),
    JSON.stringify(result, null, 2),
    'utf8',
  );

  return result;
}

// Re-exported for the CLI: the screenshots directory name is needed by the
// report printer when resolving relative paths.
export { SCREENSHOTS_DIRNAME };

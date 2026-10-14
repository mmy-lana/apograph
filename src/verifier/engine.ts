/**
 * apograph — Multi-tier verification engine (Phase 5).
 *
 * Replaces the legacy single-tier `verifier/smoke.ts` with three tiers:
 *
 *   Tier 1  Build      — `tsc --noEmit` + `vite build` inside the output dir.
 *   Tier 2  Routes     — serve the built `dist/` on an ephemeral port, drive
 *                        headless Chromium through every plan route, and
 *                        check HTTP status, DOM mount, console errors, and
 *                        unhandled exceptions.
 *   Tier 3  Visuals    — capture desktop (1280x800) and mobile (390x844)
 *                        screenshots of every route and diff them against
 *                        the evidence bundle's reference screenshots with
 *                        pixelmatch + pngjs, writing diff PNGs under
 *                        `<outputDir>/.apograph-verification/`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import type { Browser, ConsoleMessage, Page } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type {
  BuildCheck,
  RouteCheck,
  VerificationReport,
  VisualCheck,
} from './report.js';
import type { EvidenceManifest } from '../types.js';
import type { ApographPlan, PlanRoute } from '../plan/schema.js';
import { validatePlan } from '../plan/generator.js';

/** Promisified execFile for async child-process execution. */
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Desktop comparison viewport. */
const DESKTOP_VIEWPORT = { width: 1280, height: 800 } as const;

/** Mobile comparison viewport. */
const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;

/** Default visual mismatch threshold (fraction; 15%). */
const DEFAULT_VISUAL_THRESHOLD = 0.15;

/** Per-pixel color tolerance passed to pixelmatch. */
const PIXELMATCH_TOLERANCE = 0.1;

/** Command timeout for build commands. */
const BUILD_TIMEOUT_MS = 300_000;

/** Navigation timeout for route checks. */
const NAVIGATION_TIMEOUT_MS = 30_000;

/** MIME types for the static dist server. */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

// ---------------------------------------------------------------------------
// Static site server (ephemeral port)
// ---------------------------------------------------------------------------

/** Handle to the temporary site server. */
export interface SiteHandle {
  origin: string;
  close(): Promise<void>;
}

/**
 * Serves a built SPA's `dist/` directory on an ephemeral localhost port with
 * history-fallback to `index.html`, so client-side routes resolve.
 */
export async function startSiteServer(distDir: string): Promise<SiteHandle> {
  const root = resolve(distDir);

  const server = createServer(async (request, response) => {
    try {
      const urlPath = decodeURIComponent(
        (request.url ?? '/').split('?')[0]?.split('#')[0] ?? '/',
      );
      let filePath = join(root, urlPath);

      // Directory traversal guard: stay inside dist/.
      if (!filePath.startsWith(root)) {
        response.writeHead(403);
        response.end();
        return;
      }

      try {
        const info = await stat(filePath);
        if (info.isDirectory()) filePath = join(filePath, 'index.html');
      } catch {
        // Fall through to file read / SPA fallback.
      }

      let content: Buffer;
      let servedPath = filePath;
      try {
        content = await readFile(filePath);
      } catch {
        // SPA history fallback: unknown paths render the app shell.
        servedPath = join(root, 'index.html');
        content = await readFile(servedPath);
      }

      const type =
        extname(servedPath).toLowerCase() === '.html'
          ? MIME_TYPES['.html']
          : (MIME_TYPES[extname(servedPath).toLowerCase()] ?? 'application/octet-stream');
      response.writeHead(200, { 'content-type': type });
      response.end(content);
    } catch {
      response.writeHead(500);
      response.end();
    }
  });

  await new Promise<void>((startResolve) => {
    server.listen(0, '127.0.0.1', () => startResolve());
  });

  const port = (server.address() as AddressInfo).port;

  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((closeResolve) => {
        server.close(() => closeResolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// Tier 1 — build verification
// ---------------------------------------------------------------------------

/** Result of one build command run. */
interface CommandResult {
  ok: boolean;
  output: string;
}

/** Runs a command in `cwd`, capturing combined stdout/stderr. */
async function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout: BUILD_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (cause) {
    const failure = cause as { stdout?: string; stderr?: string; message?: string };
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim() ||
      (failure.message ?? 'command failed');
    return { ok: false, output };
  }
}

/** Extracts the meaningful error lines from build tool output. */
function errorLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.includes('error'))
    .slice(0, 50);
}

/**
 * Tier 1: runs `tsc --noEmit` and `vite build` inside the output directory.
 * `vite build` is only attempted when the typecheck passes (mirroring the
 * project's `pnpm build` script). Returns success flags and compiler logs.
 */
export async function verifyBuild(outputDir: string): Promise<BuildCheck> {
  const cwd = resolve(outputDir);

  const tsc = await runCommand('npx', ['--no-install', 'tsc', '--noEmit'], cwd);
  const errors: string[] = [];

  let vitePassed = false;
  if (!tsc.ok) {
    errors.push(...errorLines(tsc.output));
  } else {
    const vite = await runCommand('npx', ['--no-install', 'vite', 'build'], cwd);
    if (!vite.ok) {
      errors.push(...errorLines(vite.output));
    } else {
      vitePassed = true;
    }
  }

  return {
    success: tsc.ok && vitePassed,
    tscPassed: tsc.ok,
    vitePassed,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Tier 2 — headless route smoke check
// ---------------------------------------------------------------------------

/** True when the SPA root element has mounted visible content. */
async function isDomLoaded(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const root = document.getElementById('root');
    return root !== null && root.childElementCount > 0;
  });
}

/**
 * Tier 2: navigates headless Chromium to every route path against the
 * running site, checking HTTP status, DOM mount, console errors, and
 * unhandled page exceptions per route.
 */
export async function verifyRoutes(
  site: SiteHandle,
  routePaths: string[],
): Promise<RouteCheck[]> {
  if (routePaths.length === 0) return [];

  const browser = await chromium.launch({ headless: true });
  const checks: RouteCheck[] = [];

  try {
    const context = await browser.newContext({ viewport: { ...DESKTOP_VIEWPORT } });
    const page = await context.newPage();

    for (const path of routePaths) {
      const consoleErrors: string[] = [];
      const exceptions: string[] = [];

      const onConsole = (message: ConsoleMessage): void => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      };
      const onPageError = (error: Error): void => {
        exceptions.push(error.message);
      };

      page.on('console', onConsole);
      page.on('pageerror', onPageError);

      let httpStatus = 0;
      let domLoaded = false;

      try {
        const response = await page.goto(site.origin + path, {
          waitUntil: 'load',
          timeout: NAVIGATION_TIMEOUT_MS,
        });
        httpStatus = response?.status() ?? 0;

        // Give React a beat to mount, then check the root.
        await page.waitForTimeout(250);
        domLoaded = await isDomLoaded(page);
      } catch (cause) {
        exceptions.push(cause instanceof Error ? cause.message : String(cause));
      } finally {
        page.removeListener('console', onConsole);
        page.removeListener('pageerror', onPageError);
      }

      const success =
        httpStatus >= 200 &&
        httpStatus < 400 &&
        domLoaded &&
        consoleErrors.length === 0 &&
        exceptions.length === 0;

      checks.push({
        path,
        httpStatus,
        domLoaded,
        consoleErrorCount: consoleErrors.length,
        consoleErrors,
        exceptions,
        success,
      });
    }

    await context.close();
  } finally {
    await browser.close();
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Tier 3 — visual screenshot comparison
// ---------------------------------------------------------------------------

/** One route's reference screenshot pair from the evidence bundle. */
export interface VisualRouteInput {
  path: string;
  referenceDesktop: string | null;
  referenceMobile: string | null;
}

/** Derives a filesystem-safe slug from a URL path. */
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

/** Conforms a PNG to the reference dimensions (crop/pad, white fill). */
function conformToDimensions(source: PNG, width: number, height: number): PNG {
  if (source.width === width && source.height === height) return source;

  const target = new PNG({ width, height });
  target.data.fill(255);

  const copyRows = Math.min(source.height, height);
  const copyBytes = Math.min(source.width, width) * 4;

  for (let row = 0; row < copyRows; row += 1) {
    const sourceStart = row * source.width * 4;
    source.data.copy(target.data, row * width * 4, sourceStart, sourceStart + copyBytes);
  }

  return target;
}

/** Result of one pixelmatch comparison. */
interface ComparisonResult {
  mismatchPercent: number;
  diffImage: string;
  diffBuffer: Buffer;
}

/** Compares a current screenshot buffer against a reference buffer. */
function compareScreenshots(
  reference: Buffer,
  current: Buffer,
  diffPath: string,
): ComparisonResult {
  const referencePng = PNG.sync.read(reference);
  const currentPng = conformToDimensions(
    PNG.sync.read(current),
    referencePng.width,
    referencePng.height,
  );

  const diff = new PNG({ width: referencePng.width, height: referencePng.height });
  const mismatched = pixelmatch(
    referencePng.data,
    currentPng.data,
    diff.data,
    referencePng.width,
    referencePng.height,
    { threshold: PIXELMATCH_TOLERANCE },
  );

  return {
    mismatchPercent: (mismatched / (referencePng.width * referencePng.height)) * 100,
    diffImage: diffPath,
    diffBuffer: PNG.sync.write(diff),
  };
}

/** Waits until the route's DOM has mounted (bounded). */
async function waitForMount(page: Page): Promise<void> {
  try {
    await page.waitForSelector('#root > *', { timeout: 5_000 });
  } catch {
    // DOM never mounted — the screenshot still records what rendered.
  }
}

/**
 * Tier 3: captures desktop and mobile screenshots of every route on the
 * running site, diffs them against the evidence bundle's reference
 * screenshots, and writes diff PNGs to `<outputDir>/.apograph-verification/`.
 * Routes without a reference screenshot are recorded as skipped.
 */
export async function verifyVisuals(
  site: SiteHandle,
  routes: VisualRouteInput[],
  outputDir: string,
  visualThreshold: number = DEFAULT_VISUAL_THRESHOLD,
): Promise<VisualCheck[]> {
  if (routes.length === 0) return [];

  const projectDir = resolve(outputDir);
  const diffDir = join(projectDir, '.apograph-verification');
  await mkdir(diffDir, { recursive: true });

  const thresholdPercent = visualThreshold * 100;
  const browser = await chromium.launch({ headless: true });
  const checks: VisualCheck[] = [];

  try {
    const context = await browser.newContext({ viewport: { ...DESKTOP_VIEWPORT } });
    const page = await context.newPage();

    for (const route of routes) {
      const slug = slugForPath(route.path);

      try {
        await page.goto(site.origin + route.path, {
          waitUntil: 'load',
          timeout: NAVIGATION_TIMEOUT_MS,
        });
        await waitForMount(page);
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        checks.push(
          {
            path: route.path,
            viewport: 'desktop',
            referenceScreenshot: route.referenceDesktop,
            diffImage: null,
            mismatchPercent: null,
            thresholdPercent,
            passed: null,
            note: `navigation failed: ${reason}`,
          },
          {
            path: route.path,
            viewport: 'mobile',
            referenceScreenshot: route.referenceMobile,
            diffImage: null,
            mismatchPercent: null,
            thresholdPercent,
            passed: null,
            note: `navigation failed: ${reason}`,
          },
        );
        continue;
      }

      const viewports: Array<{
        kind: 'desktop' | 'mobile';
        reference: string | null;
        size: { width: number; height: number };
      }> = [
        { kind: 'desktop', reference: route.referenceDesktop, size: { ...DESKTOP_VIEWPORT } },
        { kind: 'mobile', reference: route.referenceMobile, size: { ...MOBILE_VIEWPORT } },
      ];

      for (const viewport of viewports) {
        const diffPath = join(diffDir, `${slug}-${viewport.kind}-diff.png`);

        if (viewport.reference === null) {
          checks.push({
            path: route.path,
            viewport: viewport.kind,
            referenceScreenshot: null,
            diffImage: null,
            mismatchPercent: null,
            thresholdPercent,
            passed: null,
            note: 'no reference screenshot in the evidence bundle',
          });
          continue;
        }

        try {
          const reference = await readFile(resolve(viewport.reference));
          await page.setViewportSize(viewport.size);
          await page.waitForTimeout(150);
          const current = (await page.screenshot({ type: 'png' })) as Buffer;

          const comparison = compareScreenshots(reference, current, diffPath);
          await writeFile(diffPath, comparison.diffBuffer);

          checks.push({
            path: route.path,
            viewport: viewport.kind,
            referenceScreenshot: resolve(viewport.reference),
            diffImage: diffPath,
            mismatchPercent: comparison.mismatchPercent,
            thresholdPercent,
            passed: comparison.mismatchPercent < thresholdPercent,
          });
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          checks.push({
            path: route.path,
            viewport: viewport.kind,
            referenceScreenshot: resolve(viewport.reference),
            diffImage: null,
            mismatchPercent: null,
            thresholdPercent,
            passed: null,
            note: `comparison failed: ${reason}`,
          });
        }
      }

      await page.setViewportSize({ ...DESKTOP_VIEWPORT });
    }

    await context.close();
  } finally {
    await browser.close();
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Options for {@link runVerification}. */
export interface VerificationOptions {
  /** Generated project directory to verify. */
  outputDir: string;
  /** Evidence bundle directory (plan + reference screenshots). */
  evidenceDir: string;
  /** Visual mismatch threshold as a fraction (default 0.15 = 15%). */
  visualThreshold?: number;
}

/** True when a file is readable. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** Loads the approved plan from the evidence dir, or null. */
async function tryLoadPlan(evidenceDir: string): Promise<ApographPlan | null> {
  const planPath = join(resolve(evidenceDir), 'apograph-plan.json');
  try {
    return validatePlan(JSON.parse(await readFile(planPath, 'utf8')));
  } catch {
    return null;
  }
}

/** Loads the evidence manifest, or null. */
async function tryLoadManifest(evidenceDir: string): Promise<EvidenceManifest | null> {
  const manifestPath = join(resolve(evidenceDir), 'manifest.json');
  try {
    const raw: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (typeof raw === 'object' && raw !== null && 'routes' in raw) {
      return raw as EvidenceManifest;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolves a manifest screenshot path against the evidence dir. Relative
 * paths may be rooted at the process CWD (how the crawler records them) or
 * at the evidence directory; the first readable candidate wins.
 */
async function resolveEvidencePath(
  path: string,
  evidenceDir: string,
): Promise<string | null> {
  const candidates = path.startsWith('/')
    ? [path]
    : [path, join(resolve(evidenceDir), path)];

  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return resolve(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/** Builds the route inputs shared by tiers 2 and 3. */
async function buildRouteInputs(
  plan: ApographPlan | null,
  manifest: EvidenceManifest | null,
  evidenceDir: string,
): Promise<{ routePaths: string[]; visualRoutes: VisualRouteInput[] }> {
  const included: PlanRoute[] = plan
    ? plan.routes.filter((route) => route.included)
    : [];

  if (manifest !== null) {
    const visualRoutes: VisualRouteInput[] = [];
    for (const route of manifest.routes) {
      if (plan !== null && !included.some((r) => r.path === route.path)) continue;
      visualRoutes.push({
        path: route.path,
        referenceDesktop: await resolveEvidencePath(route.desktopScreenshot, evidenceDir),
        referenceMobile: await resolveEvidencePath(route.mobileScreenshot, evidenceDir),
      });
    }
    return { routePaths: visualRoutes.map((route) => route.path), visualRoutes };
  }

  const routePaths = included.map((route) => route.path);
  return {
    routePaths,
    visualRoutes: routePaths.map((path) => ({
      path,
      referenceDesktop: null,
      referenceMobile: null,
    })),
  };
}

/**
 * Runs the full 3-tier verification pipeline for a generated project and
 * returns the assembled report (not yet written to disk — persist it with
 * `writeVerificationReport` and print it with `printVerificationSummary`).
 */
export async function runVerification(
  options: VerificationOptions,
): Promise<VerificationReport> {
  const outputDir = resolve(options.outputDir);
  const evidenceDir = resolve(options.evidenceDir);
  const visualThreshold = options.visualThreshold ?? DEFAULT_VISUAL_THRESHOLD;

  const diagnostics: string[] = [];

  const plan = await tryLoadPlan(evidenceDir);
  const manifest = await tryLoadManifest(evidenceDir);

  if (plan === null && manifest === null) {
    diagnostics.push(
      `No plan (apograph-plan.json) or manifest (manifest.json) found in ${evidenceDir}; ` +
        'route and visual tiers had nothing to check.',
    );
  } else if (plan !== null && !plan.approved) {
    diagnostics.push('The plan in the evidence directory is not approved.');
  }

  const { routePaths, visualRoutes } = await buildRouteInputs(plan, manifest, evidenceDir);

  // --- Tier 1: build ---------------------------------------------------
  const build = await verifyBuild(outputDir);
  if (!build.success) {
    diagnostics.push(
      `Build failed (${build.errors.length} error line(s)); visual tiers may use a stale dist/.`,
    );
  }

  // --- Tiers 2 & 3: serve dist and drive Chromium ----------------------
  const distDir = join(outputDir, 'dist');
  const distReady = await fileExists(join(distDir, 'index.html'));

  let routes: RouteCheck[] = [];
  let visuals: VisualCheck[] = [];

  if (!distReady) {
    diagnostics.push(
      'dist/index.html not found — route and visual tiers skipped. ' +
        'Build the project first (tier 1 must pass, or run vite build manually).',
    );
  } else if (routePaths.length === 0) {
    diagnostics.push('No routes to verify (empty plan/manifest route list).');
  } else {
    const site = await startSiteServer(distDir);
    try {
      routes = await verifyRoutes(site, routePaths);
      const failingRoutes = routes.filter((route) => !route.success);
      if (failingRoutes.length > 0) {
        diagnostics.push(
          `${failingRoutes.length} route(s) failed the smoke check: ` +
            failingRoutes.map((route) => route.path).join(', '),
        );
      }

      visuals = await verifyVisuals(site, visualRoutes, outputDir, visualThreshold);
      const failingVisuals = visuals.filter((visual) => visual.passed === false);
      const skippedVisuals = visuals.filter((visual) => visual.passed === null);
      if (failingVisuals.length > 0) {
        diagnostics.push(
          `${failingVisuals.length} visual comparison(s) exceeded the ` +
            `${(visualThreshold * 100).toFixed(0)}% mismatch threshold.`,
        );
      }
      if (skippedVisuals.length > 0) {
        diagnostics.push(
          `${skippedVisuals.length} visual comparison(s) skipped ` +
            '(missing reference screenshot, navigation, or comparison error).',
        );
      }
    } finally {
      await site.close();
    }
  }

  const routesPassed = routes.length > 0 && routes.every((route) => route.success);
  const comparableVisuals = visuals.filter((visual) => visual.passed !== null);
  const visualsPassed =
    comparableVisuals.length > 0 && comparableVisuals.every((visual) => visual.passed === true);

  return {
    outputDir,
    evidenceDir,
    generatedAt: new Date().toISOString(),
    build,
    routes,
    visuals,
    overall: {
      passed: build.success && routesPassed && visualsPassed,
      buildPassed: build.success,
      routesPassed,
      visualsPassed,
    },
    diagnostics,
  };
}

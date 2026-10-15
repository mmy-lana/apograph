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
  RepairRecord,
  RouteCheck,
  VerificationReport,
  VisualCheck,
} from './report.js';
import type { EvidenceManifest, ViewportMode } from '../types.js';
import type { ApographPlan, PlanRoute } from '../plan/schema.js';
import { validatePlan } from '../plan/generator.js';
import { repairComponentWithVisualDiff } from '../synthesizer/vision.js';

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

/** True when a `node_modules` directory exists under `cwd`. */
async function nodeModulesExists(cwd: string): Promise<boolean> {
  try {
    await stat(join(cwd, 'node_modules'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Tier 1: runs `tsc --noEmit` and `vite build` inside the output directory.
 * Installs dependencies if `node_modules` is absent before typechecking.
 * `vite build` is only attempted when the typecheck passes (mirroring the
 * project's `pnpm build` script). Returns success flags and compiler logs.
 */
export async function verifyBuild(outputDir: string): Promise<BuildCheck> {
  const cwd = resolve(outputDir);

  const hasModules = await nodeModulesExists(cwd);

  if (!hasModules) {
    // Install dependencies. A non-zero exit is tolerated when node_modules
    // was still materialized — pnpm may exit non-zero on unapproved build
    // scripts or lockfile conflicts while having installed everything the
    // build needs. Only escalate to npm when pnpm produced nothing.
    const install = await runCommand('pnpm', ['install', '--prefer-offline'], cwd);

    let modulesReady = await nodeModulesExists(cwd);

    if (!modulesReady) {
      // pnpm may refuse on a conflicting lockfile (e.g. one written by npm);
      // fall back to npm before giving up.
      const fallback = await runCommand('npm', ['install', '--prefer-offline'], cwd);
      modulesReady = await nodeModulesExists(cwd);

      if (!modulesReady) {
        return {
          success: false,
          tscPassed: false,
          vitePassed: false,
          errors: [
            'Failed to install dependencies in emitted project:',
            ...errorLines(install.output),
            ...errorLines(fallback.output),
          ],
        };
      }
    }
  }

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
export interface ComparisonResult {
  mismatchPercent: number;
  diffImage: string;
  diffBuffer: Buffer;
  /** Present when the reference was cropped to the viewport height (patch spec s3.2). */
  cropNote?: string;
}

/** The structural shape of a decoded PNG the comparison pipeline needs. */
interface DecodedPng {
  width: number;
  height: number;
  data: Buffer;
}

/**
 * Crops a reference PNG to its top `height` pixels (top-anchored), used when
 * a full-page reference screenshot is taller than the verification viewport
 * (patch spec s3.2).
 */
function cropToHeight<T extends DecodedPng>(source: T, height: number): T {
  if (source.height <= height) return source;
  const cropped = new PNG({ width: source.width, height });
  for (let row = 0; row < height; row += 1) {
    const start = row * source.width * 4;
    source.data.copy(cropped.data, row * source.width * 4, start, start + source.width * 4);
  }
  return cropped as unknown as T;
}

/** Compares a current screenshot buffer against a reference buffer. */
export function compareScreenshots(
  reference: Buffer,
  current: Buffer,
  diffPath: string,
  viewportHeight?: number,
): ComparisonResult {
  let referencePng: ReturnType<typeof PNG.sync.read> = PNG.sync.read(reference);

  // Full-page reference taller than the verification viewport: crop the
  // reference to its top viewport-height slice (top-anchored; the scroll
  // reset guarantees both captures are in the at-top state).
  let cropNote: string | undefined;
  if (viewportHeight !== undefined && referencePng.height > viewportHeight) {
    cropNote = `reference cropped from ${referencePng.height} px to viewport height`;
    referencePng = cropToHeight(referencePng, viewportHeight);
  }

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
    ...(cropNote !== undefined ? { cropNote } : {}),
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
 * Only the viewports selected by `viewport` are captured and compared.
 * Routes without a reference screenshot are recorded as skipped.
 */
export async function verifyVisuals(
  site: SiteHandle,
  routes: VisualRouteInput[],
  outputDir: string,
  visualThreshold: number = DEFAULT_VISUAL_THRESHOLD,
  viewportMode: ViewportMode = 'both',
): Promise<VisualCheck[]> {
  if (routes.length === 0) return [];

  const compareDesktop = viewportMode !== 'mobile';
  const compareMobile = viewportMode !== 'desktop';

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
        if (compareDesktop) {
          checks.push({
            path: route.path,
            viewport: 'desktop',
            referenceScreenshot: route.referenceDesktop,
            diffImage: null,
            mismatchPercent: null,
            thresholdPercent,
            passed: null,
            note: `navigation failed: ${reason}`,
          });
        }
        if (compareMobile) {
          checks.push({
            path: route.path,
            viewport: 'mobile',
            referenceScreenshot: route.referenceMobile,
            diffImage: null,
            mismatchPercent: null,
            thresholdPercent,
            passed: null,
            note: `navigation failed: ${reason}`,
          });
        }
        continue;
      }

      const viewports: Array<{
        kind: 'desktop' | 'mobile';
        reference: string | null;
        size: { width: number; height: number };
      }> = [];

      if (compareDesktop) {
        viewports.push({
          kind: 'desktop',
          reference: route.referenceDesktop,
          size: { ...DESKTOP_VIEWPORT },
        });
      }
      if (compareMobile) {
        viewports.push({
          kind: 'mobile',
          reference: route.referenceMobile,
          size: { ...MOBILE_VIEWPORT },
        });
      }

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

          const comparison = compareScreenshots(reference, current, diffPath, viewport.size.height);
          await writeFile(diffPath, comparison.diffBuffer);

          checks.push({
            path: route.path,
            viewport: viewport.kind,
            referenceScreenshot: resolve(viewport.reference),
            diffImage: diffPath,
            mismatchPercent: comparison.mismatchPercent,
            thresholdPercent,
            passed: comparison.mismatchPercent < thresholdPercent,
            ...(comparison.cropNote !== undefined ? { note: comparison.cropNote } : {}),
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
// Closed-loop visual diff repair pass (spec s7)
// ---------------------------------------------------------------------------

/** Injectable dependencies for {@link runVisualRepairPass}. */
export interface VisualRepairPassDeps {
  /** Performs one repair turn. Defaults to the vision model repair. */
  repairComponent?: (
    componentPath: string,
    currentCode: string,
    originalScreenshotDataUrl: string,
    diffImageDataUrl: string,
    mismatchPercent: number,
  ) => Promise<string>;
  /** Rebuilds the project; returns build success. Defaults to tier 1. */
  rebuild?: (outputDir: string) => Promise<boolean>;
  /** Re-verifies one route's visuals after a rebuild. */
  reVerify?: (routePath: string) => Promise<VisualCheck[]>;
}

/** Options for {@link runVisualRepairPass}. */
export interface VisualRepairPassOptions extends VisualRepairPassDeps {
  /** Tier-3 visual checks from the initial verification run. */
  visuals: VisualCheck[];
  /** Route path -> component file path (relative to outputDir or absolute). */
  componentPathsByRoute: Map<string, string>;
  /** Generated project directory (components are read/written here). */
  outputDir: string;
}

/** Encodes a PNG file into a base64 data URL, or null if unreadable. */
async function loadDataUrl(path: string): Promise<string | null> {
  try {
    const buffer = await readFile(path);
    if (buffer.byteLength === 0) return null;
    return `data:image/png;base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * Runs the single-turn closed-loop visual diff repair pass (spec s7):
 * for each route with failing visual comparisons, exactly one repair turn
 * is triggered — the worst failing viewport's diff overlay and reference
 * screenshot are embedded in a localized repair prompt for the route's
 * component — then the project is rebuilt and the route's visuals are
 * re-verified. Repairs record mismatchBefore/mismatchAfter/fixed per
 * failing viewport. A route never receives a second turn in the same pass.
 */
export async function runVisualRepairPass(
  options: VisualRepairPassOptions,
): Promise<{ visuals: VisualCheck[]; repairs: RepairRecord[] }> {
  const { visuals, componentPathsByRoute, outputDir } = options;
  const repairComponent = options.repairComponent ?? repairComponentWithVisualDiff;
  const rebuild = options.rebuild ?? defaultRebuild;
  const repairs: RepairRecord[] = [];

  // Group failing comparisons by route; single repair turn per route.
  const failingByRoute = new Map<string, VisualCheck[]>();
  for (const visual of visuals) {
    if (visual.passed !== false) continue;
    const group = failingByRoute.get(visual.path);
    if (group !== undefined) group.push(visual);
    else failingByRoute.set(visual.path, [visual]);
  }

  const repairedVisuals = new Map(visuals.map((visual) => [visual, visual]));

  for (const [routePath, failures] of failingByRoute) {
    const componentPath = componentPathsByRoute.get(routePath);
    if (componentPath === undefined) continue;

    // Worst failing viewport drives the repair prompt (single turn).
    const worst = failures.reduce((a, b) =>
      (b.mismatchPercent ?? 0) > (a.mismatchPercent ?? 0) ? b : a,
    );

    if (
      worst.referenceScreenshot === null ||
      worst.diffImage === null ||
      worst.mismatchPercent === null
    ) {
      continue;
    }

    const resolvedComponentPath = componentPath.startsWith('/')
      ? componentPath
      : join(outputDir, componentPath);

    let currentCode: string;
    try {
      currentCode = await readFile(resolvedComponentPath, 'utf8');
    } catch {
      // Component file absent (page not synthesized) — nothing to repair.
      continue;
    }

    const originalDataUrl = await loadDataUrl(worst.referenceScreenshot);
    const diffDataUrl = await loadDataUrl(worst.diffImage);
    if (originalDataUrl === null || diffDataUrl === null) continue;

    let repairedCode: string;
    try {
      repairedCode = await repairComponent(
        resolvedComponentPath,
        currentCode,
        originalDataUrl,
        diffDataUrl,
        worst.mismatchPercent,
      );
    } catch {
      // Repair turn failed; the route keeps its pre-repair verdicts.
      continue;
    }

    // Write the repaired component to disk.
    try {
      await writeFile(resolvedComponentPath, repairedCode, 'utf8');
    } catch {
      continue;
    }

    // Re-build and re-verify the repaired target.
    const buildOk = await rebuild(outputDir);
    if (!buildOk || options.reVerify === undefined) {
      for (const failure of failures) {
        repairs.push({
          path: routePath,
          viewport: failure.viewport,
          mismatchBefore: worst.mismatchPercent as number,
          mismatchAfter: null,
          fixed: false,
        });
      }
      continue;
    }

    const fresh = await options.reVerify(routePath);

    for (const failure of failures) {
      const after = fresh.find(
        (check) => check.path === failure.path && check.viewport === failure.viewport,
      );
      const mismatchAfter = after?.mismatchPercent ?? null;
      const fixed = after?.passed === true;
      repairs.push({
        path: routePath,
        viewport: failure.viewport,
        mismatchBefore: failure.mismatchPercent ?? worst.mismatchPercent,
        mismatchAfter,
        fixed,
      });
    }

    // Fold fresh checks into the returned visual list.
    for (const check of fresh) {
      const existing = visuals.find(
        (visual) => visual.path === check.path && visual.viewport === check.viewport,
      );
      if (existing !== undefined) repairedVisuals.set(existing, check);
    }
  }

  return {
    visuals: visuals.map((visual) => repairedVisuals.get(visual) ?? visual),
    repairs,
  };
}

/** Default rebuild dep: the full tier-1 build check. */
async function defaultRebuild(outputDir: string): Promise<boolean> {
  const build = await verifyBuild(outputDir);
  return build.success;
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
  /** Which viewports to compare visually. Defaults to `both`. */
  viewport?: ViewportMode;
  /** Set false to disable the single-turn visual diff repair pass (spec s7). */
  repair?: boolean;
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
        referenceDesktop:
          route.desktopScreenshot !== null
            ? await resolveEvidencePath(route.desktopScreenshot, evidenceDir)
            : null,
        referenceMobile:
          route.mobileScreenshot !== null
            ? await resolveEvidencePath(route.mobileScreenshot, evidenceDir)
            : null,
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
  const viewportMode: ViewportMode = options.viewport ?? 'both';

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
  let repairs: RepairRecord[] = [];

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

      visuals = await verifyVisuals(site, visualRoutes, outputDir, visualThreshold, viewportMode);

      // Single-turn closed-loop repair pass (spec s7): one repair turn per
      // failing route, then re-build + re-verify the repaired target.
      if (options.repair !== false && plan !== null) {
        const componentPathsByRoute = new Map<string, string>();
        for (const route of plan.routes.filter((entry) => entry.included)) {
          componentPathsByRoute.set(
            route.path,
            join('src', 'pages', `${route.componentName}.tsx`),
          );
        }

        const distDir2 = distDir;
        const pass = await runVisualRepairPass({
          visuals,
          componentPathsByRoute,
          outputDir,
          reVerify: async (routePath: string): Promise<VisualCheck[]> => {
            const route = visualRoutes.find((entry) => entry.path === routePath);
            if (route === undefined) return [];
            if (!(await fileExists(join(distDir2, 'index.html')))) return [];
            const repairSite = await startSiteServer(distDir2);
            try {
              return await verifyVisuals(
                repairSite,
                [route],
                outputDir,
                visualThreshold,
                viewportMode,
              );
            } finally {
              await repairSite.close();
            }
          },
        });

        visuals = pass.visuals;
        repairs = pass.repairs;
        if (pass.repairs.length > 0) {
          const fixed = pass.repairs.filter((repair) => repair.fixed).length;
          diagnostics.push(
            `Visual diff repair pass: ${pass.repairs.length} repair record(s), ` +
              `${fixed} now below threshold (single turn per route).`,
          );
        }
      }

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
    ...(repairs.length > 0 ? { repairs } : {}),
    overall: {
      passed: build.success && routesPassed && visualsPassed,
      buildPassed: build.success,
      routesPassed,
      visualsPassed,
    },
    diagnostics,
  };
}

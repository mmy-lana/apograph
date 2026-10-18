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
import { extname, join, relative, resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import type { Browser, ConsoleMessage, Page } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type {
  BuildCheck,
  CompilerRepairRecord,
  RepairRecord,
  RouteCheck,
  VerificationReport,
  VisualCheck,
} from './report.js';
import type { EvidenceManifest, ViewportMode } from '../types.js';
import type { ApographPlan, PlanRoute } from '../plan/schema.js';
import { loadEvidenceManifest, validatePlan } from '../plan/generator.js';
import { repairCodeFile } from '../synthesizer/llm.js';
import { repairComponentWithVisualDiff } from '../synthesizer/vision.js';
import { assertNoSymlinkComponents, resolveContainedPath } from '../utils/fs-safe.js';

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
      const relativePath = relative(root, filePath);
       if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || relativePath.includes(`..${sep}`)) {
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
export interface CommandResult {
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

// ---------------------------------------------------------------------------
// Tier 1 — compiler diagnostics & auto-repair
// ---------------------------------------------------------------------------

/** One parsed `tsc` error diagnostic. */
export interface CompilerDiagnostic {
  /** File path as printed by tsc (e.g. 'src/components/Hero.tsx'). */
  file: string;
  /** 1-based line of the error. */
  line: number;
  /** 1-based column of the error. */
  column: number;
  /** Diagnostic code, e.g. 'TS2322'. */
  code: string;
  /** Full diagnostic block text, including continuation lines. */
  message: string;
}

/** Classic tsc format: `src/A.tsx(12,18): error TS2322: ...`. */
const TSC_ERROR_CLASSIC = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;

/** Pretty tsc format: `src/A.tsx:12:18 - error TS2322: ...`. */
const TSC_ERROR_PRETTY = /^(.+?):(\d+):(\d+)\s+-\s+error\s+(TS\d+):\s+(.*)$/;

/**
 * Parses `tsc --noEmit` output into diagnostics, supporting both the classic
 * `file(line,col): error TSxxxx:` format and the pretty
 * `file:line:col - error TSxxxx:` format. Continuation lines (indented
 * message detail / code frames) fold into the owning diagnostic until the
 * next diagnostic or a blank line. File-less diagnostics (config-level
 * TS5xxx / TS6053) produce no entries and are therefore never repair targets.
 */
export function parseTscDiagnostics(output: string): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];
  let current: CompilerDiagnostic | null = null;

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd();
    const match = line.match(TSC_ERROR_CLASSIC) ?? line.match(TSC_ERROR_PRETTY);

    if (match !== null) {
      if (current !== null) diagnostics.push(current);
      current = {
        file: match[1] as string,
        line: Number.parseInt(match[2] as string, 10),
        column: Number.parseInt(match[3] as string, 10),
        code: match[4] as string,
        message: line,
      };
      continue;
    }

    if (current === null) continue;

    if (line.trim().length === 0) {
      diagnostics.push(current);
      current = null;
      continue;
    }

    current.message += `\n${line}`;
  }

  if (current !== null) diagnostics.push(current);
  return diagnostics;
}

/** One file queued for a targeted compiler-repair turn. */
interface RepairTarget {
  file: string;
  errors: string[];
}

/** Max files sent through one repair turn (token bound). */
const MAX_REPAIR_FILES = 3;

/** Max diagnostic lines forwarded per file. */
const MAX_REPAIR_ERRORS = 20;

/** True when a diagnostic file is a safe in-project repair candidate. */
function isRepairTarget(cwd: string, file: string): boolean {
  if (!file.startsWith('src/')) return false;
  if (file.includes('node_modules')) return false;
  const root = resolve(cwd);
  return resolve(cwd, file).startsWith(root + sep);
}

/** Groups parseable diagnostics into per-file repair targets (bounded). */
function selectRepairTargets(cwd: string, tscOutput: string): RepairTarget[] {
  const byFile = new Map<string, string[]>();

  for (const diagnostic of parseTscDiagnostics(tscOutput)) {
    if (!isRepairTarget(cwd, diagnostic.file)) continue;
    const errors = byFile.get(diagnostic.file) ?? [];
    errors.push(diagnostic.message);
    byFile.set(diagnostic.file, errors);
  }

  return [...byFile.entries()]
    .slice(0, MAX_REPAIR_FILES)
    .map(([file, errors]) => ({ file, errors: errors.slice(0, MAX_REPAIR_ERRORS) }));
}

/** Error lines from a failed command, falling back to raw output when unparseable. */
function failureLines(output: string): string[] {
  const lines = errorLines(output);
  if (lines.length > 0) return lines;
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 10);
}

/** Injectable runtime seams for the tier-1 build (testable without tsc/LLM). */
export interface Tier1Deps {
  run(command: string, args: string[], cwd: string): Promise<CommandResult>;
  repairFile(filePath: string, currentContent: string, errors: string[]): Promise<string>;
}

/**
 * Tier 1 core: dependency install, `tsc --noEmit` with a bounded compiler
 * auto-repair loop (default: one targeted turn over up to three files), then
 * `vite build` — always attempted so `dist/` artifacts exist for tiers 2/3
 * even when residual type errors remain.
 */
export async function runTier1Build(
  cwd: string,
  deps: Tier1Deps,
  maxRepairTurns: number = 1,
): Promise<BuildCheck> {
  const root = resolve(cwd);
  const repairTurns = Number.isSafeInteger(maxRepairTurns) && maxRepairTurns >= 0
    ? Math.min(maxRepairTurns, 3)
    : 0;

  const hasModules = await nodeModulesExists(root);

  if (!hasModules) {
    // Install dependencies. A non-zero exit is tolerated when node_modules
    // was still materialized — pnpm may exit non-zero on unapproved build
    // scripts or lockfile conflicts while having installed everything the
    // build needs. Only escalate to npm when pnpm produced nothing.
    const install = await deps.run('pnpm', ['install', '--prefer-offline', '--ignore-scripts'], root);

    let modulesReady = await nodeModulesExists(root);

    if (!modulesReady) {
      // pnpm may refuse on a conflicting lockfile (e.g. one written by npm);
      // fall back to npm before giving up.
      const fallback = await deps.run('npm', ['install', '--prefer-offline', '--ignore-scripts'], root);
      modulesReady = await nodeModulesExists(root);

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

  const tscArgs = ['--no-install', 'tsc', '--noEmit'];
  let tsc = await deps.run('npx', tscArgs, root);

  // Bounded compiler auto-repair loop (default: one targeted turn).
  const repairedFiles: string[] = [];
  const errorsBefore: string[] = [];
  let repairRan = false;

  if (!tsc.ok) {
    for (let turn = 0; turn < repairTurns && !tsc.ok; turn += 1) {
      const targets = selectRepairTargets(root, tsc.output);
      if (targets.length === 0) break;

      repairRan = true;
      for (const target of targets) {
        const filePath = join(root, target.file);
        let content: string;
        try {
          content = await readFile(filePath, 'utf8');
        } catch {
          continue; // Diagnostic points at a missing file — skip it.
        }

        try {
          const repaired = await deps.repairFile(target.file, content, target.errors);
          if (repaired.length === 0 || repaired.length > 1_000_000) throw new Error('repair output size invalid');
          await writeFile(filePath, repaired, 'utf8');
          repairedFiles.push(target.file);
          errorsBefore.push(...target.errors);
        } catch {
          // A failed repair turn leaves the file untouched.
        }
      }

      tsc = await deps.run('npx', tscArgs, root);
    }
  }

  // Always attempt `vite build`, even with residual type errors: esbuild
  // transpiles without typechecking, so dist/index.html is produced and the
  // route/visual tiers can execute. The typecheck verdict is reported
  // separately (tscPassed / typecheckBypassed).
  const vite = await deps.run('npx', ['--no-install', 'vite', 'build'], root);

  const errors: string[] = [];
  if (!tsc.ok) errors.push(...failureLines(tsc.output));
  if (!vite.ok) errors.push(...failureLines(vite.output));

  const repair: CompilerRepairRecord | undefined = repairRan
    ? { repairedFiles, fixed: tsc.ok, errorsBefore }
    : undefined;

  return {
    success: tsc.ok && vite.ok,
    tscPassed: tsc.ok,
    vitePassed: vite.ok,
    errors,
    ...(repair !== undefined ? { repair } : {}),
    ...(!tsc.ok ? { typecheckBypassed: true } : {}),
  };
}

/** Options for {@link verifyBuild}'s compiler auto-repair loop. */
export interface BuildRepairOptions {
  /** Max targeted repair turns after a failing typecheck (default 1; 0 disables). */
  maxRepairTurns?: number;
  /** Repair hook override (test seam). Defaults to `repairCodeFile`. */
  repairFile?: Tier1Deps['repairFile'];
}

/**
 * Tier 1: runs `tsc --noEmit` (with a bounded compiler auto-repair turn via
 * `repairCodeFile`) and `vite build` inside the output directory. Installs
 * dependencies if `node_modules` is absent before typechecking. `vite build`
 * is attempted even when residual type errors remain so `dist/` artifacts are
 * produced for the route/visual tiers. Returns success flags, compiler logs,
 * and the auto-repair record.
 */
export async function verifyBuild(
  outputDir: string,
  options: BuildRepairOptions = {},
): Promise<BuildCheck> {
  if (process.env.APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION !== '1') {
    return {
      success: false,
      tscPassed: false,
      vitePassed: false,
      errors: [
        'Generated-project execution is disabled by default because no portable sandbox is available. ',
        'Set APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION=1 only in a disposable, isolated environment.',
      ],
    };
  }
  return runTier1Build(
    resolve(outputDir),
    {
      run: runCommand,
      repairFile: options.repairFile ?? repairCodeFile,
    },
    options.maxRepairTurns ?? 1,
  );
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

/**
 * Normalizes a decoded PNG's alpha channel to fully opaque so transparency
 * carried only by the alpha channel (transparent overlays, unpainted regions)
 * never registers as a layout mismatch: the RGB channels carry the comparison.
 */
export function normalizeAlphaChannel(png: {
  width: number;
  height: number;
  data: Buffer;
}): void {
  for (let index = 3; index < png.data.length; index += 4) {
    png.data[index] = 255;
  }
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

  // Normalize both alpha channels before diffing: transparent-overlay alpha
  // discrepancies must not blow up the mismatch metric.
  normalizeAlphaChannel(referencePng);
  normalizeAlphaChannel(currentPng);

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
  /** Maximum accepted repair turns for each route (default: 2). */
  maxRepairTurnsPerRoute?: number;
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
 * Runs a bounded closed-loop visual diff repair pass: each route with failing
 * visual comparisons receives up to the configured number of turns. Each turn
 * targets the worst current viewport, rebuilds and re-verifies the route, and
 * keeps the candidate only when it improves at least one viewport without
 * regressing any comparable viewport. Regressions and no-progress candidates
 * are restored immediately.
 */
export async function runVisualRepairPass(
  options: VisualRepairPassOptions,
): Promise<{ visuals: VisualCheck[]; repairs: RepairRecord[] }> {
  const { visuals, componentPathsByRoute, outputDir } = options;
  const repairComponent = options.repairComponent ?? repairComponentWithVisualDiff;
  const rebuild = options.rebuild ?? defaultRebuild;
  const configuredTurns = options.maxRepairTurnsPerRoute ?? 2;
  const maxTurns = Number.isFinite(configuredTurns) ? Math.max(0, Math.floor(configuredTurns)) : 0;
  const repairs: RepairRecord[] = [];

  const failingByRoute = new Map<string, VisualCheck[]>();
  for (const visual of visuals) {
    if (visual.passed !== false) continue;
    const group = failingByRoute.get(visual.path);
    if (group !== undefined) group.push(visual);
    else failingByRoute.set(visual.path, [visual]);
  }

  const repairedVisuals = new Map(visuals.map((visual) => [visual, visual]));

  for (const [routePath, initialFailures] of failingByRoute) {
    const componentPath = componentPathsByRoute.get(routePath);
    if (componentPath === undefined || maxTurns === 0 || options.reVerify === undefined) continue;
    let resolvedComponentPath: string;
    try {
      const relativeComponent = componentPath.startsWith('/')
        ? relative(outputDir, componentPath)
        : componentPath;
      resolvedComponentPath = resolveContainedPath(outputDir, relativeComponent);
      await assertNoSymlinkComponents(outputDir, resolvedComponentPath);
    } catch {
      continue;
    }

    let acceptedCode: string;
    try {
      acceptedCode = await readFile(resolvedComponentPath, 'utf8');
    } catch {
      continue;
    }

    let acceptedChecks = initialFailures;
    for (let turn = 0; turn < maxTurns; turn += 1) {
      const failures = acceptedChecks.filter((check) => check.passed === false);
      if (failures.length === 0) break;
      const worst = failures.reduce((a, b) =>
        (b.mismatchPercent ?? 0) > (a.mismatchPercent ?? 0) ? b : a,
      );
      if (worst.referenceScreenshot === null || worst.diffImage === null || worst.mismatchPercent === null) break;
      const originalDataUrl = await loadDataUrl(worst.referenceScreenshot);
      const diffDataUrl = await loadDataUrl(worst.diffImage);
      if (originalDataUrl === null || diffDataUrl === null) break;

      let candidateCode: string;
      try {
        candidateCode = await repairComponent(
          resolvedComponentPath,
          acceptedCode,
          originalDataUrl,
          diffDataUrl,
          worst.mismatchPercent,
        );
        await writeFile(resolvedComponentPath, candidateCode, 'utf8');
      } catch {
        break;
      }

      const buildOk = await rebuild(outputDir);
      const fresh = buildOk ? await options.reVerify(routePath) : [];
      const comparable = failures.map((before) => ({
        before,
        after: fresh.find((check) => check.path === before.path && check.viewport === before.viewport),
      }));
      const regressed = !buildOk || comparable.some(({ before, after }) =>
        after === undefined ||
        after.passed === false && before.passed !== false ||
        after.mismatchPercent === null ||
        before.mismatchPercent === null ||
        after.mismatchPercent > before.mismatchPercent,
      );
      const improved = !regressed && comparable.some(({ before, after }) =>
        after?.passed === true ||
        (after?.mismatchPercent !== null && after?.mismatchPercent !== undefined &&
          before.mismatchPercent !== null && after.mismatchPercent < before.mismatchPercent),
      );

      for (const { before, after } of comparable) {
        repairs.push({
          path: routePath,
          viewport: before.viewport,
          mismatchBefore: before.mismatchPercent ?? worst.mismatchPercent,
          mismatchAfter: after?.mismatchPercent ?? null,
          fixed: after?.passed === true,
        });
      }

      if (regressed || !improved) {
        await writeFile(resolvedComponentPath, acceptedCode, 'utf8');
        await rebuild(outputDir);
        break;
      }

      acceptedCode = candidateCode;
      acceptedChecks = fresh;
      for (const check of fresh) {
        const existing = visuals.find((visual) => visual.path === check.path && visual.viewport === check.viewport);
        if (existing !== undefined) repairedVisuals.set(existing, check);
      }
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
  /** Set false to disable bounded visual diff repair. */
  repair?: boolean;
  /** Maximum visual repair turns per route (default: 2). */
  maxRepairTurnsPerRoute?: number;
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

/** Loads the strictly validated evidence manifest, or null. */
async function tryLoadManifest(evidenceDir: string): Promise<EvidenceManifest | null> {
  try {
    return await loadEvidenceManifest(evidenceDir);
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
  const candidates: string[] = [];
  try {
    candidates.push(resolveContainedPath(evidenceDir, path));
  } catch {
    return null;
  }

  for (const candidate of candidates) {
    try {
      await assertNoSymlinkComponents(evidenceDir, candidate);
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

  const authorizationValid = plan !== null && plan.approved && manifest !== null;
  if (!authorizationValid) {
    diagnostics.push('Verification requires a valid approved plan and evidence manifest; route and visual tiers are blocked.');
  }
  const { routePaths, visualRoutes } = authorizationValid
    ? await buildRouteInputs(plan, manifest, evidenceDir)
    : { routePaths: [], visualRoutes: [] };

  // --- Tier 1: build ---------------------------------------------------
  const build = await verifyBuild(outputDir);
  if (!build.success) {
    diagnostics.push(
      `Build failed (${build.errors.length} error line(s)); visual tiers may use a stale dist/.`,
    );
  }
  if (build.typecheckBypassed === true) {
    diagnostics.push(
      `Residual type errors remain after ${(build.repair?.repairedFiles ?? []).length} repair target(s); ` +
        'the build is failed even if dist/ exists.',
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
          maxRepairTurnsPerRoute: options.maxRepairTurnsPerRoute,
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
              `${fixed} now below threshold (bounded keep/revert turns).`,
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

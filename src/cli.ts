#!/usr/bin/env node
/**
 * apograph — CLI entrypoint (Layer 5: Orchestration).
 *
 * Commands:
 *   apograph plan [dir]           Generate the authoritative plan from evidence and approve it interactively.
 *   apograph crawl <url>          Headless evidence crawl: screenshots, a11y trees, tokens, mirrored assets.
 *   apograph clone <url>          Full pipeline: crawl -> plan (approval gate) -> modular synthesize -> emit -> verify.
 *   apograph synthesize <dir>     Modular synthesis from an approved apograph-plan.json.
 *   apograph verify <dir> [dir2]  3-tier verification: build, route smoke, visual comparison.
 *   apograph config               Configure the LLM provider (stored in ~/.apograph/config.json).
 *   apograph doctor               Check environment health (Node, Chromium, LLM, Ollama).
 *   apograph setup                Install the apograph MCP server into your coding agent.
 *   apograph mcp                  Start the apograph MCP server over stdio.
 */

import { Command } from 'commander';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as p from '@clack/prompts';
import type { CrawlScope, EvidenceManifest, ViewportMode } from './types.js';
import type { ApographPlan } from './plan/schema.js';
import { crawlEvidence } from './crawler/engine.js';
import { urlHasSubpath } from './crawler/urls.js';
import { synthesizeModularProject, copyMirroredAssets } from './synthesizer/modular.js';
import { emitProject } from './emitter/scaffold.js';
import { runVerification } from './verifier/engine.js';
import { printVerificationSummary, writeVerificationReport } from './verifier/report.js';
import { runDoctor } from './commands/doctor.js';
import { runSetup } from './commands/setup.js';
import { runMcpServer } from './mcp/server.js';
import { getVersion } from './version.js';
import { runConfigCommand } from './commands/config.js';
import { runStatusCommand } from './commands/status.js';
import { startProgress } from './utils/progress.js';
import type { ProgressHandle } from './utils/progress.js';
import {
  loadCheckpoint,
  clearCheckpoint,
  setupInterruptTrap,
} from './utils/interrupt.js';
import type { CloneCheckpoint, CloneStage } from './utils/interrupt.js';
import {
  createPlanFromEvidence,
  loadEvidenceManifest,
  validatePlan,
  writePlanFile,
  DEFAULT_EVIDENCE_DIR,
  PLAN_FILENAME,
} from './plan/generator.js';
import { runApprovalGate, ApprovalCancelledError } from './plan/gate.js';
import {
  runEvidenceReviewGate,
  recrawlRoute,
  EvidenceGateAbortedError,
} from './plan/evidenceGate.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Derives an app name from a URL's hostname (e.g. app.example.com -> app-example-com). */
function appNameFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    const slug = host.replace(/[^-a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug.length > 0 ? slug : 'apograph-app';
  } catch {
    return 'apograph-app';
  }
}

/** Derives a default output directory from a URL's hostname. */
function outDirFromUrl(url: string): string {
  return join('./output', appNameFromUrl(url));
}

/** Parses a <number> commander option into a safe integer. */
function parseNumber(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Parses a --viewport option into a validated ViewportMode. */
function parseViewportOption(value: string | undefined): ViewportMode {
  if (value === undefined) return 'both';
  if (value === 'both' || value === 'desktop' || value === 'mobile') return value;
  throw new Error(`Invalid --viewport value: ${value} (expected both, desktop, or mobile).`);
}

/** Parses a --scope option into a validated CrawlScope. */
function parseScopeOption(value: string | undefined): CrawlScope | undefined {
  if (value === undefined) return undefined;
  if (value === 'single' || value === 'subtree' || value === 'site') return value;
  throw new Error(`Invalid --scope value: ${value} (expected single, subtree, or site).`);
}

/** True when prompts can be shown (TTY attached and not suppressed). */
function isInteractive(nonInteractive: boolean): boolean {
  return !nonInteractive && process.stdout.isTTY === true && process.stdin.isTTY === true;
}

/**
 * Resolves the crawl scope for a target URL:
 * - explicit `--scope` always wins;
 * - a root URL (no subpath) is always `site`;
 * - a subpath in interactive mode prompts: [1] single page, [2] subtree,
 *   [3] full site;
 * - a subpath non-interactively defaults to `site` (full site).
 */
async function resolveCrawlScope(
  url: string,
  requested: CrawlScope | undefined,
  interactive: boolean,
): Promise<{ scope: CrawlScope; maxPagesCap: number | null }> {
  if (requested !== undefined) {
    return { scope: requested, maxPagesCap: requested === 'single' ? 1 : null };
  }

  if (!urlHasSubpath(url)) {
    return { scope: 'site', maxPagesCap: null };
  }

  if (!interactive) {
    return { scope: 'site', maxPagesCap: null };
  }

  const choice = await p.select({
    message: `${url} is a subpage. What should be crawled?`,
    options: [
      {
        value: 'single' as const,
        label: '1. Single page only',
        hint: 'capture just this page (cap: 1)',
      },
      {
        value: 'subtree' as const,
        label: '2. Subtree crawl',
        hint: 'pages starting with this path',
      },
      {
        value: 'site' as const,
        label: '3. Full site',
        hint: 'crawl from the root origin',
      },
    ],
  });

  if (p.isCancel(choice)) {
    throw new Error('Crawl cancelled at the scope prompt.');
  }

  return { scope: choice, maxPagesCap: choice === 'single' ? 1 : null };
}

// ---------------------------------------------------------------------------
// Plan-driven modular synthesis
// ---------------------------------------------------------------------------

/** Resolves the plan file from a path that is either the plan itself or its directory. */
async function resolvePlanPath(planOrEvidenceDir: string): Promise<string> {
  const direct = resolve(planOrEvidenceDir);

  try {
    await readFile(direct, 'utf8');
    return direct;
  } catch {
    // Not a readable file — treat as a directory.
  }

  const inDir = join(direct, PLAN_FILENAME);
  try {
    await readFile(inDir, 'utf8');
    return inDir;
  } catch {
    // No plan in the directory.
  }

  throw new Error(
    `No plan found at ${direct} (looked for ${inDir}). ` +
      'Run `apograph crawl <url>` and `apograph plan` first.',
  );
}

/** Locates the evidence directory backing a plan file (manifest.json). */
async function resolveEvidenceDir(planPath: string): Promise<string> {
  const besidePlan = join(resolve(planPath), '..');
  try {
    await readFile(join(besidePlan, 'manifest.json'), 'utf8');
    return besidePlan;
  } catch {
    // Fall through to the default evidence dir.
  }

  try {
    await readFile(join(DEFAULT_EVIDENCE_DIR, 'manifest.json'), 'utf8');
    return DEFAULT_EVIDENCE_DIR;
  } catch {
    throw new Error(
      `No evidence manifest found beside the plan (${besidePlan}) or at ${resolve(DEFAULT_EVIDENCE_DIR)}.`,
    );
  }
}

/** Loads and validates a plan plus its backing evidence bundle. */
async function loadPlanAndEvidence(
  planOrEvidenceDir: string,
): Promise<{ plan: ApographPlan; manifest: EvidenceManifest; evidenceDir: string; planPath: string }> {
  const planPath = await resolvePlanPath(planOrEvidenceDir);
  const plan = validatePlan(JSON.parse(await readFile(planPath, 'utf8')));
  const evidenceDir = await resolveEvidenceDir(planPath);
  const manifest = await loadEvidenceManifest(evidenceDir);
  return { plan, manifest, evidenceDir, planPath };
}

/** Options for the modular synthesis -> emit -> verify half-pipeline. */
interface ModularSynthesisOptions {
  force: boolean;
  interactive: boolean;
  verify: boolean;
  viewport: ViewportMode;
  /** Route paths to skip because their page files already exist. */
  skipRoutePaths?: string[];
  /** Receives route paths as their pages finish synthesizing. */
  onRouteCompleted?: (path: string) => void;
}

/** Finds included routes whose page files already exist under `outDir`. */
function existingPagePaths(plan: ApographPlan, outDir: string): string[] {
  const existing: string[] = [];
  for (const route of plan.routes) {
    if (!route.included) continue;
    const pageFile = join(resolve(outDir), 'src', 'pages', `${route.componentName}.tsx`);
    if (existsSync(pageFile)) existing.push(route.path);
  }
  return existing;
}

/** Runs the modular synthesis -> emit -> asset copy -> verify half of the pipeline. */
async function runModularSynthesis(
  plan: ApographPlan,
  manifest: EvidenceManifest,
  evidenceDir: string,
  outDir: string,
  options: ModularSynthesisOptions,
): Promise<void> {
  const included = plan.routes.filter((route) => route.included);

  console.log(
    `→ Synthesizing project for ${included.length} route(s) ` +
      '(4-stage modular pipeline)...',
  );
  const result = await synthesizeModularProject({
    plan,
    manifest,
    evidenceDir,
    callbacks: {
      startProgress: startProgress,
      skipRoutePaths: options.skipRoutePaths,
      onRouteCompleted: options.onRouteCompleted,
    },
  });
  console.log(
    `→ Synthesis: ${result.visionStages.length} stage(s) via vision LLM, ` +
      `${result.fallbackStages.length} via deterministic fallback.` +
      (result.skippedRoutePaths.length > 0
        ? ` Skipped ${result.skippedRoutePaths.length} already-synthesized route(s).`
        : ''),
  );

  console.log(`→ Emitting project to ${resolve(outDir)}...`);
  const { writtenFiles, projectDir } = await emitProject(result.files, outDir, plan.appName, {
    force: options.force,
    interactive: options.interactive,
    metadata: manifest.routes[0]?.metadata,
  });
  console.log(`→ Wrote ${writtenFiles.length} files to ${projectDir}.`);

  const assetsCopied = await copyMirroredAssets(join(evidenceDir, 'assets'), projectDir);
  if (assetsCopied > 0) {
    console.log(`→ Mirrored ${assetsCopied} asset(s) into public/assets/.`);
  }

  if (options.verify) {
    const progress = startProgress('Running 3-tier verification');
    let report;
    try {
      report = await runVerification({
        outputDir: projectDir,
        evidenceDir,
        viewport: options.viewport,
      });
    } finally {
      progress.stop('Verification finished');
    }
    printVerificationSummary(report);
    const reportPath = await writeVerificationReport(projectDir, report);
    console.log(`→ Verification report: ${reportPath}`);
    if (!report.overall.passed) {
      console.warn('→ Verification found gaps — see the diagnostics above.');
    }
  }

  console.log('');
  console.log('✔ Done.');
  console.log(`  Output:  ${projectDir}`);
  console.log('  Boot it: cd into the project and run pnpm install && pnpm dev');
}

// ---------------------------------------------------------------------------
// Clone pipeline (shared by `clone` and `resume`)
// ---------------------------------------------------------------------------

/** Options for the shared clone pipeline. */
interface ClonePipelineOptions {
  url: string;
  outDir: string;
  evidenceDir: string;
  viewport: ViewportMode;
  requestedScope: CrawlScope | undefined;
  maxDepth: number;
  maxPages: number;
  yes: boolean;
  noReview: boolean;
  force: boolean;
  verify: boolean;
  interactive: boolean;
  /** Checkpoint to resume from (skips crawl + approval gate). */
  resumeFrom?: CloneCheckpoint;
}

/**
 * Runs the full clone pipeline: crawl → plan (approval gate) → modular
 * synthesize → emit → verify, with a live spinner, a SIGINT checkpoint trap,
 * and checkpoint-resumable stages.
 */
async function runClonePipeline(options: ClonePipelineOptions): Promise<void> {
  const {
    url,
    outDir,
    evidenceDir,
    viewport,
    requestedScope,
    maxDepth,
    maxPages,
    yes,
    noReview,
    force,
    verify,
    interactive,
    resumeFrom,
  } = options;

  // --- Spinner holder (the interrupt trap stops/restarts this) ------------
  let activeSpinner: ProgressHandle | null = null;
  let activeLabel: string | null = null;

  const stopSpinner = (): void => {
    activeSpinner?.stop('Interrupted');
    activeSpinner = null;
  };
  const restartSpinner = (): void => {
    if (activeLabel !== null) activeSpinner = startProgress(activeLabel);
  };

  // --- Checkpoint state ----------------------------------------------------
  let stage: CloneStage = 'crawl';
  const completedRoutePaths = new Set<string>(resumeFrom?.completedRoutePaths ?? []);

  const disposeTrap = setupInterruptTrap({
    workingDir: '.',
    interactive,
    stopSpinner,
    restartSpinner,
    checkpoint: (): CloneCheckpoint => ({
      targetUrl: url,
      stage,
      savedAt: new Date().toISOString(),
      evidenceDir,
      outDir,
      viewport,
      completedRoutePaths: [...completedRoutePaths],
    }),
  });

  try {
    // --- Step 1: headless evidence crawl (scope-resolved) ------------------
    let manifest: EvidenceManifest;

    const hasExistingEvidence = await manifestHasRoutes(evidenceDir);
    if (resumeFrom !== undefined && hasExistingEvidence) {
      console.log('→ Resuming: evidence bundle already crawled — skipping crawl.');
      manifest = await loadEvidenceManifest(evidenceDir);
    } else {
      const { scope, maxPagesCap } = await resolveCrawlScope(url, requestedScope, interactive);
      console.log(
        `→ Crawling ${url} with headless Chromium (scope: ${scope}, viewport: ${viewport})...`,
      );
      activeLabel = 'Crawl in progress';
      activeSpinner = startProgress(activeLabel);
      manifest = await crawlEvidence({
        rootUrl: url,
        evidenceDir,
        maxDepth,
        maxPages: maxPagesCap ?? maxPages,
        viewport,
        scope,
      });
      activeSpinner.stop(`Crawled ${manifest.stats.pagesCrawled} page(s)`);
      activeSpinner = null;
      activeLabel = null;
    }

    // --- Step 2: Gate 1 evidence review + plan generation + approval gate --
    stage = 'plan';
    let approved: ApographPlan;

    if (resumeFrom !== undefined) {
      console.log('→ Resuming: plan was approved in the previous run — auto-approving.');
      approved = createPlanFromEvidence(manifest);
      approved.approved = true;
      approved.approvedAt = new Date().toISOString();
      await writePlanFile(join(evidenceDir, PLAN_FILENAME), approved);
    } else {
      // Gate 1: evidence review before any plan generation (spec s3).
      console.log('→ Reviewing capture evidence (Gate 1)...');
      let gatedManifest: EvidenceManifest;
      try {
        const gated = await runEvidenceReviewGate(manifest, resolve(evidenceDir), {
          nonInteractive: yes || noReview,
          reCrawlRoute: (routeIndex) => recrawlRoute(manifest, routeIndex, resolve(evidenceDir)),
        });
        gatedManifest = gated.manifest;
        const prunedCount = gated.record.pruned.length;
        const aliasCount = gated.record.aliases.length;
        console.log(
          `→ Gate 1 complete: ${gatedManifest.routes.length} active route(s)` +
            (prunedCount > 0 ? `, ${prunedCount} pruned` : '') +
            (aliasCount > 0 ? `, ${aliasCount} aliased` : '') +
            `.`,
        );
      } catch (cause) {
        if (cause instanceof EvidenceGateAbortedError) {
          console.error('✖ Clone aborted: the evidence review gate was aborted.');
          process.exitCode = 1;
          return;
        }
        throw cause;
      }
      manifest = gatedManifest;

      const plan = createPlanFromEvidence(manifest);
      const planPath = join(evidenceDir, PLAN_FILENAME);
      await writePlanFile(planPath, plan);
      console.log(`→ Unapproved plan written to ${resolve(planPath)}`);

      try {
        approved = await runApprovalGate(planPath, { nonInteractive: yes });
      } catch (cause) {
        if (cause instanceof ApprovalCancelledError) {
          console.error('✖ Clone aborted: the plan was not approved.');
          process.exitCode = 1;
          return;
        }
        throw cause;
      }
    }

    // --- Steps 3–5: modular synthesis + emission + verification ------------
    stage = 'synthesize';
    await runModularSynthesis(approved, manifest, evidenceDir, outDir, {
      // A resumed run must merge — forcing would delete already-synthesized
      // pages that App.tsx imports.
      force: resumeFrom !== undefined ? false : force,
      interactive,
      verify,
      viewport,
      skipRoutePaths: existingPagePaths(approved, outDir),
      onRouteCompleted: (path) => {
        completedRoutePaths.add(path);
      },
    });
  } finally {
    disposeTrap();
  }

  await clearCheckpoint('.');
}

/** True when the evidence manifest in `dir` exists and has crawled routes. */
async function manifestHasRoutes(evidenceDir: string): Promise<boolean> {
  try {
    const manifest = await loadEvidenceManifest(evidenceDir);
    return manifest.routes.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// CLI program
// ---------------------------------------------------------------------------

/** Options for the `clone` command (commander passes numbers as strings). */
interface CloneOptions {
  out?: string;
  evidence: string;
  maxDepth: string;
  maxPages: string;
  viewport: string;
  scope?: string;
  yes: boolean;
  noReview: boolean;
  force: boolean;
  verify: boolean;
}

/** Options for the `crawl` command. */
interface CrawlCliOptions {
  evidence: string;
  maxDepth: string;
  maxPages: string;
  viewport: string;
  scope?: string;
}

/** Options for the `plan` command. */
interface PlanCliOptions {
  yes: boolean;
  noReview: boolean;
  out?: string;
}

/** Options for the `verify` command. */
interface VerifyCliOptions {
  threshold: string;
  viewport: string;
}

/** Options for the `synthesize` command. */
interface SynthesizeOptions {
  out?: string;
  force: boolean;
  verify: boolean;
  viewport: string;
}

const program = new Command('apograph');

program
  .name('apograph')
  .version(getVersion())
  .description('Cleanroom reverse-engineering and code synthesis tool');

program
  .command('plan')
  .description('Generate the authoritative plan from the evidence bundle and approve it interactively')
  .argument('[evidenceDir]', 'evidence directory (defaults to .apograph/evidence)', DEFAULT_EVIDENCE_DIR)
  .option('--yes', 'auto-approve the plan without interactive prompts')
  .option('--no-review', 'skip the Gate 1 evidence review (automated filtering only)')
  .option('-o, --out <file>', 'custom plan output path (defaults to <evidenceDir>/apograph-plan.json)')
  .action(async (evidenceDir: string, options: PlanCliOptions) => {
    console.log(`→ Reading evidence from ${resolve(evidenceDir)}...`);
    let manifest = await loadEvidenceManifest(evidenceDir);

    // Gate 1: evidence review before any plan generation (spec s3).
    console.log('→ Reviewing capture evidence (Gate 1)...');
    try {
      const gated = await runEvidenceReviewGate(manifest, resolve(evidenceDir), {
        nonInteractive: options.yes || options.noReview,
        reCrawlRoute: (routeIndex) => recrawlRoute(manifest, routeIndex, resolve(evidenceDir)),
      });
      manifest = gated.manifest;
      const prunedCount = gated.record.pruned.length;
      const aliasCount = gated.record.aliases.length;
      console.log(
        `→ Gate 1 complete: ${manifest.routes.length} active route(s)` +
          (prunedCount > 0 ? `, ${prunedCount} pruned` : '') +
          (aliasCount > 0 ? `, ${aliasCount} aliased` : '') +
          `.`,
      );
    } catch (cause) {
      if (cause instanceof EvidenceGateAbortedError) {
        console.error('✖ Plan cancelled: the evidence review gate was aborted.');
        process.exitCode = 1;
        return;
      }
      throw cause;
    }

    console.log(`→ Deriving plan from ${manifest.routes.length} crawled route(s)...`);
    const plan = createPlanFromEvidence(manifest);

    const planPath = options.out ?? join(evidenceDir, PLAN_FILENAME);
    await writePlanFile(planPath, plan);
    console.log(`→ Unapproved plan written to ${resolve(planPath)}`);

    const approved = await runApprovalGate(planPath, {
      nonInteractive: options.yes,
    });

    console.log('');
    console.log('✔ Plan ready.');
    console.log(`  Plan:    ${resolve(planPath)}`);
    console.log(`  Routes:  ${approved.routes.filter((route) => route.included).length} included / ${approved.routes.length} total`);
  });

program
  .command('crawl')
  .description('Headless evidence crawl: viewport screenshots, a11y trees, design tokens, SEO metadata, mirrored assets')
  .argument('<url>', 'root URL to crawl')
  .option('-e, --evidence <dir>', 'evidence output directory', '.apograph/evidence')
  .option('--max-depth <number>', 'max crawl depth', '2')
  .option('--max-pages <number>', 'max pages to crawl', '10')
  .option('--viewport <mode>', 'viewports to screenshot: both, desktop, or mobile', 'both')
  .option('--scope <mode>', 'crawl scope for subpath URLs: single, subtree, or site')
  .action(async (url: string, options: CrawlCliOptions) => {
    const viewport = parseViewportOption(options.viewport);
    const requestedScope = parseScopeOption(options.scope);
    const interactive = isInteractive(false);

    const { scope, maxPagesCap } = await resolveCrawlScope(url, requestedScope, interactive);
    if (maxPagesCap !== null) {
      console.log('→ Scope: single page (cap: 1).');
    } else if (requestedScope !== undefined || urlHasSubpath(url)) {
      console.log(`→ Scope: ${scope}.`);
    }

    const progress = startProgress('Crawl in progress');
    let manifest;
    try {
      manifest = await crawlEvidence({
        rootUrl: url,
        evidenceDir: options.evidence,
        maxDepth: parseNumber(options.maxDepth, 2),
        maxPages: maxPagesCap ?? parseNumber(options.maxPages, 10),
        viewport,
        scope,
      });
    } finally {
      progress.stop('Crawl finished');
    }

    console.log('');
    console.log('✔ Crawl complete.');
    console.log(`  Pages crawled:    ${manifest.stats.pagesCrawled}`);
    console.log(`  Links discovered: ${manifest.stats.linksDiscovered}`);
    console.log(`  Assets mirrored:  ${manifest.stats.assetsDownloaded} downloaded, ` +
      `${manifest.stats.assetsFailed} failed, ${manifest.stats.externalAssets} external`);
    console.log(`  Manifest:         ${resolve(options.evidence, 'manifest.json')}`);
  });

program
  .command('clone')
  .description('Full pipeline: crawl, plan (approval gate), modular synthesize, emit, verify')
  .argument('<url>', 'target URL to reverse-engineer')
  .option('-o, --out <dir>', 'output directory (defaults to ./output/<hostname>)')
  .option('-e, --evidence <dir>', 'evidence output directory', '.apograph/evidence')
  .option('--max-depth <number>', 'max crawl depth', '2')
  .option('--max-pages <number>', 'max pages to crawl', '10')
  .option('--viewport <mode>', 'viewports to screenshot and verify: both, desktop, or mobile', 'both')
  .option('--scope <mode>', 'crawl scope for subpath URLs: single, subtree, or site')
  .option('--yes', 'auto-approve the plan without interactive prompts')
  .option('--no-review', 'skip the Gate 1 evidence review (automated filtering only)')
  .option('--force', 'overwrite the output directory completely instead of merging')
  .option('--no-verify', 'skip the 3-tier verification pass')
  .action(async (url: string, options: CloneOptions) => {
    const viewport = parseViewportOption(options.viewport);
    const interactive = isInteractive(options.yes);

    // Checkpoint resumption: a saved run for this URL can be continued.
    const checkpoint = await loadCheckpoint('.');
    let resumeFrom: CloneCheckpoint | undefined;

    if (checkpoint !== null && checkpoint.targetUrl === url) {
      if (options.yes || !interactive) {
        resumeFrom = checkpoint;
        console.log(
          `→ Found saved checkpoint for ${url} (stage: ${checkpoint.stage}) — auto-resuming (--yes).`,
        );
      } else {
        const shouldResume = await p.confirm({
          message: `Found saved checkpoint for ${url}. Resume from previous progress?`,
          initialValue: true,
        });
        if (p.isCancel(shouldResume)) {
          console.error('✖ Clone cancelled.');
          process.exitCode = 1;
          return;
        }
        if (shouldResume) {
          resumeFrom = checkpoint;
        }
      }
    }

    await runClonePipeline({
      url,
      outDir: options.out ?? outDirFromUrl(url),
      evidenceDir: options.evidence,
      viewport,
      requestedScope: parseScopeOption(options.scope),
      maxDepth: parseNumber(options.maxDepth, 2),
      maxPages: parseNumber(options.maxPages, 10),
      yes: options.yes,
      noReview: options.noReview,
      force: options.force,
      verify: options.verify,
      interactive,
      resumeFrom,
    });
  });

program
  .command('resume')
  .description('Resume an interrupted clone from the saved checkpoint')
  .argument('[dir]', 'working directory', '.')
  .option('--no-verify', 'skip the 3-tier verification pass')
  .action(async (dir: string, options: { verify: boolean }) => {
    const checkpoint = await loadCheckpoint(dir);

    if (checkpoint === null) {
      console.error(
        `No checkpoint found at ${resolve(dir, '.apograph/checkpoint.json')}. ` +
          'Interrupt a run with Ctrl+C and choose "Save checkpoint" first.',
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `→ Resuming ${checkpoint.targetUrl} from stage "${checkpoint.stage}" ` +
        `(${checkpoint.completedRoutePaths.length} route(s) already synthesized).`,
    );

    const interactive = isInteractive(false);

    await runClonePipeline({
      url: checkpoint.targetUrl,
      outDir: checkpoint.outDir || outDirFromUrl(checkpoint.targetUrl),
      evidenceDir: checkpoint.evidenceDir,
      viewport: checkpoint.viewport,
      requestedScope: undefined,
      noReview: true,
      maxDepth: 2,
      maxPages: 10,
      yes: !interactive,
      force: false,
      verify: options.verify,
      interactive,
      resumeFrom: checkpoint,
    });
  });

program
  .command('synthesize')
  .description('Modular synthesis: build a standalone frontend from an approved apograph-plan.json')
  .argument('<planOrEvidenceDir>', 'directory containing apograph-plan.json (or the plan file itself)')
  .option('-o, --out <dir>', 'output directory (defaults to ./output/<appName>)')
  .option('--viewport <mode>', 'viewports to verify: both, desktop, or mobile', 'both')
  .option('--force', 'overwrite the output directory completely instead of merging')
  .option('--no-verify', 'skip the 3-tier verification pass')
  .action(async (dir: string, options: SynthesizeOptions) => {
    const { plan, manifest, evidenceDir } = await loadPlanAndEvidence(dir);

    if (!plan.approved) {
      throw new Error(
        'The plan is not approved. Run `apograph plan <dir>` and complete ' +
          'the approval gate (or use --yes) before synthesizing.',
      );
    }

    const outDir = options.out ?? join('output', plan.appName);
    await runModularSynthesis(plan, manifest, evidenceDir, outDir, {
      force: options.force,
      interactive: isInteractive(false),
      verify: options.verify,
      viewport: parseViewportOption(options.viewport),
    });
  });

program
  .command('verify')
  .description('3-tier verification of a generated project: build, headless route smoke check, visual screenshot comparison')
  .argument('<outputDir>', 'generated project directory to verify')
  .argument('[evidenceDir]', 'evidence directory (defaults to .apograph/evidence)', DEFAULT_EVIDENCE_DIR)
  .option('--threshold <number>', 'visual mismatch threshold in percent', '15')
  .option('--viewport <mode>', 'viewports to compare: both, desktop, or mobile', 'both')
  .action(async (outputDir: string, evidenceDir: string, options: VerifyCliOptions) => {
    const thresholdPercent = parseNumber(options.threshold, 15);

    const report = await runVerification({
      outputDir,
      evidenceDir,
      visualThreshold: thresholdPercent / 100,
      viewport: parseViewportOption(options.viewport),
    });

    printVerificationSummary(report);

    const reportPath = await writeVerificationReport(outputDir, report);
    console.log('');
    console.log(`✔ Verification report: ${reportPath}`);

    if (!report.overall.passed) {
      process.exitCode = 1;
    }
  });

program
  .command('status')
  .description('Show the status of generated projects under ./output/')
  .option('--all', 'show every project when there are more than 5')
  .action(async (options: { all: boolean }) => {
    await runStatusCommand(options);
  });

program
  .command('config')
  .description('Configure the LLM provider (ollama, openai, anthropic, or gateway); stored in ~/.apograph/config.json')
  .option('--show', 'print the current configuration and exit')
  .action(async (options: { show: boolean }) => {
    await runConfigCommand(options);
  });

program
  .command('doctor')
  .description('Check environment health: Node.js, headless Chromium, LLM connectivity, Ollama')
  .action(async () => {
    await runDoctor();
  });

program
  .command('mcp')
  .alias('serve')
  .description('Start the apograph MCP server over stdio (for AI coding agents and DSH)')
  .action(async () => {
    await runMcpServer();
  });

program
  .command('setup')
  .description('Install the apograph MCP server into your AI coding agent (Claude Desktop, Cursor, Claude Code, Windsurf, OpenCode, DSH)')
  .option('-c, --client <name>', 'only configure a specific agent (claude-desktop, cursor, claude-code, windsurf, opencode, dsh, custom)')
  .option('-p, --config-path <file>', 'with --client custom: path of the mcpServers JSON config to write or merge')
  .action(async (options: { client?: string; configPath?: string }) => {
    await runSetup(options);
  });

try {
  await program.parseAsync(process.argv);
} catch (cause) {
  console.error(`✖ ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 1;
}

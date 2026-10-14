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
 *   apograph doctor               Check environment health (Node, Chromium, LLM, Ollama).
 *   apograph setup                Install the apograph MCP server into your coding agent.
 */

import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { EvidenceManifest } from './types.js';
import type { ApographPlan } from './plan/schema.js';
import { crawlEvidence } from './crawler/engine.js';
import { synthesizeModularProject, copyMirroredAssets } from './synthesizer/modular.js';
import { emitProject } from './emitter/scaffold.js';
import { runVerification } from './verifier/engine.js';
import { printVerificationSummary, writeVerificationReport } from './verifier/report.js';
import { runDoctor } from './commands/doctor.js';
import { runSetup } from './commands/setup.js';
import {
  createPlanFromEvidence,
  loadEvidenceManifest,
  validatePlan,
  writePlanFile,
  DEFAULT_EVIDENCE_DIR,
  PLAN_FILENAME,
} from './plan/generator.js';
import { runApprovalGate, ApprovalCancelledError } from './plan/gate.js';

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

/** Runs the modular synthesis -> emit -> asset copy -> verify half of the pipeline. */
async function runModularSynthesis(
  plan: ApographPlan,
  manifest: EvidenceManifest,
  evidenceDir: string,
  outDir: string,
  verify: boolean,
): Promise<void> {
  const included = plan.routes.filter((route) => route.included);

  console.log(
    `→ Synthesizing project for ${included.length} route(s) ` +
      '(4-stage modular pipeline)...',
  );
  const result = await synthesizeModularProject({ plan, manifest, evidenceDir });
  console.log(
    `→ Synthesis: ${result.visionStages.length} stage(s) via vision LLM, ` +
      `${result.fallbackStages.length} via deterministic fallback.`,
  );

  console.log(`→ Emitting project to ${resolve(outDir)}...`);
  const { writtenFiles, projectDir } = await emitProject(result.files, outDir, plan.appName);
  console.log(`→ Wrote ${writtenFiles.length} files to ${projectDir}.`);

  const assetsCopied = await copyMirroredAssets(join(evidenceDir, 'assets'), projectDir);
  if (assetsCopied > 0) {
    console.log(`→ Mirrored ${assetsCopied} asset(s) into public/assets/.`);
  }

  if (verify) {
    console.log('→ Running 3-tier verification (build, routes, visuals)...');
    const report = await runVerification({ outputDir: projectDir, evidenceDir });
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
  console.log('  Boot it: cd into the project and run `pnpm install && pnpm dev`');
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
  yes: boolean;
  verify: boolean;
}

/** Options for the `crawl` command. */
interface CrawlCliOptions {
  evidence: string;
  maxDepth: string;
  maxPages: string;
}

/** Options for the `plan` command. */
interface PlanCliOptions {
  yes: boolean;
  out?: string;
}

/** Options for the `verify` command. */
interface VerifyCliOptions {
  threshold: string;
}

/** Options for the `synthesize` command. */
interface SynthesizeOptions {
  out?: string;
  verify: boolean;
}

const program = new Command('apograph');

program
  .name('apograph')
  .version('0.1.0')
  .description('Cleanroom reverse-engineering and code synthesis tool');

program
  .command('plan')
  .description('Generate the authoritative plan from the evidence bundle and approve it interactively')
  .argument('[evidenceDir]', 'evidence directory (defaults to .apograph/evidence)', DEFAULT_EVIDENCE_DIR)
  .option('--yes', 'auto-approve the plan without interactive prompts')
  .option('-o, --out <file>', 'custom plan output path (defaults to <evidenceDir>/apograph-plan.json)')
  .action(async (evidenceDir: string, options: PlanCliOptions) => {
    console.log(`→ Reading evidence from ${resolve(evidenceDir)}...`);
    const manifest = await loadEvidenceManifest(evidenceDir);

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
  .description('Headless evidence crawl: dual-viewport screenshots, a11y trees, design tokens, mirrored assets')
  .argument('<url>', 'root URL to crawl')
  .option('-e, --evidence <dir>', 'evidence output directory', '.apograph/evidence')
  .option('--max-depth <number>', 'max crawl depth', '2')
  .option('--max-pages <number>', 'max pages to crawl', '10')
  .action(async (url: string, options: CrawlCliOptions) => {
    const manifest = await crawlEvidence({
      rootUrl: url,
      evidenceDir: options.evidence,
      maxDepth: parseNumber(options.maxDepth, 2),
      maxPages: parseNumber(options.maxPages, 10),
    });

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
  .option('--yes', 'auto-approve the plan without interactive prompts')
  .option('--no-verify', 'skip the 3-tier verification pass')
  .action(async (url: string, options: CloneOptions) => {
    const outDir = options.out ?? outDirFromUrl(url);

    // Step 1: headless evidence crawl.
    console.log(`→ Crawling ${url} with headless Chromium...`);
    await crawlEvidence({
      rootUrl: url,
      evidenceDir: options.evidence,
      maxDepth: parseNumber(options.maxDepth, 2),
      maxPages: parseNumber(options.maxPages, 10),
    });

    // Step 2: plan generation + approval gate.
    const manifest = await loadEvidenceManifest(options.evidence);
    const plan = createPlanFromEvidence(manifest);
    const planPath = join(options.evidence, PLAN_FILENAME);
    await writePlanFile(planPath, plan);
    console.log(`→ Unapproved plan written to ${resolve(planPath)}`);

    let approved: ApographPlan;
    try {
      approved = await runApprovalGate(planPath, { nonInteractive: options.yes });
    } catch (cause) {
      if (cause instanceof ApprovalCancelledError) {
        console.error('✖ Clone aborted: the plan was not approved.');
        process.exitCode = 1;
        return;
      }
      throw cause;
    }

    // Steps 3–5: modular synthesis + emission + verification.
    await runModularSynthesis(approved, manifest, options.evidence, outDir, options.verify);
  });

program
  .command('synthesize')
  .description('Modular synthesis: build a standalone frontend from an approved apograph-plan.json')
  .argument('<planOrEvidenceDir>', 'directory containing apograph-plan.json (or the plan file itself)')
  .option('-o, --out <dir>', 'output directory (defaults to ./output/<appName>)')
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
    await runModularSynthesis(plan, manifest, evidenceDir, outDir, options.verify);
  });

program
  .command('verify')
  .description('3-tier verification of a generated project: build, headless route smoke check, visual screenshot comparison')
  .argument('<outputDir>', 'generated project directory to verify')
  .argument('[evidenceDir]', 'evidence directory (defaults to .apograph/evidence)', DEFAULT_EVIDENCE_DIR)
  .option('--threshold <number>', 'visual mismatch threshold in percent', '15')
  .action(async (outputDir: string, evidenceDir: string, options: VerifyCliOptions) => {
    const thresholdPercent = parseNumber(options.threshold, 15);

    const report = await runVerification({
      outputDir,
      evidenceDir,
      visualThreshold: thresholdPercent / 100,
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
  .command('doctor')
  .description('Check environment health: Node.js, headless Chromium, LLM connectivity, Ollama')
  .action(async () => {
    await runDoctor();
  });

program
  .command('setup')
  .description('Install the apograph MCP server into your AI coding agent (Claude Desktop, Cursor, Claude Code, Windsurf, OpenCode)')
  .option('-c, --client <name>', 'only configure a specific agent (claude-desktop, cursor, claude-code, windsurf, opencode)')
  .action(async (options: { client?: string }) => {
    await runSetup(options);
  });

try {
  await program.parseAsync(process.argv);
} catch (cause) {
  console.error(`✖ ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 1;
}

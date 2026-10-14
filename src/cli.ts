#!/usr/bin/env node
/**
 * apograph — CLI entrypoint (Layer 5: Orchestration).
 *
 * Commands:
 *   apograph clone <url>       Full pipeline: harvest -> decompile -> infer -> synthesize -> emit -> verify.
 *   apograph harvest <url>     Capture only; writes session.json / snapshot.json / unpacked scripts.
 *   apograph synthesize <dir>  Rebuild from a previous harvest directory.
 *   apograph doctor            Check environment health (Node, CDP, LLM, Ollama).
 *   apograph setup             Install the apograph MCP server into your coding agent.
 */

import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Page } from 'playwright';
import type {
  HarvestedSession,
  DOMSnapshot,
  RecordedRequest,
  DecompiledBundle,
} from './types.js';
import { attachToCDP, disconnectCDP } from './harvester/cdp.js';
import { NetworkCollector } from './harvester/network.js';
import { captureDOMSnapshot } from './harvester/dom.js';
import { harvestAndDecompileScripts } from './decompile/bundle.js';
import { clusterEndpoints, enrichRequestsWithRoutePatterns } from './infer/routes.js';
import { inferAllSchemas } from './infer/schema.js';
import { synthesizeFrontend } from './synthesizer/frontend.js';
import { synthesizeBackend } from './synthesizer/backend.js';
import { emitProject } from './emitter/scaffold.js';
import { verifyAndSelfHeal } from './verifier/smoke.js';
import { runDoctor } from './commands/doctor.js';
import { runSetup } from './commands/setup.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface HarvestOutcome {
  session: HarvestedSession;
  snapshot: DOMSnapshot;
  bundles: DecompiledBundle[];
}

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

/** Fetches the raw source text of every external script on the page. */
async function collectScriptSources(page: Page): Promise<string[]> {
  const srcs = await page.$$eval('script[src]', (els) =>
    els.map((el) => (el as HTMLScriptElement).src),
  );

  const sources: string[] = [];
  for (const src of srcs) {
    try {
      const text = await page.evaluate(
        async (scriptUrl: string): Promise<string | null> => {
          const response = await fetch(scriptUrl);
          return response.ok ? response.text() : null;
        },
        src,
      );
      if (text !== null && text.length > 0) sources.push(text);
    } catch {
      // Unreachable script (CORS-rejected, 404, etc.) — skip it.
    }
  }
  return sources;
}

/** Runs the capture half of the pipeline (steps 1–8 of `clone`). */
async function runHarvest(url: string, port: number): Promise<HarvestOutcome> {
  console.log(`→ Connecting to Chrome on port ${port}...`);

  const { browser, page } = await attachToCDP({ port });

  const collector = new NetworkCollector();
  collector.attach(page);

  console.log(`→ Navigating to ${url}...`);
  await page.goto(url, { waitUntil: 'networkidle' });

  const scriptSources = await collectScriptSources(page);

  console.log('→ Capturing DOM snapshot (a11y tree + design tokens)...');
  const snapshot = await captureDOMSnapshot(page, url);

  const requests: RecordedRequest[] = enrichRequestsWithRoutePatterns(
    collector.stop(page),
  );

  await disconnectCDP(browser);

  console.log(
    `→ Harvest complete: ${requests.length} requests, ${scriptSources.length} scripts.`,
  );

  const session: HarvestedSession = {
    id: randomUUID(),
    targetUrl: url,
    requests,
    socketFrames: [],
    events: [],
    scripts: scriptSources,
  };

  const bundles = await harvestAndDecompileScripts(scriptSources);

  return { session, snapshot, bundles };
}

/** Persists a harvest outcome to disk (session, snapshot, unpacked scripts). */
async function persistHarvest(
  dir: string,
  outcome: HarvestOutcome,
): Promise<void> {
  const absolute = resolve(dir);
  await mkdir(absolute, { recursive: true });

  await writeFile(
    join(absolute, 'session.json'),
    JSON.stringify(outcome.session, null, 2),
    'utf8',
  );
  await writeFile(
    join(absolute, 'snapshot.json'),
    JSON.stringify(outcome.snapshot, null, 2),
    'utf8',
  );

  const scriptsDir = join(absolute, 'scripts');
  await mkdir(scriptsDir, { recursive: true });
  for (const bundle of outcome.bundles) {
    const bundleDir = join(scriptsDir, bundle.bundleName);
    await mkdir(bundleDir, { recursive: true });
    for (const module of bundle.modules) {
      await writeFile(
        join(bundleDir, module.path.replace(/\.\.\//g, '_').replace(/^\//, '')),
        module.rawCode,
        'utf8',
      );
    }
  }
}

/** Runs the synthesis half of the pipeline (steps 10–14 of `clone`). */
async function runSynthesis(
  session: HarvestedSession,
  snapshot: DOMSnapshot,
  bundles: DecompiledBundle[],
  outDir: string,
  verify: boolean,
  passes: number,
): Promise<void> {
  const appName = appNameFromUrl(session.targetUrl);

  console.log('→ Clustering endpoints and inferring contracts...');
  const clusters = clusterEndpoints(session.requests);
  const schemas = inferAllSchemas(session.requests, clusters);
  console.log(`→ ${clusters.length} endpoint clusters, ${schemas.length} contracts inferred.`);

  console.log('→ Synthesizing frontend and backend...');
  const [frontendFiles, backendFiles] = await Promise.all([
    synthesizeFrontend([snapshot], bundles),
    synthesizeBackend(schemas),
  ]);

  console.log(`→ Emitting project to ${resolve(outDir)}...`);
  const { writtenFiles, projectDir } = await emitProject(
    [...frontendFiles, ...backendFiles],
    outDir,
    appName,
  );
  console.log(`→ Wrote ${writtenFiles.length} files to ${projectDir}.`);

  if (verify) {
    console.log(`→ Running smoke verification (max ${passes} repair passes)...`);
    const result = await verifyAndSelfHeal(outDir, passes);
    if (result.success) {
      console.log(
        `→ Verification passed after ${result.passesRun} pass(es); ` +
          `${result.repairedFiles.length} file(s) repaired.`,
      );
    } else {
      console.warn(
        `→ Verification FAILED after ${result.passesRun} pass(es). ` +
          'Inspect the project and re-run with --passes for more repair attempts.',
      );
    }
  }

  console.log('');
  console.log('✔ Done.');
  console.log(`  Output:  ${projectDir}`);
  console.log('  Boot it: cd into the project and run `docker compose up`');
}

/** Loads a prior harvest from disk. */
async function loadHarvest(dir: string): Promise<HarvestOutcome> {
  const absolute = resolve(dir);

  const session = JSON.parse(
    await readFile(join(absolute, 'session.json'), 'utf8'),
  ) as HarvestedSession;

  const snapshot = JSON.parse(
    await readFile(join(absolute, 'snapshot.json'), 'utf8'),
  ) as DOMSnapshot;

  const bundles = await harvestAndDecompileScripts(session.scripts);

  return { session, snapshot, bundles };
}

// ---------------------------------------------------------------------------
// CLI program
// ---------------------------------------------------------------------------

/** Options for the `clone` command (commander passes numbers as strings). */
interface CloneOptions {
  port: string;
  out?: string;
  verify: boolean;
  passes: string;
}

/** Options for the `harvest` command. */
interface HarvestOptions {
  port: string;
  out?: string;
}

/** Options for the `synthesize` command. */
interface SynthesizeOptions {
  out?: string;
  verify: boolean;
  passes: string;
}

const program = new Command('apograph');

program
  .name('apograph')
  .version('0.1.0')
  .description('Cleanroom reverse-engineering and code synthesis tool');

program
  .command('clone')
  .description('Full pipeline: harvest, decompile, infer, synthesize, emit, verify')
  .argument('<url>', 'target URL to reverse-engineer')
  .option('-p, --port <number>', 'Chrome CDP port', '9222')
  .option('-o, --out <dir>', 'output directory (defaults to ./output/<hostname>)')
  .option('--no-verify', 'skip smoke verification and self-healing')
  .option('--passes <number>', 'max self-healing repair passes', '2')
  .action(async (url: string, options: CloneOptions) => {
    const port = parseNumber(options.port, 9222);
    const outDir = options.out ?? outDirFromUrl(url);
    const passes = parseNumber(options.passes, 2);

    const outcome = await runHarvest(url, port);
    await persistHarvest(outDir, outcome);
    await runSynthesis(outcome.session, outcome.snapshot, outcome.bundles, outDir, options.verify, passes);
  });

program
  .command('harvest')
  .description('Capture only: writes session.json, snapshot.json, and unpacked scripts')
  .argument('<url>', 'target URL to harvest')
  .option('-p, --port <number>', 'Chrome CDP port', '9222')
  .option('-o, --out <dir>', 'output directory (defaults to ./output/<hostname>)')
  .action(async (url: string, options: HarvestOptions) => {
    const port = parseNumber(options.port, 9222);
    const outDir = options.out ?? outDirFromUrl(url);

    const outcome = await runHarvest(url, port);
    await persistHarvest(outDir, outcome);

    console.log('');
    console.log('✔ Harvest saved.');
    console.log(`  Output: ${resolve(outDir)}`);
    console.log(`  Next:   apograph synthesize ${resolve(outDir)}`);
  });

program
  .command('synthesize')
  .description('Synthesize a project from a previous harvest directory')
  .argument('<dir>', 'directory containing session.json and snapshot.json')
  .option('-o, --out <dir>', 'output directory (defaults to <dir>/app)')
  .option('--no-verify', 'skip smoke verification and self-healing')
  .option('--passes <number>', 'max self-healing repair passes', '2')
  .action(async (dir: string, options: SynthesizeOptions) => {
    const outDir = options.out ?? join(resolve(dir), 'app');
    const passes = parseNumber(options.passes, 2);

    const outcome = await loadHarvest(dir);
    await runSynthesis(outcome.session, outcome.snapshot, outcome.bundles, outDir, options.verify, passes);
  });

program
  .command('doctor')
  .description('Check environment health: Node.js, Chrome CDP, LLM connectivity, Ollama')
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

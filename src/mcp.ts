#!/usr/bin/env node
/**
 * apograph — MCP server (Layer 5: Agent Orchestrator).
 *
 * Exposes the apograph pipeline as Model Context Protocol tools so external
 * LLM agents can drive harvesting, contract inference, and full cleanroom
 * synthesis over stdio.
 */

import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Page } from 'playwright';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type {
  HarvestedSession,
  DOMSnapshot,
  RecordedRequest,
  DecompiledBundle,
} from './types.js';
import { launchHeadlessChromium, crawlEvidence } from './crawler/engine.js';
import { NetworkCollector } from './harvester/network.js';
import { captureDOMSnapshot } from './harvester/dom.js';
import { harvestAndDecompileScripts } from './legacy/decompile/bundle.js';
import { clusterEndpoints, enrichRequestsWithRoutePatterns } from './legacy/infer/routes.js';
import { inferAllSchemas } from './legacy/infer/schema.js';
import { synthesizeFrontend } from './synthesizer/frontend.js';
import { synthesizeBackend, formatSchemasForPrompt } from './legacy/synthesizer/backend.js';
import { emitProject } from './emitter/scaffold.js';
import { verifyAndSelfHeal } from './verifier/smoke.js';

// ---------------------------------------------------------------------------
// Shared pipeline internals (mirrors src/cli.ts)
// ---------------------------------------------------------------------------

interface HarvestOutcome {
  session: HarvestedSession;
  snapshot: DOMSnapshot;
  bundles: DecompiledBundle[];
}

/** Derives an app name from a URL's hostname. */
function appNameFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    const slug = host.replace(/[^-a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug.length > 0 ? slug : 'apograph-app';
  } catch {
    return 'apograph-app';
  }
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

/** Runs the capture half of the pipeline. */
async function runHarvest(url: string): Promise<HarvestOutcome> {
  const browser = await launchHeadlessChromium();
  const page = await browser.newPage();

  const collector = new NetworkCollector();
  collector.attach(page);

  await page.goto(url, { waitUntil: 'networkidle' });

  const scriptSources = await collectScriptSources(page);
  const snapshot = await captureDOMSnapshot(page, url);

  const requests: RecordedRequest[] = enrichRequestsWithRoutePatterns(
    collector.stop(page),
  );

  await browser.close();

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

/** Persists a harvest outcome to disk. */
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
}

/** Formats a harvest outcome into a summary stats string. */
function harvestSummary(outcome: HarvestOutcome): string {
  return [
    `Harvest complete for ${outcome.session.targetUrl}`,
    `- Requests captured: ${outcome.session.requests.length}`,
    `- Script sources: ${outcome.session.scripts.length}`,
    `- Unpacked bundles: ${outcome.bundles.length}`,
    `- Unpacked modules: ${outcome.bundles.reduce((n, b) => n + b.modules.length, 0)}`,
    `- A11y root role: ${outcome.snapshot.a11yTree.role}`,
    `- Design tokens: ${Object.keys(outcome.snapshot.tokens.colors).length} colors, ` +
      `${outcome.snapshot.tokens.fonts.length} fonts, ` +
      `${outcome.snapshot.tokens.spacing.length} spacing, ` +
      `${outcome.snapshot.tokens.radii.length} radii`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: 'apograph', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// ---------------------------------------------------------------------------
// Tool: apograph_crawl
// ---------------------------------------------------------------------------

server.tool(
  'apograph_crawl',
  'Headless crawl of a site from a root URL: dual-viewport screenshots, a11y trees, design tokens, and mirrored image assets, persisted as an evidence bundle under .apograph/evidence/.',
  {
    targetUrl: z.string().url(),
    evidenceDir: z.string().optional(),
    maxDepth: z.number().int().min(0).optional(),
    maxPages: z.number().int().min(1).optional(),
  },
  async ({ targetUrl, evidenceDir, maxDepth, maxPages }) => {
    const manifest = await crawlEvidence({
      rootUrl: targetUrl,
      evidenceDir: evidenceDir ?? '.apograph/evidence',
      maxDepth: maxDepth ?? 2,
      maxPages: maxPages ?? 10,
    });

    const lines = [
      `Crawled ${manifest.stats.pagesCrawled} page(s) from ${manifest.targetUrl} ` +
        `in ${manifest.stats.durationMs}ms`,
      `- Links discovered: ${manifest.stats.linksDiscovered}`,
      `- Assets: ${manifest.stats.assetsDownloaded} downloaded, ` +
        `${manifest.stats.assetsFailed} failed, ${manifest.stats.externalAssets} external`,
      `- Skipped URLs: ${manifest.diagnostics.skippedUrls.length}`,
      `- Failed navigations: ${manifest.diagnostics.failedNavigations.length}`,
      '',
      'Routes:',
      ...manifest.routes.map(
        (route) => `- ${route.path} "${route.title}" (${route.desktopScreenshot}, ${route.mobileScreenshot})`,
      ),
    ];

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

// ---------------------------------------------------------------------------
// Tool: apograph_clone
// ---------------------------------------------------------------------------

server.tool(
  'apograph_clone',
  'Autonomously launch a headless Chromium session, harvest network/DOM, infer schemas, and synthesize a self-hosted full-stack Docker repository.',
  {
    targetUrl: z.string().url(),
    outDir: z.string().optional(),
    verify: z.boolean().optional().default(true),
  },
  async ({ targetUrl, outDir, verify }) => {
    const outputDir = outDir ?? join('./output', appNameFromUrl(targetUrl));
    const appName = appNameFromUrl(targetUrl);

    const outcome = await runHarvest(targetUrl);
    await persistHarvest(outputDir, outcome);

    const clusters = clusterEndpoints(outcome.session.requests);
    const schemas = inferAllSchemas(outcome.session.requests, clusters);

    const [frontendFiles, backendFiles] = await Promise.all([
      synthesizeFrontend([outcome.snapshot], outcome.bundles),
      synthesizeBackend(schemas),
    ]);

    const { writtenFiles, projectDir } = await emitProject(
      [...frontendFiles, ...backendFiles],
      outputDir,
      appName,
    );

    const lines = [
      `Synthesized ${writtenFiles.length} files to ${projectDir}`,
      harvestSummary(outcome),
      `Endpoint clusters: ${clusters.length}; contracts inferred: ${schemas.length}`,
      'Written files:',
      ...writtenFiles.map((file) => `- ${file}`),
    ];

    if (verify) {
      const result = await verifyAndSelfHeal(outputDir, 2);
      lines.push(
        result.success
          ? `Self-healing verification PASSED after ${result.passesRun} pass(es); ` +
              `${result.repairedFiles.length} file(s) repaired.`
          : `Self-healing verification FAILED after ${result.passesRun} pass(es).`,
      );
    }

    lines.push('Boot the repository with `docker compose up`.');

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

// ---------------------------------------------------------------------------
// Tool: apograph_harvest
// ---------------------------------------------------------------------------

server.tool(
  'apograph_harvest',
  'Harvest network traffic, client scripts, and DOM accessibility tree for a target URL using headless Chromium.',
  {
    targetUrl: z.string().url(),
    outDir: z.string(),
  },
  async ({ targetUrl, outDir }) => {
    const outcome = await runHarvest(targetUrl);
    await persistHarvest(outDir, outcome);

    const lines = [
      harvestSummary(outcome),
      `Wrote session.json and snapshot.json to ${resolve(outDir)}`,
    ];

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

// ---------------------------------------------------------------------------
// Tool: apograph_infer_contracts
// ---------------------------------------------------------------------------

server.tool(
  'apograph_infer_contracts',
  'Read a harvested session from disk and deterministically deduce parameterized routes, Zod schemas, and SQLite tables.',
  {
    harvestDir: z.string(),
  },
  async ({ harvestDir }) => {
    const sessionPath = join(resolve(harvestDir), 'session.json');
    const session = JSON.parse(
      await readFile(sessionPath, 'utf8'),
    ) as HarvestedSession;

    const clusters = clusterEndpoints(session.requests);
    const schemas = inferAllSchemas(session.requests, clusters);

    const lines = [
      `Inferred contracts for ${session.targetUrl}`,
      `Endpoint clusters (${clusters.length}):`,
      ...clusters.map(
        (cluster) =>
          `- ${cluster.pattern} [${cluster.methods.join(', ')}] ` +
            `(${cluster.sampleUrls.length} sample URLs)`,
      ),
      '',
      'API contracts:',
      formatSchemasForPrompt(schemas),
    ];

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

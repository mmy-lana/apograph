/**
 * apograph — MCP server implementation (Layer 5: Agent Orchestrator).
 *
 * Exposes the apograph pipeline as Model Context Protocol tools so external
 * LLM agents can drive harvesting, contract inference, and full cleanroom
 * synthesis over stdio. This module is the single source of the tool set:
 * both the `apograph-mcp` bin (src/mcp.ts) and the `apograph mcp` CLI
 * subcommand start the same server (MCP-01).
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
} from '../types.js';
import { crawlEvidence } from '../crawler/engine.js';
import { getVersion } from '../version.js';
import { createPlanFromEvidence } from '../plan/generator.js';
import { synthesizeModularProject, copyMirroredAssets } from '../synthesizer/modular.js';
import { emitProject } from '../emitter/scaffold.js';
import { runVerification } from '../verifier/engine.js';

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

// ---------------------------------------------------------------------------
// MCP server (MCP-01: shared by the `apograph-mcp` bin and `apograph mcp`)
// ---------------------------------------------------------------------------

/** Builds the apograph MCP server with its full tool set (not yet connected). */
export function createApographServer(): McpServer {
  const server = new McpServer(
    { name: 'apograph', version: getVersion() },
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
  'Autonomously crawl a website, derive a plan, synthesize a standalone React 19 + Tailwind CSS frontend, and verify it.',
  {
    targetUrl: z.string().url(),
    outDir: z.string().optional(),
    maxPages: z.number().int().min(1).optional(),
    verify: z.boolean().optional().default(true),
  },
  async ({ targetUrl, outDir, maxPages, verify }) => {
    const outputDir = outDir ?? join('./output', appNameFromUrl(targetUrl));
    const evidenceDir = '.apograph/evidence';

    const manifest = await crawlEvidence({
      rootUrl: targetUrl,
      evidenceDir,
      maxPages: maxPages ?? 10,
    });

    const plan = createPlanFromEvidence(manifest);
    plan.approved = true;
    plan.approvedAt = new Date().toISOString();

    const result = await synthesizeModularProject({ plan, manifest, evidenceDir });

    const { writtenFiles, projectDir } = await emitProject(result.files, outputDir, plan.appName, {
      force: true,
      metadata: manifest.routes[0]?.metadata,
    });

    await copyMirroredAssets(join(evidenceDir, 'assets'), projectDir);

    const lines = [
      `Synthesized ${writtenFiles.length} files to ${projectDir}`,
      `Pages crawled: ${manifest.stats.pagesCrawled}`,
      `Stages via vision LLM: ${result.visionStages.length}, fallback: ${result.fallbackStages.length}`,
      'Written files:',
      ...writtenFiles.map((file) => `- ${file}`),
    ];

    if (verify) {
      const report = await runVerification({
        outputDir: projectDir,
        evidenceDir,
      });
      lines.push(
        report.overall.passed
          ? '3-tier verification PASSED (build, routes, visuals).'
          : '3-tier verification FAILED — see diagnostics below.',
      );
      for (const diagnostic of report.diagnostics) {
        lines.push(`- ${diagnostic}`);
      }
    }

    lines.push('Boot the frontend with `pnpm install && pnpm dev`.');

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

  return server;
}

/**
 * Builds the server, connects it over stdio, and resolves when the transport
 * closes. Lifecycle (MCP-02): the process exits cleanly when stdin ends or a
 * termination signal arrives — a spawned server must never orphan.
 */
export async function runMcpServer(): Promise<void> {
  const server = createApographServer();

  let closed = false;
  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    process.exit(0);
  };

  // End of stdin means the client is gone — exit 0 (spawned via stdio).
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

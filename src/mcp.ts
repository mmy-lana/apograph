#!/usr/bin/env node
/**
 * apograph — MCP server bin entry (Layer 5: Agent Orchestrator).
 *
 * Thin launcher: the tool set and lifecycle live in src/mcp/server.ts, which
 * is shared with the `apograph mcp` CLI subcommand (MCP-01).
 */

import { runMcpServer } from './mcp/server.js';

await runMcpServer();

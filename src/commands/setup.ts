/**
 * apograph — Agent setup (`apograph setup`).
 *
 * Detects installed AI coding agents (Claude Desktop, Cursor, Claude Code,
 * Windsurf, OpenCode), backs up their existing config with a timestamped
 * `.backup` copy, and injects the apograph MCP server definition.
 */

import { platform } from 'node:process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

/** The MCP server definition injected into agent configs. */
interface McpServerDefinition {
  command: string;
  args: string[];
}

/** One detected agent target with its config path and injection strategy. */
interface AgentTarget {
  key: string;
  name: string;
  configPath: string;
  /** Injects the apograph server entry into the parsed config object. */
  inject: (config: Record<string, unknown>, server: McpServerDefinition) => void;
}

/** Normalized OpenCode-style local server entry. */
interface OpenCodeMcpEntry {
  type: 'local';
  command: string[];
  enabled: boolean;
}

/** Reads a file, or returns null when it does not exist. */
async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Returns the absolute path of the built MCP server script. */
function mcpScriptPath(): string {
  return fileURLToPath(new URL('../mcp.js', import.meta.url));
}

/** Builds the apograph MCP server definition for this installation. */
function apographServerDefinition(): McpServerDefinition {
  return {
    command: process.execPath,
    args: [mcpScriptPath()],
  };
}

/** Ensures `config[key]` is a plain object and returns it. */
function ensureObject(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = config[key];
  if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const created: Record<string, unknown> = {};
  config[key] = created;
  return created;
}

/** Standard `mcpServers.apograph` injection (Claude/Cursor/Windsurf shape). */
function injectMcpServers(
  config: Record<string, unknown>,
  server: McpServerDefinition,
): void {
  const mcpServers = ensureObject(config, 'mcpServers');
  mcpServers.apograph = { command: server.command, args: server.args };
}

/** OpenCode injection: `mcp.apograph` with a local command array. */
function injectOpenCode(
  config: Record<string, unknown>,
  server: McpServerDefinition,
): void {
  const mcp = ensureObject(config, 'mcp');
  const entry: OpenCodeMcpEntry = {
    type: 'local',
    command: [server.command, ...server.args],
    enabled: true,
  };
  mcp.apograph = entry;
}

/** Claude Desktop config path per platform. */
function claudeDesktopPath(): string {
  if (platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Claude', 'claude_desktop_config.json');
  }
  return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
}

/** Cursor config path: global first, then the current project. */
async function cursorPath(): Promise<string> {
  const global = join(homedir(), '.cursor', 'mcp.json');
  if ((await readIfExists(global)) !== null) return global;
  return join(process.cwd(), '.cursor', 'mcp.json');
}

/** Discovers all installed agents that already have a config file. */
async function discoverAgents(): Promise<AgentTarget[]> {
  const server = apographServerDefinition();
  const candidates: AgentTarget[] = [
    {
      key: 'claude-desktop',
      name: 'Claude Desktop',
      configPath: claudeDesktopPath(),
      inject: injectMcpServers,
    },
    {
      key: 'cursor',
      name: 'Cursor',
      configPath: await cursorPath(),
      inject: injectMcpServers,
    },
    {
      key: 'claude-code',
      name: 'Claude Code',
      configPath: join(homedir(), '.claude.json'),
      inject: injectMcpServers,
    },
    {
      key: 'windsurf',
      name: 'Windsurf',
      configPath: join(homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
      inject: injectMcpServers,
    },
    {
      key: 'opencode',
      name: 'OpenCode',
      configPath: join(homedir(), '.config', 'opencode', 'opencode.json'),
      inject: injectOpenCode,
    },
  ];

  // `server` is captured per-target at injection time; rebind it here.
  const targets: AgentTarget[] = [];
  for (const candidate of candidates) {
    if ((await readIfExists(candidate.configPath)) === null) continue;
    targets.push({
      ...candidate,
      inject: (config) => candidate.inject(config, server),
    });
  }
  return targets;
}

/** Builds a timestamped backup path for a config file. */
function backupPath(configPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${configPath}.backup-${stamp}`;
}

/** Sanitizes a client option into a known agent key, or null. */
function normalizeClientKey(client: string): string | null {
  const normalized = client.toLowerCase().trim();
  const aliases: Record<string, string> = {
    'claude-desktop': 'claude-desktop',
    claudedesktop: 'claude-desktop',
    claude: 'claude-desktop',
    cursor: 'cursor',
    'claude-code': 'claude-code',
    claudecode: 'claude-code',
    'claude code': 'claude-code',
    windsurf: 'windsurf',
    opencode: 'opencode',
    'open-code': 'opencode',
  };
  return aliases[normalized] ?? null;
}

/** Installs the apograph MCP server into one agent config. */
async function setupAgent(target: AgentTarget, server: McpServerDefinition): Promise<void> {
  const original = await readIfExists(target.configPath);

  let config: Record<string, unknown>;
  if (original !== null) {
    const parsed: unknown = JSON.parse(original);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.warn(`✖ ${target.name}: config is not a JSON object — skipped (${target.configPath})`);
      return;
    }
    config = parsed as Record<string, unknown>;

    await writeFile(backupPath(target.configPath), original, 'utf8');
  } else {
    config = {};
  }

  target.inject(config, server);

  await mkdir(dirname(target.configPath), { recursive: true });
  await writeFile(target.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  if (original !== null) {
    console.log(`✓ ${target.name} configured (${target.configPath}) — backup saved.`);
  } else {
    console.log(`✓ ${target.name} configured (${target.configPath}).`);
  }
}

/**
 * Detects installed AI coding agents and injects the apograph MCP server
 * into their configs, backing up any existing config first. When
 * `options.client` is provided, only that agent is configured.
 */
export async function runSetup(options: { client?: string }): Promise<void> {
  const server = apographServerDefinition();

  let targets = await discoverAgents();

  if (options.client) {
    const key = normalizeClientKey(options.client);
    if (!key) {
      console.error(
        `✖ Unknown client "${options.client}". Supported: claude-desktop, cursor, claude-code, windsurf, opencode.`,
      );
      return;
    }
    const selected = targets.find((target) => target.key === key);
    if (!selected) {
      console.error(
        `✖ ${options.client} config not found. Open the agent once so it creates its config, then re-run \`apograph setup --client ${key}\`.`,
      );
      return;
    }
    targets = [selected];
  }

  if (targets.length === 0) {
    console.log('No AI coding agent configs were detected.');
    console.log('');
    console.log('Supported agents and their expected config locations:');
    console.log('  Claude Desktop  ~/Library/Application Support/Claude/claude_desktop_config.json (macOS)');
    console.log('  Cursor          ~/.cursor/mcp.json (or .cursor/mcp.json in your project)');
    console.log('  Claude Code     ~/.claude.json');
    console.log('  Windsurf        ~/.codeium/windsurf/mcp_config.json');
    console.log('  OpenCode        ~/.config/opencode/opencode.json');
    console.log('');
    console.log('Open your agent once so it creates its config file, then re-run `apograph setup`.');
    return;
  }

  console.log(`Injecting apograph MCP server (${server.command} ${server.args.join(' ')})...\n`);

  for (const target of targets) {
    try {
      await setupAgent(target, server);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      console.warn(`✖ ${target.name}: setup failed — ${reason}`);
    }
  }

  console.log('');
  console.log('✔ Done. Restart your agent to load the apograph MCP tools.');
}

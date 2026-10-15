/**
 * apograph — Agent setup (`apograph setup`).
 *
 * Detects installed AI coding agents (Claude Desktop, Cursor, Claude Code,
 * Windsurf, OpenCode), backs up their existing config with a timestamped
 * `.backup` copy, and injects the apograph MCP server definition.
 */

import { platform } from 'node:process';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

/** The MCP server definition injected into agent configs. */
export interface McpServerDefinition {
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
export function normalizeClientKey(client: string): string | null {
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
    dsh: 'dsh',
    'deepseek-harness': 'dsh',
    custom: 'custom',
  };
  return aliases[normalized] ?? null;
}

// ---------------------------------------------------------------------------
// DSH adapter (DSH-01)
// ---------------------------------------------------------------------------

/** The composition row registered with @deepseek-ai/dsh-mcp-client. */
export interface DshEntry {
  id: string;
  name: string;
  config: {
    serverName: string;
    transport: 'stdio';
    command: string;
    args: string[];
  };
}

/** Builds the mcp-apograph row: package-name launch, no absolute paths. */
export function dshEntryDefinition(): DshEntry {
  return {
    id: 'mcp-apograph',
    name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: 'apograph',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'apograph-agents', 'mcp'],
    },
  };
}

/**
 * Resolves the DSH home directory: `$DSH_HOME` when set, else `~/.dsh` when
 * it exists as a directory, else null (print-fallback territory).
 */
export function resolveDshHome(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string | null {
  if (env.DSH_HOME !== undefined && env.DSH_HOME.length > 0) return env.DSH_HOME;
  const fallback = join(home, '.dsh');
  return existsSync(fallback) ? fallback : null;
}

/** The apograph agent-preset composition file inside a DSH home. */
export function dshPresetPath(dshHome: string): string {
  return join(dshHome, '.agent-presets', 'apograph', 'cordis.yml');
}

/** Renders the DSH composition row as copy-pasteable JSON (valid YAML). */
export function renderDshPrintBlock(): string {
  return JSON.stringify([dshEntryDefinition()], null, 2);
}

/**
 * Result of a DSH setup attempt: wrote a fresh preset, found the entry
 * already present (idempotent no-op), or printed the fallback block.
 */
export type DshSetupResult = 'created' | 'unchanged' | 'printed';

/**
 * Registers apograph with DSH (DSH-01). Writes a dedicated agent-preset
 * composition file when the DSH home is locatable and does not yet contain
 * the entry; when an existing preset lacks the row, or no DSH home is
 * found, prints the copy-pasteable block instead of blind-merging YAML
 * (this project carries no YAML dependency).
 */
export async function runDshSetup(
  dshHome: string | null,
  log: (message: string) => void = console.log,
  errLog: (message: string) => void = console.error,
): Promise<DshSetupResult> {
  const entry = dshEntryDefinition();

  if (dshHome === null) {
    errLog('✖ No DSH home found (set $DSH_HOME or create ~/.dsh).');
    log('');
    log('Add this entry to your DSH composition (cordis.patch.yml or an agent');
    log('preset cordis.yml) to register the apograph MCP server:');
    log('');
    log(renderDshPrintBlock());
    log('');
    log("After a harness reload the tools appear as mcp__apograph__apograph_crawl and mcp__apograph__apograph_clone.");
    return 'printed';
  }

  const presetPath = dshPresetPath(dshHome);
  const existing = await readIfExists(presetPath);

  if (existing !== null) {
    if (existing.includes(entry.id)) {
      log(`✓ ${entry.id} already present in ${presetPath} — nothing to do.`);
      return 'unchanged';
    }
    // Existing preset without our row: never blind-merge YAML without a
    // parser — print the block for manual insertion.
    log(`✖ ${presetPath} exists but does not contain ${entry.id}.`);
    log('Add this entry to the file (JSON is valid YAML), then reload DSH:');
    log('');
    log(renderDshPrintBlock());
    return 'printed';
  }

  const body = [
    `# apograph MCP server — written by \`apograph setup --client dsh\`.`,
    `# Tools appear as mcp__apograph__apograph_crawl and mcp__apograph__apograph_clone`,
    `# after the harness reloads this composition.`,
    `- id: ${entry.id}`,
    `  name: '${entry.name}'`,
    `  config:`,
    `    serverName: ${entry.config.serverName}`,
    `    transport: ${entry.config.transport}`,
    `    command: ${entry.config.command}`,
    `    args:`,
    ...entry.config.args.map((arg) => `      - '${arg}'`),
    '',
  ].join('\n');

  try {
    await mkdir(dirname(presetPath), { recursive: true });
    await writeFile(presetPath, body, 'utf8');
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    errLog(`✖ Could not write ${presetPath} — ${reason}`);
    log('');
    log('Add this entry manually to your DSH composition (JSON is valid YAML):');
    log('');
    log(renderDshPrintBlock());
    return 'printed';
  }
  log(`✓ DSH agent preset written: ${presetPath}`);
  log('  Load the preset in your DSH session and reload to get mcp__apograph__* tools.');
  return 'created';
}

// ---------------------------------------------------------------------------
// Generic client writer (CLIENT-01): standard mcpServers JSON
// ---------------------------------------------------------------------------

/**
 * Portable MCP launch definition used by the dsh and custom writers: starts
 * the server through the published package name (PKG-01/PKG-02), so the
 * generated configuration carries no machine-specific absolute paths.
 */
export function portableServerDefinition(): McpServerDefinition {
  return { command: 'npx', args: ['-y', 'apograph-agents', 'mcp'] };
}

/** The standard `mcpServers` JSON block for clients without a dedicated adapter. */
export function renderMcpServersPrintBlock(): string {
  const server = portableServerDefinition();
  return JSON.stringify(
    { mcpServers: { apograph: { command: server.command, args: server.args } } },
    null,
    2,
  );
}

/** Outcome of a generic mcpServers JSON write. */
export type McpServersWriteResult = 'created' | 'updated' | 'unchanged';

/**
 * Writes (or merges) the standard `mcpServers.apograph` entry into a JSON
 * config file (CLIENT-01). Idempotent: an existing identical entry is left
 * untouched (no backup, no write). Existing keys — including other MCP
 * servers — are preserved. Invalid JSON aborts without modifying the file.
 */
export async function writeMcpServersConfig(
  configPath: string,
  server: McpServerDefinition,
  log: (message: string) => void = console.log,
): Promise<McpServersWriteResult> {
  const original = await readIfExists(configPath);
  const desired = { command: server.command, args: server.args };

  let config: Record<string, unknown>;
  if (original !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(original);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `${configPath} is not valid JSON (${reason}) — refusing to modify it. Fix or remove the file, then re-run.`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${configPath} is not a JSON object — refusing to modify it.`);
    }
    config = parsed as Record<string, unknown>;
  } else {
    config = {};
  }

  const mcpServers = ensureObject(config, 'mcpServers');
  const current = mcpServers.apograph;
  if (
    typeof current === 'object' &&
    current !== null &&
    JSON.stringify(current) === JSON.stringify(desired)
  ) {
    log(`✓ apograph MCP entry already present in ${configPath} — nothing to do.`);
    return 'unchanged';
  }

  if (original !== null) {
    await writeFile(backupPath(configPath), original, 'utf8');
  }
  mcpServers.apograph = desired;
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  log(
    original === null
      ? `✓ Created ${configPath} with the apograph MCP entry.`
      : `✓ Updated ${configPath} (backup saved) — apograph MCP entry added.`,
  );
  return original === null ? 'created' : 'updated';
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
 * `options.client` is provided, only that agent is configured. `dsh` and
 * `custom` are handled before file discovery because both work without a
 * pre-existing config file.
 */
export async function runSetup(options: {
  client?: string;
  configPath?: string;
}): Promise<void> {
  const server = apographServerDefinition();

  if (options.client !== undefined) {
    const key = normalizeClientKey(options.client);
    if (key === 'dsh') {
      await runDshSetup(resolveDshHome());
      return;
    }
    if (key === 'custom') {
      if (options.configPath !== undefined && options.configPath.length > 0) {
        await writeMcpServersConfig(options.configPath, portableServerDefinition());
      } else {
        console.log(
          'Add this standard mcpServers JSON to your client\'s MCP configuration:',
        );
        console.log('');
        console.log(renderMcpServersPrintBlock());
        console.log('');
        console.log(
          "Or write it directly: apograph setup --client custom --config-path <path-to-config.json>",
        );
      }
      return;
    }
    if (!key) {
      console.error(
        `✖ Unknown client "${options.client}". Supported: claude-desktop, cursor, claude-code, windsurf, opencode, dsh, custom.`,
      );
      return;
    }
    const selected = (await discoverAgents()).find((target) => target.key === key);
    if (!selected) {
      console.error(
        `✖ ${options.client} config not found. Open the agent once so it creates its config, then re-run \`apograph setup --client ${key}\`.`,
      );
      return;
    }
    try {
      await setupAgent(selected, server);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      console.warn(`✖ ${selected.name}: setup failed — ${reason}`);
    }
    console.log('');
    console.log('✔ Done. Restart your agent to load the apograph MCP tools.');
    return;
  }

  let targets = await discoverAgents();

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
    console.log('Additional options that work without a pre-existing config:');
    console.log('  DSH             apograph setup --client dsh (agent preset or printed entry)');
    console.log('  Custom          apograph setup --client custom [--config-path <file>] (mcpServers JSON)');
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

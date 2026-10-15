# Apograph MCP Client Compatibility Matrix

Authoritative as of this phase. Evidence: `src/commands/setup.ts` (adapter code, unit-tested), `src/mcp/server.ts` (tool contracts), `src/config/models.ts` (provider env vars), observed CLI behavior. Items verified only by unit tests are labeled; the live DSH reload is still pending (Gate C).

**Server entry points (verified):**
- `apograph mcp` (alias `serve`) / bin `apograph-mcp` — stdio MCP server, tools `apograph_crawl` + `apograph_clone`, `serverInfo.version` = package version.
- Portable launch (recommended in every generated or pasted config): `command: npx, args: ["-y", "apograph-agents", "mcp"]`.

---

## Tier 1 — Automated Adapters

`apograph setup --client <name>` writes the config (with a `.backup-<timestamp>` of any existing file) or prints the block when the target cannot be written. All adapters are thin configuration layers over the single shared MCP server — there is exactly one server implementation.

### `dsh` (DeepSeek Harness)
- **Config location**: `$DSH_HOME` or `~/.dsh` → agent preset `<dsh-home>/.agent-presets/apograph/cordis.yml` (created by the adapter).
- **Injected schema** (composition row; JSON is valid YAML):
  ```json
  [
    {
      "id": "mcp-apograph",
      "name": "@deepseek-ai/dsh-mcp-client",
      "config": {
        "serverName": "apograph",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "apograph-agents", "mcp"]
      }
    }
  ]
  ```
- **Reload**: load/keep the `apograph` agent preset in the DSH session and reload the harness. Tools appear as `mcp__apograph__apograph_crawl` and `mcp__apograph__apograph_clone`.
- **Fallbacks** (all tested): no DSH home → printed block; existing preset without the row → printed block (never blind-merged); write failure → printed block.
- **Known limitations**:
  - *Live reload not yet verified* — writer output is unit-tested (15+ tests) but an end-to-end DSH reload (DSH-02/Gate C) has not been executed. Do not treat this row as field-verified until then.
  - DSH bridges **tools only** (no MCP resources/prompts); a startup failure leaves no tools; per-call timeout default 60 s (a long crawl/clone may need the `toolCallTimeoutMs` field raised in the row).
  - The server runs in the cwd DSH spawns it in — evidence bundles and output land there.

### `cursor`
- **Config location**: `~/.cursor/mcp.json` (global) if it exists, else `./.cursor/mcp.json` (project).
- **Injected schema**: `mcpServers.apograph = { command: <node>, args: [<abs path to dist/mcp.js>] }`.
- **Reload**: restart Cursor.
- **Known limitations**: requires the config file to already exist (open Cursor once first); project-level fallback depends on the cwd where setup runs.

### `claude-desktop`
- **Config location**: macOS `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows `%APPDATA%\Claude\claude_desktop_config.json`.
- **Injected schema**: `mcpServers.apograph = { command, args }` (same shape as Cursor).
- **Reload**: fully quit and restart Claude Desktop.
- **Known limitations**: config must exist first; Linux is not mapped (no official Claude Desktop path).

### `claude-code`
- **Config location**: `~/.claude.json`.
- **Injected schema**: `mcpServers.apograph = { command, args }`.
- **Reload**: start a new Claude Code session.
- **Known limitations**: `~/.claude.json` is a large state file — setup rewrites it as formatted JSON (backup is taken); comments/ordering of unrelated keys are not preserved beyond JSON round-tripping.

### `windsurf`
- **Config location**: `~/.codeium/windsurf/mcp_config.json`.
- **Injected schema**: `mcpServers.apograph = { command, args }`.
- **Reload**: restart Windsurf.
- **Known limitations**: config must exist first.

### `opencode`
- **Config location**: `~/.config/opencode/opencode.json`.
- **Injected schema** (OpenCode's local-server shape, not `mcpServers`):
  ```json
  { "mcp": { "apograph": { "type": "local", "command": ["<node>", "<abs dist/mcp.js>"], "enabled": true } } }
  ```
- **Reload**: restart OpenCode.
- **Known limitations**: config must exist first; the command array embeds absolute paths from the machine that ran setup.

---

## Tier 2 — Universal Generic Path (`--client custom`)

For Zed, Continue.dev, VS Code / Cline, and any other MCP client that supports **stdio** MCP servers. No filesystem adapter is written for them (per CLIENT-02: no brittle per-client adapters without verified demand).

**Print the block:**
```bash
apograph setup --client custom
```
**Write/merge it directly** (creates the file if missing; preserves unrelated keys; aborts on invalid JSON; backs up before modifying):
```bash
apograph setup --client custom --config-path /path/to/clients-mcp-config.json
```

**Exact copy-pasteable block:**
```json
{
  "mcpServers": {
    "apograph": {
      "command": "npx",
      "args": ["-y", "apograph-agents", "mcp"]
    }
  }
}
```

**Per-client notes (verify against your client's current docs — these shapes change between client versions):**
- **Zed**: `~/.zed/settings.json` → `context_servers` (Zed's own shape; the block above is the MCP-server row to adapt).
- **Continue.dev**: `~/.continue/config.yaml` (experimental `mcpServers` list) — YAML, adapt the same command/args.
- **VS Code / Cline**: `cline_mcp_settings.json` → standard `mcpServers` object — the block above can usually be pasted as-is.
- **Anything else**: any client that can spawn `command + args` over stdio and speak MCP works.

**Environment variable handling** (provider settings are independent of the client — MODEL-01; verified in `src/config/models.ts`):
- The MCP server process inherits env from the client that spawns it.
- `APOGRAPH_BASE_URL` + `APOGRAPH_API_KEY` → custom OpenAI-compatible gateway (highest precedence).
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` → respective cloud providers.
- `APOGRAPH_MODEL` → model id override for the active provider.
- If no env vars are set, `~/.apograph/config.json` (written by `apograph config`) applies. Env always wins.
- To pass provider credentials through a client, add an `env` object next to `command`/`args` in the client's config if it supports one; otherwise export the variables in the client's launch environment. API keys are never written by `apograph setup`.

---

## Verification status summary

| Client | Adapter | Writer unit-tested | Injected payload tested | Live end-to-end |
|---|---|---|---|---|
| dsh | yes | yes (create/idempotent/print-fallbacks) | yes (entry JSON round-trip) | **pending (Gate C)** |
| cursor / claude-desktop / claude-code / windsurf / opencode | yes (unchanged since Phase 00) | via shared writer tests | shape tested (`node` + `mcp.js`) | not re-executed (code unchanged) |
| custom | yes | yes (create/merge/idempotent/abort-on-corrupt) | yes (JSON shape + `runSetup` write path) | n/a (generic) |
| unknown names | n/a | yes (actionable `--client custom` guidance, zero writes) | — | n/a |

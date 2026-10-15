# Apograph SDD — Phase 00 Audit

Date: 2026-10-15 (session). Repository: `git@github.com:mmy-lana/apograph` (checked out clean at `/Users/hikari/lana/apograph`, branch `main` @ `2bf15a7`, tag `v0.1.1`, no local modifications). All claims below were verified against source files, the local build, or the npm registry unless marked **[inference]**.

## 1. Verified repository facts

| Aspect | Fact | Evidence |
|---|---|---|
| Package name | `apograph-agents` | `package.json:2` |
| Package version | `0.1.1` | `package.json:3` |
| License / type | MIT, `"type": "module"` | `package.json:5-6` |
| bin (3 executables, same package) | `apograph-agents` → `dist/cli.js`, `apograph` → `dist/cli.js`, `apograph-mcp` → `dist/mcp.js` | `package.json:33-37` |
| Published npm | `apograph-agents` versions `0.0.0-stage`, `0.1.0`, `0.1.1` (latest `0.1.1`, published 2026-10-14); registry bin identical to manifest | `registry.npmjs.org/apograph-agents` |
| npm `apograph` | **404 — package does not exist** | `curl https://registry.npmjs.org/apograph` → 404 |
| npm `apograph-mcp` | **404 — package does not exist** | `curl https://registry.npmjs.org/apograph-mcp` → 404 |
| `files` | `dist`, `README.md`, `LICENSE` | `package.json:28-32` |
| `exports` | Not defined (no subpath exports) | `package.json` (absent) |
| engines | `node >= 20` (no `packageManager` field) | `package.json:38-40` |
| Lockfile | `pnpm-lock.yaml` v9.0 (1151 lines) | `pnpm-lock.yaml:1` |
| Workspace | `pnpm-workspace.yaml` contains only `allowBuilds` (build approvals for unrelated native deps); no `packages:` list — effectively a single-package repo | `pnpm-workspace.yaml` |
| Scripts | `typecheck` = `tsc --noEmit`; `build` = `tsc`; `bump:*` = `pnpm typecheck && pnpm build && npm version <bump>` (mixes npm into a pnpm repo) | `package.json:41-47` |
| Tests | **None.** No test script, no test framework in devDependencies, no test files in `src/` | `package.json`, `find src` |
| CI / release workflow | **None.** No `.github/` directory | `ls -a .github` → absent |
| CLI framework | commander ^13.1.0; program name `apograph`, `.version('0.1.0')` **hardcoded** (drifts from package 0.1.1) | `src/cli.ts:510-515` |
| CLI commands | `plan`, `crawl`, `clone`, `resume`, `synthesize`, `verify`, `status`, `config`, `doctor`, `setup` — there is **no `mcp`/`serve` subcommand** | `src/cli.ts:517-772` |
| MCP server | `McpServer` name `'apograph'`, version `'0.1.0'` **hardcoded**; `StdioServerTransport`; top-level `await server.connect(transport)`; no shutdown/error handlers | `src/mcp.ts:44-47,158-159` |
| MCP tools (2) | `apograph_crawl` (targetUrl, evidenceDir?, maxDepth?, maxPages? — no viewport/scope), `apograph_clone` (targetUrl, outDir?, maxPages?, verify? — no viewport/scope/evidenceDir) | `src/mcp.ts:53-152` |
| Input validation | Zod schemas per tool | `src/mcp.ts:56-61,96-100` |
| Setup clients (5) | `claude-desktop`, `cursor`, `claude-code`, `windsurf`, `opencode` + alias map in `normalizeClientKey`; **no `dsh`, no generic/custom client** | `src/commands/setup.ts:164-179` |
| Setup mechanics | Detects agents by pre-existing config file; timestamped `.backup-*`; injects `mcpServers.apograph` (Claude/Cursor/Windsurf/`.claude.json`) or `mcp.apograph` (OpenCode `{type:'local', command:[...], enabled}`); server def = `process.execPath` + abs `dist/mcp.js` path | `src/commands/setup.ts:110-209` |
| Provider config | Resolution: gateway (`APOGRAPH_BASE_URL`+`APOGRAPH_API_KEY`) > anthropic (`ANTHROPIC_API_KEY`) > openai (`OPENAI_API_KEY`) > local Ollama `http://localhost:11434/v1`. `APOGRAPH_MODEL` overrides model id everywhere. Persisted `~/.apograph/config.json` (providers `ollama|openai|anthropic|gateway`) read once at module load; env always wins | `src/config/models.ts:42-67`, `src/commands/config.ts:17-41` |
| Structured output | `generateObject` with fallback to `generateText` + fenced/bare JSON extraction when the provider rejects `json_schema` (status 400 / known error strings) | `src/synthesizer/llm.ts:58-74,118+` |
| Vision | Multimodal image parts (`ImagePart`) via `buildPromptParts`; deterministic fallback templates when no vision model reachable | `src/synthesizer/llm.ts:34-47`, `src/synthesizer/vision.ts` |
| Doctor | Checks Node ≥ 20, Playwright Chromium launch, 1-token LLM probe, Ollama `/api/tags` | `src/commands/doctor.ts:15-60` |
| Model roles | `getSynthesizerModel()` and `getFastParserModel()` both return `getModel()` — no separate fast/synth split | `src/config/models.ts:127-134` |

**DSH (DeepSeek Harness) MCP surface — verified against the running harness install:**
- DSH consumes MCP servers via the `@deepseek-ai/dsh-mcp-client` Cordis plugin (present at `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-mcp-client`, v0.1.2-rc.1, MCP SDK `^1.12.0` — same major as apograph's `^1.12.0`).
- Registration is one composition entry per server, in a profile's `cordis.patch.yml` (or an agent preset's `cordis.yml`):

```yaml
- id: mcp-apograph
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: apograph
    transport: stdio
    command: npx
    args: ['-y', 'apograph-agents', ...]
```
- Tools surface as `mcp__<serverName>__<tool>`. Only tools are bridged (no MCP resources/prompts).
- Active profile: `~/.dsh/profiles/web/` (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, one session plugin; `cordis.patch.yml` currently empty). Agent presets live under `${DSH_HOME:-~/.dsh}/.agent-presets/<id>/`.

## 2. Actual names vs executable names

- Package **name**: `apograph-agents` (the only thing `npx`/`npm install` can resolve).
- Executables **after installation**: `apograph`, `apograph-agents`, `apograph-mcp` (all shipped by that one package).
- `npx apograph …` fails E404 because npx resolves the **package** `apograph`, which was never published. `npx apograph-mcp` fails the same way. This fully explains the observed E404.
- Reproduced locally: `node dist/cli.js setup --client dsh` → `✖ Unknown client "dsh". Supported: claude-desktop, cursor, claude-code, windsurf, opencode.` — byte-for-byte the user's reported log; caused by the alias map in `src/commands/setup.ts:164-179`.

## 3. Current MCP and provider architecture

- **MCP**: single stdio server (`dist/mcp.js`) exposing 2 of the CLI's ~10 capabilities (`apograph_crawl`, `apograph_clone`). No way to start the MCP server through `npx <package-name>` because the package's default-named bin (`apograph-agents`) is the CLI, and there is no `apograph mcp` subcommand. `apograph setup` writes absolute `dist/mcp.js` paths into other clients' configs, which only works when setup runs from an installed copy (not via `npx`, where the path points into a transient npx cache).
- **Providers**: OpenAI-compatible gateway, Anthropic, OpenAI, and local Ollama, via Vercel AI SDK v4 (`ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`). Model id is provider-generic (`APOGRAPH_MODEL` / config `model` applies to whichever provider is active — e.g. it can override the Anthropic default with a non-Anthropic id). Config file stores the API key in plaintext at `~/.apograph/config.json`.

## 4. Build/test commands — observed results

| Command | Result |
|---|---|
| `pnpm typecheck` | **Failed in this environment** before running tsc: pnpm 11.22.0 (corepack) aborted its dependency-status check with `[ERR_SQLITE_ERROR] unable to open database file` — an environment/pnpm-store problem, not a repository defect. |
| `./node_modules/.bin/tsc --noEmit` | **Passed** (exit 0, no diagnostics). `pnpm typecheck` is therefore a faithful proxy; the failure is pnpm-internal. |
| `node dist/cli.js --version` | Prints `0.1.0` (stale vs package 0.1.1). `dist/` is local build output — **gitignored** (`.gitignore:6`), 0 tracked files — and currently current with `src/`. |
| `node dist/cli.js setup --client dsh` | Reproduced the user's exact error (§2). |
| Tests | **Nothing to run** — no test script, framework, or test files exist. No claim of passing tests is possible. |

## 5. README discrepancies (GitHub README = published npm README, identical content)

Verified by diffing the repo `README.md` against `https://unpkg.com/apograph-agents@0.1.1/README.md` — same file.

1. **Installation commands are broken**: Quickstart and agent section use `npx apograph clone|setup|doctor` (README:22,33,47). Every one of these returns E404. Only `npx apograph-agents …` works today.
2. **Version claim drift**: README says "Apograph (v0.1.0)" (README:10) while the published package is 0.1.1; the CLI also self-reports 0.1.0.
3. **Missing commands in CLI table**: `resume` and `status` exist in `src/cli.ts` but are absent from the README CLI Reference (README:99-108).
4. **Client list**: README claims "any MCP-capable agent (Claude Desktop, Cursor, Claude Code, Windsurf, OpenCode)" (README:143); the actual client list matches, but there is no documented way to configure any other MCP client (no generic mode), and DSH is not mentioned.
5. **MCP parity claim**: README presents the two MCP tools as "the pipeline" for agents; CLI features (plan approval, checkpoint/resume, scope/viewport control, synthesize/verify separately) are not exposed over MCP — parity is aspirational, also acknowledged in ROADMAP v1.0.0.
6. **Ollama model instructions**: README:186-202 instructs `ollama pull qwen3.5:9b` — the existence/validity of that exact Ollama tag was **not verified** (needs a live Ollama registry check; flagged as unknown).

## 6. Reasonable inferences (clearly labeled)

- The `apograph` and `apograph-mcp` bins exist in `package.json` **[inference]** so that globally/locally *installed* users get short command names; the author likely did not realize npx resolves package names, not bin names.
- `dist/` is **gitignored** (`.gitignore:6`, zero tracked files) — the published npm tarball is the only distributed build. **[inference]** This means `apograph setup`'s absolute `dist/mcp.js` path injection only works from a built copy (git clone + `pnpm build`, or an installed package); it silently writes a dangling path when run via `npx` from the npx cache, and would write nothing useful from a fresh clone without a build.
- Publishing is manual (`npm publish` with `bump:*` scripts that run `npm version`); no automation. **[inference from absence of CI]**

## 7. Unknowns (evidence still missing)

| Unknown | Evidence needed |
|---|---|
| Whether the Ollama tag `qwen3.5:9b` exists as instructed in the README | Query the Ollama model library (ollama.com/library) for the exact tag |
| How DSH users are *expected* to add an MCP server: editing `~/.dsh/profiles/web/cordis.patch.yml` vs authoring an agent preset under `~/.dsh/.agent-presets/<id>/cordis.yml` | DSH user docs (deployment `docs/user/guide/`); not present in the local install beyond the dsh-mcp-client README |
| Whether `npx -y apograph-agents <bin>`-style multi-bin invocation (e.g. `npx -y -p apograph-agents apograph-mcp`) is acceptable UX for DSH integration | Phase 01 design decision + a live test in DSH |
| Exact intended "top ten clients" list beyond the 5 supported + dsh | Product decision — no repository evidence |

## 8. Stop condition

Phase 00 complete: audit documents written, no application code, dependencies, lockfile, or package metadata modified. Changed files are listed in the phase summary. Awaiting review before Phase 01.

# Apograph — Cleanroom Reverse Engineering & Synthesis for Coding Agents

[![npm version](https://img.shields.io/npm/v/apograph.svg)](https://www.npmjs.com/package/apograph)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org/)

> **Turn any web application into a self-hosted, full-stack Docker clone with your coding agent.**

Apograph attaches to your *authenticated* Chrome session, harvests everything the app actually does — network traffic, WebSocket frames, accessibility tree, design tokens, and the original bundled JavaScript — then deterministically infers API contracts and has your LLM synthesize a complete, self-hosted replacement: React frontend, Hono + SQLite backend, and a `docker-compose.yml` to boot it all.

No scraping guesswork. No prompt archaeology. Just the app, faithfully reconstructed.

---

## Quickstart

### 1. Point your coding agent at Apograph

```bash
npx apograph setup --client cursor
```

Then restart your agent and paste this prompt:

```text
Use the apograph MCP tools. Clone https://app.example.com into a self-hosted
full-stack repository: harvest the session over CDP, infer the API contracts,
synthesize the React frontend and Hono backend, emit the Docker project, and
run the smoke verification until it passes.
```

### 2. Or drive it straight from the terminal

```bash
# Launch Chrome with remote debugging
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# One command: harvest → infer → synthesize → emit → verify
npx apograph clone https://app.example.com

# Boot the clone
cd output/app-example-com && docker compose up
```

### 3. Verify your environment first (optional)

```bash
npx apograph doctor
```

---

## Before Apograph vs With Apograph

| | Without Apograph | With Apograph |
|---|---|---|
| **API discovery** | DevTools spelunking, guessing at payload shapes | Clusters observed URLs into parameterized routes automatically |
| **Schemas** | Hand-written from a few samples | Zod request/response schemas inferred from every observed payload, with optional-key detection |
| **Design system** | Eyeballing screenshots | A11y tree + extracted color/font/spacing/radius tokens drive the Tailwind config |
| **Component names** | `Component1`, `Foo` | Authentic names recovered from unpacked webpack bundles |
| **Database** | Guessing at tables | Drizzle SQLite schema generated from array-returning GET contracts |
| **Verification** | "Looks right" | `tsc --noEmit` smoke check with LLM self-healing repair passes |
| **Deployment** | Ad-hoc scripts | Deterministic `docker-compose.yml`, scaffolds, and README |
| **Agent integration** | Copy-pasting context into chats | Native MCP tools the agent calls directly |

---

## How It Works

Apograph is a five-layer cleanroom pipeline — capture happens on the *live* app, and synthesis happens entirely offline from the harvested artifacts.

```
┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 1 — CAPTURE                                                  │
│  Playwright CDP attach → NetworkCollector (requests, filtering)      │
│  → script sources → DOM snapshot (a11y tree + design tokens)        │
├─────────────────────────────────────────────────────────────────────┤
│  LAYER 2 — RECONSTRUCTION                                           │
│  webcrack unpacking (webpack/browserify modules)                     │
│  → identifier de-obfuscation → authentic component export names     │
├─────────────────────────────────────────────────────────────────────┤
│  LAYER 3 — CONTRACT INFERENCE                                       │
│  URL clustering → parameterized routes (:id, :uuid, :hash, :slug)    │
│  → Zod schema inference → Drizzle SQLite table generation           │
├─────────────────────────────────────────────────────────────────────┤
│  LAYER 4 — UI & DESIGN SYSTEM                                       │
│  Chrome A11y tree extraction → CSSTree design-token extraction      │
│  → deterministic Tailwind config (colors, fonts, spacing, radii)    │
├─────────────────────────────────────────────────────────────────────┤
│  LAYER 5 — SYNTHESIS & ORCHESTRATION                                │
│  Vercel AI SDK (Ollama / OpenAI / Anthropic / custom gateway)        │
│  → React 19 frontend + Hono backend → project emission              │
│  → tsc smoke verification with LLM self-healing → MCP server        │
└─────────────────────────────────────────────────────────────────────┘
```

**Cleanroom discipline:** the LLM never sees the original app's proprietary source. It receives *derived artifacts* — accessibility trees, design tokens, inferred contracts, and recovered module export names — and synthesizes fresh code from those specifications.

---

## CLI Reference

```text
apograph <command> [options]
```

| Command | Description |
|---|---|
| `apograph clone <url>` | Full pipeline: harvest → decompile → infer → synthesize → emit → verify |
| `apograph harvest <url>` | Capture only; writes `session.json`, `snapshot.json`, and unpacked scripts |
| `apograph synthesize <dir>` | Rebuild a project from a previous harvest directory |
| `apograph doctor` | Environment health check: Node.js, Chrome CDP, LLM connectivity, Ollama |
| `apograph setup` | Install the apograph MCP server into your AI coding agent |

### `apograph clone`

```text
Usage: apograph clone [options] <url>

Options:
  -p, --port <number>   Chrome CDP port (default: "9222")
  -o, --out <dir>       output directory (defaults to ./output/<hostname>)
  --no-verify           skip smoke verification and self-healing
  --passes <number>     max self-healing repair passes (default: "2")
```

### `apograph harvest`

```text
Usage: apograph harvest [options] <url>

Options:
  -p, --port <number>   Chrome CDP port (default: "9222")
  -o, --out <dir>       output directory (defaults to ./output/<hostname>)
```

### `apograph synthesize`

```text
Usage: apograph synthesize [options] <dir>

Options:
  -o, --out <dir>       output directory (defaults to <dir>/app)
  --no-verify           skip smoke verification and self-healing
  --passes <number>     max self-healing repair passes (default: "2")
```

### `apograph doctor`

Checks Node.js ≥ 20, Chrome CDP on `localhost:9222`, LLM connectivity (a 1-token probe through the resolved provider), and local Ollama — printing `[PASS]`/`[WARN]` with exact fix commands for every failure.

### `apograph setup`

```text
Usage: apograph setup [options]

Options:
  -c, --client <name>   only configure a specific agent
                        (claude-desktop, cursor, claude-code, windsurf, opencode)
```

Detects installed agents, saves a timestamped `.backup` of each existing config, and injects the apograph MCP server definition. Detected locations:

| Agent | Config location |
|---|---|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), `%APPDATA%\Claude` (Windows) |
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json` in your project |
| Claude Code | `~/.claude.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| OpenCode | `~/.config/opencode/opencode.json` |

---

## MCP Tool Reference

Apograph ships as a [Model Context Protocol](https://modelcontextprotocol.io) server, so any MCP-capable agent (Claude Desktop, Cursor, Claude Code, Windsurf, OpenCode) can drive the pipeline autonomously.

### `apograph_clone`

> Autonomously attach to an authenticated browser session, harvest network/DOM, infer schemas, and synthesize a self-hosted full-stack Docker repository.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `targetUrl` | `string (url)` | — | The application to clone |
| `outDir` | `string` | `./output/<hostname>` | Output directory |
| `cdpPort` | `integer` | `9222` | Chrome CDP port |
| `verify` | `boolean` | `true` | Run smoke verification and self-healing |

### `apograph_harvest`

> Harvest network traffic, client scripts, and DOM accessibility tree for a target URL over CDP.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `targetUrl` | `string (url)` | — | The application to harvest |
| `outDir` | `string` | — | Where to write `session.json` / `snapshot.json` |
| `cdpPort` | `integer` | `9222` | Chrome CDP port |

### `apograph_infer_contracts`

> Read a harvested session from disk and deterministically deduce parameterized routes, Zod schemas, and SQLite tables.

| Parameter | Type | Description |
|---|---|---|
| `harvestDir` | `string` | Directory containing a prior `session.json` |

---

## LLM Configuration

Apograph resolves its synthesis model with zero configuration by default:

| Priority | Condition | Model |
|---|---|---|
| 1 | `APOGRAPH_BASE_URL` + `APOGRAPH_API_KEY` set | Custom gateway / proxy (OpenAI-compatible) |
| 2 | `ANTHROPIC_API_KEY` set | `claude-3-7-sonnet-latest` |
| 3 | `OPENAI_API_KEY` set | `gpt-4o` |
| 4 | Nothing set | Local Ollama (`qwen2.5-coder:7b-instruct` at `http://localhost:11434/v1`) |

Structured output (`generateObject`) is used when the model supports it, with an automatic `generateText` + JSON-extraction fallback for local SLMs and proxies.

## Requirements

- **Node.js ≥ 20**
- **Chrome** launched with `--remote-debugging-port=9222` (for capture)
- **An LLM** — a cloud API key or a local Ollama install
- **Docker** (optional, to boot the emitted `docker-compose.yml`)

## License

[MIT](LICENSE)

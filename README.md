# Apograph — Cleanroom Website Recreation Engine for Coding Agents

[![npm version](https://img.shields.io/npm/v/apograph-agents.svg)](https://www.npmjs.com/package/apograph-agents)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org/)

> **Turn any website into a standalone, verified React project with your coding agent.**

Apograph (v0.1.1) is a four-phase cleanroom engine: it crawls a site headlessly across multiple pages, derives a schema-validated plan you approve interactively, synthesizes a fresh React 19 + Tailwind CSS v4 frontend with a multimodal vision LLM, and proves the result with a 3-tier verification pipeline — build, route smoke checks, and pixel-diff visual comparison against the original screenshots.

> **Package note:** the published npm package is **`apograph-agents`**. Its executables are `apograph-agents`, `apograph`, and `apograph-mcp`. When running without installing, use the package name: `npx apograph-agents <command>` (`npx apograph <command>` fails with E404 because `apograph` is a bin name, not the package name).

No scraping guesswork. No prompt archaeology. No proprietary source — the LLM only ever sees derived artifacts: screenshots, accessibility trees, design tokens, and an approved plan.

---

## Quickstart

### 1. Drive it straight from the terminal

```bash
# One command: crawl → plan approval → vision synthesis → emit → verify
npx apograph-agents clone https://example.com

# Boot the recreation
cd output/example-com && pnpm install && pnpm dev
```

Or install globally so the short `apograph` command is on your PATH:

```bash
npm i -g apograph-agents
apograph clone https://example.com
```

Apograph launches its own **headless Chromium** — there is nothing to configure, no browser to launch, and no debugging port to expose.

### 2. Or point your coding agent at Apograph

```bash
npx apograph-agents setup --client cursor
```

Then restart your agent and paste this prompt:

```text
Use the apograph MCP tools. Clone https://example.com: crawl the site, derive
the plan, synthesize the standalone React frontend, and run verification
until it passes.
```

### 3. Verify your environment first (optional)

```bash
npx apograph-agents doctor
```

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────────┐
│  PHASE 1 — HEADLESS EVIDENCE CRAWL                                  │
│  playwright.chromium.launch({ headless: true }) — no CDP attach     │
│  → multi-page same-origin crawl (depth 2, ≤10 pages, prioritized    │
│    navigation links: /about, /pricing, /features, /contact, /faq)   │
│  → dual-viewport screenshots (desktop 1280×800, mobile 390×844)     │
│  → a11y trees + CSSTree design tokens (colors/fonts/spacing/radii)  │
│  → SEO & OpenGraph metadata (title, description, favicon, og:*)     │
│  → asset mirroring + .apograph/evidence/manifest.json               │
├─────────────────────────────────────────────────────────────────────┤
│  PHASE 2 — SCHEMA-VALIDATED PLAN APPROVAL                           │
│  Zod-typed apograph-plan.json (target, routes, design system,       │
│  assumptions, unknowns) → interactive @clack approval gate:         │
│  route checklist, design-token summary, external file editing       │
│  with re-validation, final confirmation. Nothing synthesizes        │
│  until approved: true.                                              │
├─────────────────────────────────────────────────────────────────────┤
│  PHASE 3 — MULTIMODAL VISION SYNTHESIS                              │
│  4 stages: design tokens → deterministic Tailwind v4 @theme CSS     │
│  → shared layout (sticky-blur Navbar with mobile drawer + Footer)   │
│  → route pages (tabs, accordions, validated forms with mock         │
│  localStorage persistence) → React Router v7 assembly               │
│  Vercel AI SDK image prompts: desktop+mobile screenshots, a11y      │
│  tree, and tokens per page; deterministic fallbacks when no         │
│  vision model is reachable.                                         │
├─────────────────────────────────────────────────────────────────────┤
│  PHASE 4 — 3-TIER VERIFICATION                                      │
│  Tier 1: tsc --noEmit + vite build (auto-installs deps if missing)  │
│  Tier 2: headless route smoke — HTTP status, DOM mount, console     │
│          errors, page exceptions on an ephemeral static server      │
│  Tier 3: pixelmatch + pngjs visual diff per viewport against the    │
│          evidence screenshots (configurable threshold, default 15%) │
│  → verification-report.json + diff PNGs + terminal summary          │
└─────────────────────────────────────────────────────────────────────┘
```

**Cleanroom discipline:** the LLM never sees the original app's proprietary source. It receives derived artifacts — screenshots, accessibility trees, design tokens, and the approved plan — and synthesizes fresh, standalone code from those specifications.

The emitted project is a **pure frontend**: React 19.3 + Vite + React Router v7 + Tailwind CSS 4.3 + lucide-react, with mirrored reference assets under `public/assets/` and the original SEO metadata in `index.html`.

---

## CLI Reference

| Command | Description |
|---|---|
| `apograph crawl <url>` | Headless evidence crawl: screenshots, a11y trees, tokens, SEO metadata, mirrored assets |
| `apograph plan [dir]` | Derive the plan from evidence and approve it interactively (`--yes` to auto-approve) |
| `apograph clone <url>` | Full pipeline: crawl → plan (approval gate) → modular synthesize → emit → verify |
| `apograph synthesize <dir>` | Modular synthesis from an approved `apograph-plan.json` |
| `apograph verify <dir> [dir2]` | 3-tier verification of a generated project |
| `apograph config` | Configure the LLM provider (stored in `~/.apograph/config.json`) |
| `apograph doctor` | Environment health check: Node, Chromium, LLM connectivity, Ollama |
| `apograph setup` | Install the apograph MCP server into your AI coding agent |

### `apograph clone`

```text
Usage: apograph clone [options] <url>

Options:
  -o, --out <dir>        output directory (defaults to ./output/<hostname>)
  -e, --evidence <dir>   evidence output directory (default: ".apograph/evidence")
  --max-depth <number>   max crawl depth (default: "2")
  --max-pages <number>   max pages to crawl (default: "10")
  --viewport <mode>      viewports to screenshot and verify: both, desktop, or mobile
  --scope <mode>         crawl scope for subpath URLs: single, subtree, or site
  --yes                  auto-approve the plan without interactive prompts
  --force                overwrite the output directory completely instead of merging
  --no-verify            skip the 3-tier verification pass
```

Subpath targets (e.g. `domain.com/frequently-asked-questions`) prompt for scope interactively: single page (cap 1), subtree crawl, or full site. Initial redirects are followed and the post-redirect URL is recorded as the canonical root.

### `apograph verify`

```text
Usage: apograph verify [options] <outputDir> [evidenceDir]

Options:
  --threshold <number>   visual mismatch threshold in percent (default: "15")
  --viewport <mode>      viewports to compare: both, desktop, or mobile
```

---

## MCP Tool Reference

Apograph ships as a [Model Context Protocol](https://modelcontextprotocol.io) server, so any MCP-capable agent (Claude Desktop, Cursor, Claude Code, Windsurf, OpenCode) can drive the pipeline autonomously.

### `apograph_crawl`

> Headless crawl of a site from a root URL: dual-viewport screenshots, a11y trees, design tokens, and mirrored image assets, persisted as an evidence bundle under `.apograph/evidence/`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `targetUrl` | `string (url)` | — | The site to crawl |
| `evidenceDir` | `string` | `.apograph/evidence` | Evidence output directory |
| `maxDepth` | `integer` | `2` | Max crawl depth |
| `maxPages` | `integer` | `10` | Max pages crawled |

### `apograph_clone`

> Autonomously crawl a website, derive a plan, synthesize a standalone React 19 + Tailwind CSS frontend, and verify it.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `targetUrl` | `string (url)` | — | The site to clone |
| `outDir` | `string` | `./output/<hostname>` | Output directory |
| `maxPages` | `integer` | `10` | Max pages crawled |
| `verify` | `boolean` | `true` | Run 3-tier verification |

---

## LLM Configuration

Apograph resolves its synthesis model with zero configuration by default. Environment variables always win; otherwise the persisted config (`apograph config`, stored in `~/.apograph/config.json`) is used:

| Priority | Condition | Model |
|---|---|---|
| 1 | `APOGRAPH_BASE_URL` + `APOGRAPH_API_KEY` set | Custom gateway / proxy (OpenAI-compatible) |
| 2 | `ANTHROPIC_API_KEY` set | `claude-3-7-sonnet-latest` |
| 3 | `OPENAI_API_KEY` set | `gpt-4o` |
| 4 | Nothing set | Local Ollama (`apograph-qwen35:9b-8k` at `http://localhost:11434/v1`) |

Set `APOGRAPH_MODEL` (or the model field saved by `apograph config`) to override the model id for **whichever provider is active** — it applies to the gateway, Anthropic, OpenAI, and Ollama routes alike (verified in `src/config/models.ts`: environment variables always take precedence over `~/.apograph/config.json`).

Structured output (`generateObject`) is used when the model supports it, with an automatic `generateText` + JSON-extraction fallback for local models and proxies. When no vision model is reachable at all, every synthesis stage falls back to deterministic compile-ready templates — the pipeline always produces a complete project.

### Local vision model on 16 GB Apple Silicon / Mac

The default local model is **`apograph-qwen35:9b-8k`** — a vision-capable Qwen 3.5 9B (Q4_K_M, ~6.6 GB on disk) served by [Ollama](https://ollama.com) with an 8k context window. It fits comfortably in 16 GB of unified memory: ~6.6 GB of weights plus the KV cache for 8k context leaves ample headroom for Chromium and the OS.

```bash
# 1. Install and start Ollama (https://ollama.com)
ollama serve

# 2. Pull the base model
ollama pull qwen3.5:9b

# 3. Create the 8k-context apograph variant
cat > /tmp/apograph.Modelfile <<'EOF'
FROM qwen3.5:9b
PARAMETER num_ctx 8192
EOF
ollama create apograph-qwen35:9b-8k -f /tmp/apograph.Modelfile

# 4. Confirm it answers (and supports vision)
ollama run apograph-qwen35:9b-8k "Reply with OK"
```

Verify the whole stack with `apograph doctor` — it probes Node, headless Chromium, the resolved LLM provider, and local Ollama, printing `[PASS]`/`[WARN]` with exact fix commands.

---

## Requirements

- **Node.js ≥ 20**
- **Playwright Chromium** (`pnpm exec playwright install chromium`) — launched headlessly by apograph itself
- **An LLM** — a cloud API key, a custom gateway, or a local Ollama install (see above)

## License

[MIT](LICENSE)

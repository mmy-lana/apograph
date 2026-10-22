# Apograph — AI-Powered Frontend Scaffolding & Asset Harvester

[![npm version](https://img.shields.io/npm/v/apograph-agents.svg)](https://www.npmjs.com/package/apograph-agents)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **A developer head start, not a finished clone.**

Apograph crawls a public website and synthesizes a clean, runnable **React 19.3 + Tailwind CSS v4 + React Router v7** project — a **75–85% visual/structural baseline** you build on. With a fast vision model it delivers a working scaffold **in under 2 minutes**. It is a scaffolding and asset-harvesting tool, **not an autonomous pixel-matching engine**: expect to polish typography, spacing, and interactions by hand.

## Package identity

The published npm package is **`apograph-agents`**.

```bash
npx apograph-agents <command>      # one-off
npm i -g apograph-agents           # then use the `apograph` bin
```

`npx apograph` fails with **E404** — `apograph` is a bin name, not the package name. The package installs three bins: `apograph` and `apograph-agents` (CLI) and `apograph-mcp` (MCP server).

## Quickstart

```bash
npx apograph-agents clone https://example.com
cd output/example-com && pnpm install && pnpm dev
```

Or install globally:

```bash
npm i -g apograph-agents
apograph clone https://example.com
```

## What you get

A standalone Vite + React + TypeScript project with no backend and no external service dependencies:

- React 19.3 + React DOM 19.3
- React Router v7 (multi-route scaffolding)
- Tailwind CSS v4 (via `@tailwindcss/vite`)
- Mirrored image assets under `public/assets/`
- TypeScript, Vite, and lucide-react wired and building

Output is a **75–85% visual/structural baseline**. Dense, animated, or heavily JS-driven source sites reconstruct less faithfully than static ones. You are expected to take it from scaffold to production by hand.

## Pre-flight inspection (`--dry-run`)

Both `clone` and `crawl` accept `--dry-run`, which runs the full crawl — dual-viewport screenshots, text spans, design tokens, and mirrored assets — prints a summary table **including the bot-check verdict**, and exits **without invoking LLM synthesis**. Use it to confirm a target is reachable and clean before spending model tokens.

```bash
npx apograph-agents crawl https://example.com --dry-run
npx apograph-agents clone https://example.com --dry-run
```

If the target serves a bot/WAF challenge or an access restriction (e.g. a JS challenge or Cloudflare interstitial), the pre-flight perimeter gate detects it and aborts before synthesis.

## Recommended models

Vision synthesis is model-bound, so model choice dominates wall-clock time:

| Model type | Examples | Throughput |
|---|---|---|
| Fast, high-throughput vision | Anthropic Claude 3.5 Haiku, MiniMax M3.1 Flash | stream a full page in **30–60 seconds** |
| Slower gateway / large models | general-purpose gateway endpoints | can take **10+ minutes per file** |

Use a fast vision model for iteration and reserve larger models for final fidelity passes. Override the active model per run with `--model <id>`, or set a default via `apograph config`.

## Benchmark (24-site audit)

A 24-target benchmark across live production sites (static docs, SaaS landings, dark product pages, editorial layouts, WebGL experiences):

- **23/23 accessible targets: 100% build pass rate and 100% runtime boot pass rate, with 0 fallback templates.**
- **1 target** (a JS-challenge / Cloudflare interstitial) was **correctly intercepted and skipped** by the pre-flight perimeter gate.

The benchmark gate is *build + runtime boot*, not pixel matching. Visual fidelity varies with source complexity — a static documentation site reconstructs far more faithfully than a heavily animated WebGL page. Every accepted synthesis used the primary vision model with zero deterministic-fallback templates.

## How it works

```
PHASE 1 — CRAWL
Headless Chromium captures same-origin pages
→ Dual-viewport screenshots (desktop + mobile)
→ Accessibility trees + design tokens
→ Asset mirroring

PHASE 2 — PLAN APPROVAL
Schema-validated plan generated from captured evidence
→ You review and approve before anything is synthesized
  (or auto-approve with --yes / --no-review)

PHASE 3 — SYNTHESIS
Vision LLM generates React 19 + Tailwind CSS v4 components
→ Deterministic fallback templates when no vision model is available

PHASE 4 — VERIFICATION
3-tier check: build → route smoke → visual diff
→ Reports show where the scaffold succeeded and where it needs work
```

## CLI reference

| Command | Description |
|---|---|
| `apograph crawl <url>` | Crawl evidence only (screenshots, a11y trees, tokens, assets). `--dry-run` inspects without synthesis |
| `apograph plan [dir]` | Generate and review/approve the plan from an evidence bundle |
| `apograph clone <url>` | Full pipeline: crawl → plan → synthesize → verify |
| `apograph resume [dir]` | Resume an interrupted clone from its checkpoint |
| `apograph synthesize <dir>` | Synthesize a project from an approved plan |
| `apograph verify <dir>` | 3-tier verification: build → route smoke → visual diff |
| `apograph clone-verify <url> <dir>` | Compare a clone side-by-side against the live original |
| `apograph status` | Show generated projects under `./output/` |
| `apograph config` | Configure the LLM provider (gateway, Anthropic, OpenAI, Ollama) |
| `apograph doctor` | Environment health check (Node, Chromium, LLM, Ollama) |
| `apograph mcp` \| `serve` | Start the MCP server over stdio for coding agents |
| `apograph setup` | Install the MCP server into your coding agent |

### Critical flags

| Flag | Commands | Description |
|---|---|---|
| `--dry-run` | `clone`, `crawl` | Pre-flight inspection: crawl + mirror assets + extract evidence, print a summary table (incl. bot-check verdict), and exit **without synthesis** |
| `--force` | `clone`, `synthesize` | Overwrite the output directory completely instead of merging |
| `--viewport <mode>` | `clone`, `crawl`, `verify`, `synthesize`, `clone-verify` | Viewports to capture/compare: `both`, `desktop`, or `mobile` |
| `--yes` | `clone`, `plan` | Auto-approve the plan without interactive prompts |
| `--no-review` | `clone`, `plan` | Skip the Gate 1 evidence review (automated filtering only) |
| `--model <id>` | `clone`, `synthesize`, `doctor` | Override the active model ID for the run |

## LLM configuration

Apograph works with any OpenAI-compatible endpoint, Anthropic, OpenAI, or local Ollama. Provider resolution order:

| Priority | Condition | Default model |
|---|---|---|
| 1 | `APOGRAPH_BASE_URL` + `APOGRAPH_API_KEY` | Custom gateway |
| 2 | `ANTHROPIC_API_KEY` | claude-3-7-sonnet-latest |
| 3 | `OPENAI_API_KEY` | gpt-4o |
| 4 | Nothing set | Local Ollama (`http://localhost:11434/v1`) |

Optional: `APOGRAPH_MODEL` sets the active model; `APOGRAPH_LLM_TIMEOUT_MS` tunes the per-call timeout.

## Requirements

- Node.js ≥ 20
- Playwright Chromium: `pnpm exec playwright install chromium`
- An LLM (cloud API key or local Ollama)

## License

MIT

# Apograph — Frontend Cloning Engine for Coding Agents

[![npm version](https://img.shields.io/npm/v/apograph-agents.svg)](https://www.npmjs.com/package/apograph-agents)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **A head start, not a finished product.**

Apograph crawls any public website and synthesizes a standalone React frontend that captures the site's structure, layout, color system, and typography. It saves hours of scaffolding work. It does not produce a pixel-perfect clone.

## Honest Fidelity Ranges

| What apograph does well | Typical accuracy |
|---|---|
| Page structure and layout | 85–95% |
| Color system and palette | 90–95% |
| Typography (families, sizes) | 80–90% |
| Navigation and routing | 75–90% |
| Static content and copy | 70–85% |
| CSS animations and transitions | 20–50% |
| Authenticated/gated flows | Not supported |
| Heavily JS-driven interactions | 30–60% |

**What this means in practice:** On a typical company or portfolio site, apograph produces a deployable React project in under 20 minutes that you then spend 2–4 hours polishing. The more animation-heavy or JavaScript-driven the source site, the more manual work remains.

## Package note

The published npm package is **`apograph-agents`**. Use `npx apograph-agents <command>` — `npx apograph` fails with E404 because `apograph` is a bin name, not the package name.

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

## How It Works
PHASE 1 — CRAWL
Headless Chromium crawls same-origin pages
→ Dual-viewport screenshots (desktop + mobile)
→ Accessibility trees + design tokens
→ Asset mirroring

PHASE 2 — PLAN APPROVAL
Schema-validated plan generated from evidence
→ You review and approve before anything is synthesized

PHASE 3 — SYNTHESIS
Vision LLM produces React 19 + Tailwind CSS components
→ Deterministic fallbacks when no vision model available

PHASE 4 — VERIFICATION
3-tier check: build → route smoke → pixel diff
→ Diff report shows where cloning succeeded and where it needs work


## CLI Reference

| Command | Description |
|---|---|
| `apograph crawl <url>` | Crawl evidence only |
| `apograph plan [dir]` | Review and approve the plan |
| `apograph clone <url>` | Full pipeline |
| `apograph resume [dir]` | Resume interrupted clone |
| `apograph synthesize <dir>` | Synthesize from approved plan |
| `apograph verify <dir>` | 3-tier verification |
| `apograph clone-verify <url> <dir>` | Compare clone against live original site |
| `apograph status` | Show generated projects |
| `apograph config` | Configure LLM provider |
| `apograph doctor` | Environment health check |
| `apograph mcp` | Start MCP server for coding agents |
| `apograph setup` | Install into your coding agent |

## LLM Configuration

Apograph works with any OpenAI-compatible endpoint, Anthropic, OpenAI, or local Ollama.

| Priority | Condition | Default model |
|---|---|---|
| 1 | `APOGRAPH_BASE_URL` + `APOGRAPH_API_KEY` | Custom gateway |
| 2 | `ANTHROPIC_API_KEY` | claude-3-7-sonnet-latest |
| 3 | `OPENAI_API_KEY` | gpt-4o |
| 4 | Nothing set | Local Ollama fallback |

## Requirements

- Node.js ≥ 20
- Playwright Chromium: `pnpm exec playwright install chromium`
- An LLM (cloud API key or local Ollama)

## License

MIT

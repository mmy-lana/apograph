# Apograph SDD — Decisions Needed (Phase 00)

Only decisions that cannot be reliably determined from repository evidence. Everything else is answered in `audit.md` / `issues.md`.

## D1 — Package naming strategy for `npx apograph`

`npx` resolves package names, not bin names; the `apograph` package does not exist (404). Options:

- **A.** Keep `apograph-agents`; change all docs to `npx apograph-agents …`. Cheapest, no new package.
- **B.** Additionally publish a tiny `apograph` package (own name or under a scope you own) whose bin delegates to this CLI. Makes the README literally true; adds a package to maintain.
- **C.** Rename the package to `apograph` (breaking change for existing installs of `apograph-agents`).

Needed by: IS-01, IS-03. Also requires: confirming who owns the npm `apograph` name (unknown — not taken as of this audit, but unverified whether publishable/claimable).

## D2 — DSH integration target: which file does `setup --client dsh` write?

DSH consumes MCP servers via `@deepseek-ai/dsh-mcp-client` composition entries (audit §1). Candidate targets:

- **A.** The active profile's patch layer: `~/.dsh/profiles/web/cordis.patch.yml` (user-editable by design; affects the whole profile).
- **B.** A new agent preset under `${DSH_HOME:-~/.dsh}/.agent-presets/apograph/cordis.yml` (session-scoped; requires the user to select the preset).
- **C.** Documentation-only: don't write files, just print the exact composition entry for the user to paste.

Needed by: IS-02, IS-03. Evidence for each option's mechanics exists in the DSH install; the *intended user experience* is a product choice.

## D3 — Generic/custom client configuration format

For arbitrary MCP clients: which file format and shape does `setup --client custom` (or `--config <path>`) write? Options: standard `mcpServers` JSON (Claude-compatible shape, the de-facto standard), a printed snippet only, or a template the user completes. Also: create the file when missing vs require it to exist (current behavior errors out).

Needed by: IS-02, IS-07.

## D4 — Client roster for the "top-ten compatibility" strategy

Which clients beyond the current five (claude-desktop, cursor, claude-code, windsurf, opencode) + dsh must work, and in what order? No repository evidence exists for the intended list; each addition needs a verified config path and shape from that client's documentation.

Needed by: IS-07.

## D5 — Test framework and runner

No tests exist. Pick the framework (e.g. node:test — zero new deps — vs vitest) and where release-verification checks (IS-09) live. Note: `pnpm typecheck` currently fails in this environment due to a pnpm 11 sqlite store error unrelated to the repo; decide whether CI/verification scripts should invoke tsc directly to avoid environment coupling.

Needed by: IS-05, IS-09.

## D6 — Test framework note on `npm version` in bump scripts

Minor: `bump:*` scripts call `npm version` inside a pnpm repo (audit §1). Keep (functional, just inconsistent), or replace with pnpm-equivalent versioning? Low stakes; bundled with IS-09 if touched.

---

# Phase 01 update — decision states and recommended defaults

The spec (`spec.md`) is implementation-ready only upon approval of these defaults. Each lists alternatives, trade-offs, and a recommended default; none are silently resolved.

| ID | Decision | Alternatives (trade-off) | Recommended default |
|---|---|---|---|
| D1 | Package naming | A: docs use `npx apograph-agents` (cheapest); B: also publish an `apograph` alias package (README literal, extra package to maintain; requires confirming name ownership); C: rename package (breaking) | **A** + `mcp` subcommand |
| D2 | DSH write target | A: profile patch `~/.dsh/profiles/web/cordis.patch.yml` (all sessions affected); B: agent preset `~/.dsh/.agent-presets/apograph/cordis.yml` (session-scoped, opt-in, safest); C: print entry only (zero risk, manual) | **B**, with C as automatic fallback |
| D3 | Generic client format | mcpServers JSON (de-facto standard, merges into Claude-family configs); printed snippet only; OpenCode-style arrays (non-standard, rejected) | **mcpServers JSON**, create file if missing (confirmed non-TTY), backup + abort-on-corrupt |
| D4 | Tier-1 roster order | spec §9 ranks by documented evidence: VS Code, Gemini CLI, Zed, Codex CLI, Cline/Continue — **demand order is an assumption**; confirm, reorder, or defer P4 | Confirm or defer |
| D5 | Test framework | `node:test` (zero deps, Node ≥ 20 builtin); vitest (nicer DX, new devDependency) | **node:test** |
| D6 | `npm version` in bump scripts | keep (functional); pnpm equivalent (cosmetic consistency) | Keep unless P3 touches release scripts anyway |

**Blocking question for Gate A:** do you approve the spec and defaults D1/D2/D3/D5, and do you want P4 (Tier-1 adapters) in scope — if so, in what order?

**Not asked** (already answered by evidence): whether the CLI is `apograph-agents` (yes, via bin), what the current clients are (five, in `src/commands/setup.ts`), how DSH registers MCP servers (dsh-mcp-client entries, audit §1), what providers are supported (gateway/anthropic/openai/ollama, `src/config/models.ts`), and why `npx apograph` fails (no such npm package).

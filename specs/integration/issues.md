# Apograph SDD — Issue List

> **Phase 02 update.** Local repairs landed (unpublished, per no-publish rule):
> - **IS-01** — README commands corrected to `npx apograph-agents` + global-install line + package-name note. *Fixed locally; the published 0.1.1 tarball still carries the broken README until the next authorized release* (unpkg check: 0 occurrences of `npx apograph-agents` in the published README). Full closure requires TEST-03 + publish.
> - **IS-04** — **Fixed and verified**: version single-sourced from `package.json` via new `src/version.ts`; CLI `--version` and MCP `serverInfo` both report `0.1.1` (observed locally and from a tarball install).
> - **IS-06** — partial: stale "v0.1.0" claim fixed; `resume`/`status` CLI-table rows still missing (deferred to Phase 03/P3 docs pass). Ollama tag still unverified.
> - **IS-09** — partial evidence: `npm pack --dry-run` verified tarball contents (78 files incl. README/LICENSE/package.json); tarball installed into a temp prefix, all three bins functional. Full checklist still pending.
>
> **Phase 01 update.** Priorities and dependencies below are superseded by `spec.md` / `plan.md`:
> - **P1 (plan phase P1):** IS-03, IS-04 (+ new work MCP-02/04 lifecycle & error containment, folded here rather than tracked as separate issues).
> - **P2:** IS-02 (now decomposed into spec requirements DSH-01, CLIENT-01, MODEL-01/02/03), IS-08.
> - **P3:** IS-01, IS-06, IS-09 (+ IS-10 documentation part).
> - **P4 (evidence-gated, needs D4):** IS-07.
> - Dropped from implementation scope: none; IS-10's tool-parity part remains a tracked non-goal (spec §2, MCP-03 documents the gap honestly).
> Original Phase 00 list retained below for evidence traceability.

Prioritized, deduplicated. Priority: P0 blocks the advertised happy path; P1 blocks stated objectives (DSH/custom clients/providers); P2 quality/verification. Dependencies reference other issue IDs. Phase-01 prerequisites are marked in `decisions-needed.md`.

---

## IS-01 — Advertised install command `npx apograph` returns E404 (P0)

- **Evidence**: README:22,33,47 use `npx apograph clone|setup|doctor`; `registry.npmjs.org/apograph` → 404; package is named `apograph-agents` (`package.json:2`); bin `apograph` exists only *after* installation (`package.json:34-36`).
- **Impact**: Every quickstart instruction in the published README fails for new users. Root cause of the reported E404.
- **Proposed scope**: Fix all README/npm-facing commands to `npx apograph-agents …`, and/or add an npm package named `apograph` (see decision D1). Optionally add a `mcp`/`serve` CLI subcommand so `npx apograph-agents mcp` starts the server (also required by IS-03).
- **Dependencies**: D1 (naming strategy) must be decided first.
- **Acceptance criterion**: Each README command, copied verbatim into a clean environment, resolves and runs (no E404); verified against the next published version.

## IS-02 — `setup` rejects `dsh` and any unknown/custom client (P0 for the stated objective)

- **Evidence**: `src/commands/setup.ts:164-179` alias map covers only claude-desktop, cursor, claude-code, windsurf, opencode; unknown input → the exact error the user observed. No generic path-based client target exists.
- **Impact**: Cannot register apograph in DeepSeek Harness via the CLI; cannot support any client outside the hardcoded five.
- **Proposed scope**: Add `dsh` client id that writes a `dsh-mcp-client` composition entry (target file per D2); add a generic `--client <name>` / `--config <path>` mode that writes a standard `mcpServers` JSON entry (shape per D3). Must not break the existing five clients.
- **Dependencies**: D2 (DSH target file), D3 (generic config format), D4 (client onboarding list).
- **Acceptance criterion**: `npx apograph-agents setup --client dsh` (or documented equivalent) writes a valid DSH entry that makes `mcp__apograph__*` tools appear after a harness reload; `setup --client custom --config-path <file>` writes a valid `mcpServers.apograph` JSON object; existing clients' behavior unchanged (regression test).

## IS-03 — No launchable MCP entry point via the package name (P0 for DSH/agent use)

- **Evidence**: Default bin `apograph-agents` runs the CLI (`dist/cli.js`); the MCP server is only reachable via bin `apograph-mcp`, which npx cannot resolve (`registry.npmjs.org/apograph-mcp` → 404); CLI has no `mcp`/`serve` subcommand (`src/cli.ts`).
- **Impact**: External clients (including DSH) cannot be configured with a one-line `command: npx, args: ['-y','apograph-agents', …]` entry; DSH `dsh-mcp-client` expects a stdio command it can spawn.
- **Proposed scope**: Add an `apograph-agents mcp` (or `serve`) subcommand that starts the stdio server; document the DSH entry (`command: npx, args: ['-y','apograph-agents','mcp']`).
- **Dependencies**: None (IS-01/D1 may rename it).
- **Acceptance criterion**: A `npx -y apograph-agents mcp` process speaks MCP over stdio (initialize handshake observed); the DSH composition entry loads and lists `mcp__apograph__apograph_crawl` and `mcp__apograph__apograph_clone`.

## IS-04 — CLI/MCP hardcoded versions drift from package version (P1)

- **Evidence**: `src/cli.ts:514` and `src/mcp.ts:45` hardcode `'0.1.0'` while `package.json` is `0.1.1`; README claims v0.1.0.
- **Impact**: `--version`, MCP `initialize` response, and docs disagree; release hygiene risk.
- **Proposed scope**: Read the version from package.json (or generate at build) in both entry points; fix the README version claim.
- **Dependencies**: None.
- **Acceptance criterion**: `node dist/cli.js --version` equals `package.json` version in a fresh build; MCP `initialize` result version equals it.

## IS-05 — No test suite at all (P1)

- **Evidence**: No test script, framework, or test files (audit §1).
- **Impact**: Cannot satisfy "run relevant tests" for any subsequent phase; the published-package installation path (the exact thing that broke) is untested.
- **Proposed scope**: Introduce a minimal test runner (framework per D5), starting with: client-key normalization, config writer output shapes for each supported client, MCP server tool schema validation, and (smoke) a clean `npm pack`/`npx` invocation of the built artifact.
- **Dependencies**: D5 (framework choice).
- **Acceptance criterion**: `pnpm test` runs the suite and covers at least the setup command matrix and MCP tool schemas; all pass in a clean checkout.

## IS-06 — README accuracy: missing commands, unverified model instructions (P1)

- **Evidence**: `resume`/`status` missing from CLI table (README:99-108 vs `src/cli.ts:648-749`); Ollama `qwen3.5:9b` pull instructions unverified (audit §7).
- **Impact**: Users cannot discover resume/status; local-model instructions may be unactionable.
- **Proposed scope**: Add both commands to the table; verify or correct the Ollama tag via the Ollama library.
- **Dependencies**: None.
- **Acceptance criterion**: README CLI table matches `apograph --help` output exactly; Ollama instructions verified against the live model library.

## IS-07 — Top-ten client compatibility strategy undefined (P1)

- **Evidence**: Only 5 clients supported, all via hardcoded per-client injectors (`src/commands/setup.ts:110-155`); setup only configures clients whose config file already exists (`setup.ts:148`).
- **Impact**: Each new client requires bespoke code; users of unlisted clients get no guidance.
- **Proposed scope**: Decide the client roster (D4); prefer the generic config writer (IS-02) over new bespoke injectors; consider creating a missing config file (with a prompt) instead of erroring.
- **Dependencies**: D4, IS-02.
- **Acceptance criterion**: `apograph setup --help` lists the supported roster; each listed client is either wired via an injector or explicitly routed through the generic writer with documented config paths.

## IS-08 — Custom AI provider/model configuration gaps (P2)

- **Evidence**: `src/config/models.ts` — `APOGRAPH_MODEL`/config `model` applies to whichever provider is active (an OpenAI-only id would be sent to Anthropic if misconfigured); `getFastParserModel` = `getSynthesizerModel` (no role split); API key stored plaintext in `~/.apograph/config.json`.
- **Impact**: Provider/model misconfigurations fail at request time, not config time; no per-role models; secret hygiene.
- **Proposed scope** (only what the spec approves): validate model id per provider family on `config --show`/doctor; document the override semantics; leave role split and secret storage as explicit non-goals unless approved.
- **Dependencies**: None.
- **Acceptance criterion**: `apograph doctor` warns when the resolved (provider, model) pair is inconsistent (e.g. non-Anthropic id with anthropic provider); README documents override precedence accurately (it currently does — keep it true).

## IS-09 — Clean-install / end-to-end release verification absent (P1)

- **Evidence**: No CI, no publish workflow, `bump:*` scripts mix npm into a pnpm repo, `dist/` gitignored with no verification that the tarball is installable (audit §1, §4).
- **Impact**: The exact class of failure users hit (broken npx path) ships undetected again.
- **Proposed scope**: Add a release verification checklist/script: fresh clone → `pnpm install && pnpm typecheck && pnpm build` → `npm pack` → install the tarball in a temp dir → run `--version`, `--help`, the setup writer against a temp HOME, and the MCP handshake. Automate in CI when the project adopts it.
- **Dependencies**: IS-05 (runner choice), IS-01/IS-03 (what to verify).
- **Acceptance criterion**: The checklist runs green against the next release candidate before publish; observed results recorded.

## IS-10 — MCP feature parity gap vs CLI (P2, tracking)

- **Evidence**: MCP exposes 2 tools without viewport/scope options (`src/mcp.ts:53-152`); CLI exposes 10 commands with scope/viewport/checkpoint controls; ROADMAP v1.0.0 already tracks parity.
- **Impact**: Agents driving apograph over MCP cannot use plan approval, resume, or viewport selection.
- **Proposed scope**: Out of scope for the integration phases unless approved; track only. Surface the gap honestly in the README MCP section.
- **Dependencies**: None.
- **Acceptance criterion**: README MCP section states exactly which CLI capabilities are unavailable over MCP (verified against `src/mcp.ts`).

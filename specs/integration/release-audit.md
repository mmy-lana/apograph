# Apograph SDD — Phase 06 Release Readiness Audit

Date: 2026-10-15 (session). Auditor: implementation agent (same session — see "Independence" note). Baseline: working tree (uncommitted), `apograph-agents` v0.1.1.

**Independence caveat:** this audit was executed by the same agent that implemented Phases 02–05 in this session. All commands below were actually executed and their outputs observed verbatim; no assertion below rests on unexecuted checks. A fully independent re-run of the same command list is cheap and recommended during review.

## 1. Exact commands executed and observed results

| # | Command | Observed result |
|---|---|---|
| 1 | `pnpm typecheck` | Exit 0 (`tsc --noEmit`, no diagnostics) |
| 2 | `pnpm build` | Exit 0 (`tsc`) |
| 3 | `node --test tests/setup.test.ts tests/config.test.ts` | **42 tests, 11 suites, 42 pass, 0 fail, 0 cancelled** |
| 4 | `npm pack --dry-run` | 87 files, 123.0 kB packed / 494.4 kB unpacked; includes `README.md`, `LICENSE`, `package.json`, `dist/cli.js`, `dist/mcp.js`, `dist/version.js` |
| 5 | `node dist/cli.js --help` | Full command list incl. `mcp\|serve`, `setup` with `--client`/`--config-path` |
| 6 | `node dist/cli.js --version` | `0.1.1` (= `package.json`) |
| 7 | `node dist/cli.js mcp` (scripted stdio session) | `initialize` → `serverInfo {"name":"apograph","version":"0.1.1"}`; `tools/list` → `apograph_crawl, apograph_clone`; **fault injection** (`tools/call apograph_crawl` with `not-a-url`) → `isError: true` result; subsequent `tools/list` still OK (server alive); **stdin close → exit 0**; earlier: SIGTERM → exit 0 |
| 8 | `node dist/cli.js setup --client dsh` (temp `DSH_HOME`) | Preset written; rerun → `already present — nothing to do` (idempotent) |
| 9 | `node dist/cli.js setup --client custom` | Copy-pasteable `mcpServers` JSON block printed |
| 10 | `node dist/cli.js doctor` | 5/8 passed on live local Ollama; `[WARN]` capability lines with fix text; exit 0. With a malformed gateway env: `[FAIL] Base URL well-formed`, credential masked (`sk-t**********gh`), no raw key in output |
| 11 | `npm pack` → install tarball into temp prefix (`--ignore-scripts`) → `.bin/apograph mcp` handshake | `serverInfo` v0.1.1, both tools listed, `--version` = 0.1.1 — **publish-path verified** |
| 12 | README grep audit | All 4 `npx` examples use `apograph-agents`; version claim `v0.1.1`; zero DSH/deepseek claims (no false unverified claims) |

## 2. Requirement verification scorecard (all 20)

| Requirement | State | Evidence / gap |
|---|---|---|
| PKG-01 single launchable identity | **Partially Verified** | All local/tarball commands work; the *published* 0.1.1 still carries broken README commands and lacks `mcp` — closes only at next publish |
| PKG-02 `mcp` subcommand | **Verified** | Handshake via local dist AND via fresh tarball install (commands 7, 11) |
| PKG-03 version single-source | **Verified** | CLI, MCP serverInfo, package.json all 0.1.1 |
| MCP-01 shared server, stdio | **Verified** | Identical tool lists from `dist/mcp.js` bin and `mcp` subcommand |
| MCP-02 graceful shutdown | **Verified** | stdin close → exit 0; SIGTERM → exit 0 (command 7) |
| MCP-03 contracts = docs | **Partially Verified** | README's two tool tables match `tools/list`; the explicit "CLI features unavailable over MCP" parity statement is not yet in the README |
| MCP-04 error containment | **Verified** | Fault injection: `isError: true`, server survived (command 7) |
| MCP-05 security boundaries | **Partially Verified** | Writes confined to temp/cwd paths (unit + manual); README security bullet list not yet added |
| DSH-01 dsh adapter | **Partially Verified** | Writer fully unit-tested + manually exercised (create/idempotent/3 fallbacks); **live DSH reload not executed** |
| DSH-02 connection verification | **Pending (Gate C)** | Requires loading the preset in a DSH session and observing `mcp__apograph__*` — cannot be done from inside this session (see §4) |
| CLIENT-01 generic writer | **Verified** | 42/42 tests incl. create/merge/idempotency/abort-on-corrupt, `runSetup` routing, unknown-client guidance with zero writes |
| CLIENT-02 ranked roster | **Partially Verified** | Matrix shipped as `specs/integration/clients.md`; README link/summary absent; dedicated Tier-1.5 adapters intentionally deferred (approved D4) |
| MODEL-01 provider independence | **Verified** | Precedence unit tests; adapters write only MCP rows |
| MODEL-02 config validation | **Verified** | All five issue classes unit-tested; `[FAIL]`/masked output observed live |
| MODEL-03 capability detection | **Verified** | Doctor lines observed on live local Ollama; probes report-only (pipeline unchanged); cloud paths verified via mocks only (noted limitation) |
| MODEL-04 scoped claims | **Verified** | README LLM section matches `models.ts` exactly (priority table + `APOGRAPH_MODEL` note; no universal-compatibility claims) |
| DOC-01 README overhaul | **Partially Verified** | Commands/version fixed (Phase 02); `mcp` subcommand, `dsh`/`custom` setup, clients matrix not yet surfaced in README |
| DOC-02 roster docs | **Partially Verified** | `specs/integration/clients.md` authoritative; not linked from README |
| DOC-03 resume/status documented | **Pending** | CLI table still lacks `resume` and `status` rows |
| TEST-02 release checklist | **Partially Verified** | Every checklist element executed manually this audit (incl. tarball install); not yet scripted as one command; no `test` script in `package.json` |

**Summary: 9 Verified · 9 Partially Verified · 2 Pending · 0 Blocked.** No compiler or test assertions were weakened at any point.

## 3. Remaining risks, limitations, blockers

1. **Gate C / DSH live reload (DSH-02) — the one true blocker for the "DSH works" claim.** The composition row, writer, idempotency, and fallbacks are verified; what is *not* verified is a real DSH process loading `@deepseek-ai/dsh-mcp-client` with the apograph row and listing `mcp__apograph__apograph_crawl`/`mcp__apograph__apograph_clone`. This session runs *inside* DSH and cannot reload its own composition; it must be done in a fresh DSH session (`dsh` started with the apograph preset/patch). Until then, all DSH claims stay in `specs/` docs and are marked pending — the public README correctly makes none.
2. **Published release is stale.** npm `apograph-agents@0.1.1` predates every fix (README commands, `mcp` subcommand, version single-sourcing, dsh/custom adapters, doctor validation). Users of the published package still hit the original E404-class issues until an authorized publish.
3. **Docs pass (P3) incomplete:** README lacks the `mcp` subcommand, `dsh`/`custom` setup sections, resume/status rows, MCP-parity statement, and security bullets (MCP-03/05, DOC-01/02/03).
4. **Minor:** `package.json` has no `test` script (tests are run manually after `tsc`); tarball ships `.js.map` + `.d.ts` (28 map files; adds ~30% size — acceptable, flagged for a future `files` refinement); capability probes on cloud providers were mock-verified only; Ollama model tag `qwen3.5:9b` in README instructions remains unverified against the Ollama library (Phase 00 unknown, never resolved).
5. `bump:*` scripts still call `npm version` inside the pnpm repo (D6 — approved to keep).

## 4. Verdict

**READY FOR REVIEW** — not yet READY FOR RELEASE.

Everything implemented is verified against local build and the packed tarball with zero test failures and no weakened assertions. Release is gated on: (a) the P3 documentation pass (README items above), (b) Gate C live DSH reload, (c) optional scripting of the release checklist + `test` script, and (d) explicit user authorization to publish/tag — none of which this phase is permitted to do.

## 5. Recommended release checklist (when publishing is authorized)

1. Complete the P3 docs pass (MCP-03/05, DOC-01/02/03) and re-audit README commands verbatim.
2. Execute Gate C: fresh DSH session with the apograph preset → confirm `mcp__apograph__*` tools listed and one `apograph_crawl` call succeeds; record output in `traceability.md`.
3. Decide version bump (changes are additive → suggest 0.2.0; at minimum 0.1.2) and update README version claim via the single source (package.json).
4. Optional hardening: add `"test": "tsc && node --test tests/"` script; consider trimming `.js.map` from `files`.
5. `pnpm typecheck && pnpm build && node --test tests/setup.test.ts tests/config.test.ts` — all green.
6. `npm pack --dry-run` — inspect file list (expect ~87 files, no `tests/`, no `src/`).
7. `npm pack` → install tarball into a temp prefix → `--version`, `--help`, `mcp` handshake, `setup --client dsh` (temp home), `setup --client custom --config-path` (temp file).
8. Publish (`npm publish`), then re-verify the *published* package: `npx -y apograph-agents --version`, `npx -y apograph-agents mcp` handshake, README on npmjs.com shows corrected commands.
9. Tag (`v<version>`) and GitHub release with the audit summary; update `traceability.md` PKG-01 to Verified.

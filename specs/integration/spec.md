# Apograph SDD — Integration Specification (Phase 01 candidate scope)

Status: **PENDING APPROVAL** — this is an approved-scope candidate. Product-level decisions marked **[D-x]** are listed in `decisions-needed.md` and are not silently resolved. Baseline evidence: `audit.md` (Phase 00). Requirement IDs are stable; future phases may extend but not renumber.

---

## 1. Problem statement and measurable goals

**Problem.** Apograph ships one npm package (`apograph-agents`) whose advertised install path (`npx apograph …`) returns E404; its `setup` command supports exactly five hardcoded clients and rejects DeepSeek Harness (DSH) and any unlisted client; the MCP server (`dist/mcp.js`) exposes only 2 of ~10 pipeline capabilities and has no launch path via the package name; provider/model configuration exists but is unvalidated at configuration time; there are no tests and no release verification, which is how the E404 shipped.

**Measurable goals (Phase targets, verified by the traceability matrix):**

| # | Goal | Metric |
|---|---|---|
| G1 | Every published install/invocation command works verbatim | 0 E404s executing each README command in a clean environment |
| G2 | Apograph tools callable from DSH | `mcp__apograph__apograph_crawl` and `mcp__apograph__apograph_clone` listed and executable after a DSH reload |
| G3 | Any MCP-compatible client can integrate without a new adapter | Documented generic route; standard `mcpServers` JSON written from one CLI invocation |
| G4 | Provider configuration validated before first use | `apograph doctor` reports auth/endpoint/model-consistency failures with actionable fix text |
| G5 | Regressions caught before publish | `pnpm test` green; release checklist green against the packed tarball |

## 2. In scope / out of scope

**In scope**
- Package naming and documentation corrections (per **[D1]** default: package name unchanged, all docs use `npx apograph-agents`).
- New `mcp` (alias `serve`) CLI subcommand starting the existing stdio MCP server.
- Version de-hardcoding (CLI `--version`, MCP `initialize`).
- MCP server hardening: graceful shutdown on stdin close/SIGINT/SIGTERM, per-tool error containment (MCP-05).
- A new `dsh` setup adapter writing a DSH composition entry (**[D2]** default: agent preset under `~/.dsh/.agent-presets/apograph/cordis.yml`, printing the entry when the preset dir is unavailable).
- A generic client configuration writer (`setup --client custom --config-path <file>` or a `--config-path`-only mode) producing standard `mcpServers` JSON (**[D3]**).
- A ranked client roster (CLIENT-02) — additions behind thin adapters only after path/shape evidence.
- Provider validation & capability detection: model-id/provider-family consistency, gateway endpoint reachability + `/models` listing, structured-output and vision probes with cached results (MODEL-02/03).
- README overhaul (DOC-01/02/03), including an honest MCP-parity statement (IS-10 documentation part).
- Minimal test suite on `node:test` (**[D5]** default) and a release-verification script (TEST-02/03).

**Out of scope**
- Expanding MCP tool surface toward CLI parity (plan approval, resume, checkpoint, per-tool scope/viewport) — tracked in IS-10; documented honestly, not built.
- Additional MCP transports (Streamable HTTP, SSE) — clients needing them use the documented stdio route; revisit on evidence of demand.
- Provider role split (`getFastParserModel` ≠ `getSynthesizerModel`), encrypted/OS-keychain secret storage.
- New runtime dependencies (test runner `node:test` is built into Node ≥ 20; all validation uses existing `ai`/`@ai-sdk/*`/fetch).
- Renaming the npm package or publishing alias packages beyond the **[D1]** decision.
- Changing any existing CLI command behavior (crawl/plan/clone/resume/synthesize/verify/status/config/doctor keep current flags and outputs except the version string fix).

## 3. Current → target architecture

**Current** (verified, audit §3):
- `dist/cli.js` (commander, 10 commands) and `dist/mcp.js` (McpServer + StdioServerTransport, 2 tools) are separate entry points; `setup` (src/commands/setup.ts) inlines 5 client definitions with per-client injectors and an absolute `dist/mcp.js` path; provider resolution (src/config/models.ts) reads env → `~/.apograph/config.json` → Ollama fallback, unvalidated beyond null checks.

**Target** (no new packages; module boundaries inside `src/`):
```
src/mcp.ts                  — transport + lifecycle only (imports server builder)
src/mcp/server.ts           — NEW: tool registration & contracts (single source of truth)
   └─ used by BOTH dist/mcp.js and `apograph mcp` subcommand (no second server)
src/clients/registry.ts     — NEW: shared ClientTarget type + server-definition builder
src/clients/<id>.ts         — thin per-client adapters (config path + inject fn) incl. dsh + custom
src/commands/setup.ts       — orchestrates registry; unknown client → generic route hint
src/config/models.ts        — unchanged resolution order
src/config/validate.ts      — NEW: provider validation + capability probes (pure, testable)
```
Constraints honored: MCP protocol logic in one place; client adapters hold no protocol logic; provider interface untouched by MCP registration; no per-client MCP servers.

## 4. Package naming, CLI invocation, documentation

**PKG-01 — Single launchable identity via the package name**
- Rationale: `npx` resolves package names; today only `npx apograph-agents` works (audit §2).
- Boundary: Docs and generated configs reference `npx -y apograph-agents` (CLI) and `npx -y apograph-agents mcp` (server). Package name unchanged **[D1 default]**. The `apograph`/`apograph-mcp` bins remain for installed use.
- Acceptance: Each README command runs verbatim in a clean env with no E404.
- Verification: TEST-03 (packed-tarball smoke).
- Dependencies: MCP-01.

**PKG-02 — `apograph mcp` subcommand**
- Rationale: MCP servers must be spawnable by clients from the package name (audit IS-03); DSH `dsh-mcp-client` spawns a stdio command.
- Boundary: New subcommand (alias `serve`) that imports the shared server builder and connects stdio; no behavior change to `dist/mcp.js` itself beyond sharing code.
- Acceptance: `npx -y apograph-agents mcp` completes an MCP `initialize` handshake over stdio.
- Verification: TEST-01 (scripted handshake against the spawned process), TEST-03.
- Dependencies: MCP-01.

**PKG-03 — Version single-sourcing**
- Rationale: `src/cli.ts:514`, `src/mcp.ts:45` hardcode `0.1.0` vs package `0.1.1` (IS-04).
- Boundary: Both entry points read the version from `package.json` at build/runtime (ESM import of the JSON or generated constant; no new deps). README version claim corrected.
- Acceptance: `node dist/cli.js --version` and MCP `initialize` `serverInfo.version` equal `package.json` version.
- Verification: TEST-01, TEST-02 assertions.
- Dependencies: none.

## 5. MCP server: lifecycle, transport, contracts, errors, security

**MCP-01 — Shared server implementation, stdio transport only**
- Rationale: IS-01/IS-03; architecture constraint "no duplicate tool implementations".
- Boundary: `src/mcp/server.ts` builds the McpServer with the two existing tools (`apograph_crawl`, `apograph_clone`) and their current Zod schemas, unchanged. Transport is stdio (existing `StdioServerTransport`). HTTP transports are out of scope (§2).
- Acceptance: Both `dist/mcp.js` and `apograph mcp` expose identical tool lists; schemas match README MCP tables.
- Verification: TEST-01 (tool list + schema snapshot test), TEST-03.
- Dependencies: none.

**MCP-02 — Lifecycle: graceful shutdown**
- Rationale: Current top-level `await server.connect()` leaves no shutdown path (audit §1); spawned servers must not orphan.
- Boundary: Close the transport and exit 0 on stdin end/close; SIGINT/SIGTERM handlers; no changes to tool behavior.
- Acceptance: Killing the client's stdin terminates the server process within 2 s with exit code 0; SIGTERM likewise.
- Verification: TEST-01 (spawn, close stdin, assert exit).
- Dependencies: MCP-01.

**MCP-03 — Tool contracts documented as implemented**
- Rationale: IS-10 documentation part; users must know MCP ≠ full CLI.
- Boundary: README MCP section states exactly the two tools, their parameters/defaults, and lists CLI capabilities unavailable over MCP (plan approval, resume, scope/viewport flags). No new tool parameters in this phase.
- Acceptance: Documented table matches a programmatic `tools/list` dump exactly.
- Verification: TEST-01 snapshot vs README table (manual diff documented in TEST-03 checklist).
- Dependencies: MCP-01.

**MCP-04 — Per-tool error containment**
- Rationale: A crawl failure today can crash the server process, dropping every tool mid-session.
- Boundary: Each tool handler catches errors and returns `isError: true` text content with the message; process-level failures (unhandled rejection) keep existing behavior. No retry logic added.
- Acceptance: A tool invocation that throws (e.g. invalid URL rejected by Zod already; simulate a crawl failure) returns an MCP error result and the server stays alive for a subsequent call.
- Verification: TEST-01 (fault-injection test using a stubbed internal call where feasible; otherwise documented manual check in TEST-03).
- Dependencies: MCP-01.

**MCP-05 — Security boundaries (documented + preserved)**
- Rationale: Server runs with the client's privileges, in the client's cwd.
- Boundary: Preserve existing behavior: tools write only under the caller's cwd (`./output`, `.apograph/`); no new filesystem scope; no secrets read beyond existing provider env/config; document that running a clone executes the pipeline (network fetch + headless Chromium) with cwd write access. `setup` adapters must not write outside the paths approved per client.
- Acceptance: Audit note in README "Security" bullet list; no new writes outside documented paths (verified in TEST-02 by inspecting a temp HOME/cwd after a tool call).
- Verification: TEST-02, TEST-03 checklist.
- Dependencies: none.

## 6. DSH registration and connection verification

**DSH-01 — `setup --client dsh` writes a DSH composition entry**
- Rationale: IS-02; DSH priority per product requirements.
- Boundary: New adapter in `src/clients/dsh.ts` producing a `@deepseek-ai/dsh-mcp-client` entry:
  ```yaml
  - id: mcp-apograph
    name: '@deepseek-ai/dsh-mcp-client'
    config:
      serverName: apograph
      transport: stdio
      command: npx
      args: ['-y', 'apograph-agents', 'mcp']
  ```
  Target file **[D2]**: default = `~/.dsh/.agent-presets/apograph/cordis.yml` (session-scoped, safe); if DSH home cannot be located (`DSH_HOME` or `~/.dsh` absent), print the entry plus manual instructions and exit 0. Adapter never edits an existing preset's rows other than the `mcp-apograph` entry it owns (idempotent upsert, backup first, mirroring existing setup conventions).
- Acceptance: After running setup and selecting/loading the preset, DSH lists `mcp__apograph__apograph_crawl` and `mcp__apograph__apograph_clone`; re-running setup is idempotent (no duplicate rows).
- Verification: TEST-04 (writer unit test on temp HOME) + a live DSH reload check documented in TEST-03 checklist.
- Dependencies: PKG-02 (the spawned command must exist).

**DSH-02 — Connection verification guidance**
- Rationale: "Registered" must be observable.
- Boundary: README + setup output state the verification step (reload harness → call a tool or check the tool list) and the known failure modes from the dsh-mcp-client contract (startup failure ⇒ no tools + logged error; reconnect policy). No new DSH-side code is written by this project.
- Acceptance: Documented procedure, executed once during release verification (TEST-03).
- Verification: TEST-03 checklist item with observed result recorded.
- Dependencies: DSH-01.

## 7. Generic / custom client configuration

**CLIENT-01 — Generic config writer**
- Rationale: IS-02/IS-07; product requirement "other compatible clients can use a documented custom MCP configuration path".
- Boundary: `apograph setup --client custom --config-path <file>` (path also accepted without `--client custom`) writes standard `{"mcpServers":{"apograph":{command,args}}}` JSON, merging into an existing file (parse-error → abort without writing, backup first). Creates the file when missing (confirmed in non-TTY mode). Format choice **[D3]** default: mcpServers JSON; OpenCode-style arrays are NOT emitted by the generic writer.
- Acceptance: Writing into an existing valid config preserves unrelated keys; into a corrupt JSON file aborts with a clear error and no modification; a fresh file is created when missing.
- Verification: TEST-04.
- Dependencies: none.

**CLIENT-02 — Ranked compatibility roster (no guesswork)**
- Rationale: Product requirement to prioritize without inventing demand.
- Boundary: Tier 0 (implemented now): dsh + the 5 existing adapters + CLIENT-01 generic route. Tier 1 candidates, ranked by evidence, each promoted only after config path/shape is verified from that client's docs: 1. **VS Code / Copilot** (`mcp` servers config, stdio) — largest documented MCP client base; 2. **Gemini CLI** (`~/.gemini/settings.json` `mcpServers`) — stdio, documented; 3. **Zed** (`context_servers`, stdio); 4. **Codex CLI** (`config.toml` `mcp_servers`, TOML — note different format); 5. **Cline / Continue** (VS Code extensions, mcpServers JSON). **Assumptions (unverified demand, marked):** user demand for Tier 1 order; exact current config shapes must be re-verified at implementation time (paths/fields change across client versions).
- Acceptance: Roster published in README with each entry's config path and shape, verified against that client's documentation at implementation time; anything unverified is labeled.
- Verification: TEST-04 adapter tests per promoted client; README review (DOC-02).
- Dependencies: D4 (final roster + order), CLIENT-01.

## 8. Model provider configuration and capability detection

**MODEL-01 — Provider configuration independent of client**
- Rationale: Product requirement; already true architecturally (models.ts reads env/config only) — locked as a constraint.
- Boundary: No client-specific provider overrides; `setup` adapters never touch provider config. Documented as an invariant; enforced by TEST-04 asserting adapters write only MCP rows.
- Acceptance: Provider resolution depends only on env + `~/.apograph/config.json` (existing precedence, unchanged).
- Verification: TEST-05 (unit tests of `resolveProviderName`/`resolveModelId` precedence — currently untested code).
- Dependencies: none.

**MODEL-02 — Configuration-time validation**
- Rationale: IS-08; goal G4. Failures should surface at `config`/`doctor` time, not first synthesis.
- Boundary: New `src/config/validate.ts` used by `doctor` (and `config --show`): (a) model-id/provider-family consistency (e.g. non-Anthropic id with anthropic provider ⇒ WARN, since gateways legitimately remap); (b) gateway/base-URL reachability via `GET {baseURL}/models` (OpenAI-compatible) with a short timeout; (c) API key presence for cloud providers; (d) Ollama `/api/tags` probe (exists in doctor today — reused). Doctor output format unchanged (`[PASS]/[WARN]` + fix command).
- Acceptance: Each failure mode produces a `[WARN]`/`[FAIL]` with the exact fix text; a healthy config passes; network failures degrade to WARN, never crash.
- Verification: TEST-05 (validate.ts unit tests with stubbed fetch).
- Dependencies: none.

**MODEL-03 — Capability detection, explicit and cached**
- Rationale: "Do not claim universal provider compatibility" — structured-output support already detected at runtime by error shape (llm.ts:58); make it observable and pre-checkable.
- Boundary: `doctor` performs a one-token structured-output probe and (when the model reports vision use, or on `--deep`) a small image-probe, reporting `structured-output: native|fallback` and `vision: yes|no|unknown`; results never change pipeline behavior (existing runtime fallback stays authoritative). No new dependencies.
- Acceptance: `apograph doctor` prints both capability lines; pipeline behavior is byte-identical to today for any probe outcome.
- Verification: TEST-05 + manual TEST-03 record against one cloud provider and one Ollama endpoint.
- Dependencies: MODEL-02.

**MODEL-04 — Compatibility claims stay scoped**
- Rationale: Never claim universal compatibility.
- Boundary: README states the supported matrix exactly: OpenAI-compatible endpoints (incl. Ollama's OpenAI route), Anthropic API, OpenAI API; "any OpenAI-compatible gateway *should* work but is validated per-endpoint by `doctor`"; no other providers claimed.
- Acceptance: README claims match `src/config/models.ts` code paths exactly (reviewed in DOC-01).
- Verification: DOC review checklist in TEST-03.
- Dependencies: none.

## 9. Prioritized client compatibility strategy

Tier 0 (this phase): `dsh` (DSH-01), `custom` generic writer (CLIENT-01), existing five adapters untouched (regression-protected). Tier 1 (later phases, per CLIENT-02 ranking, each behind a thin adapter): VS Code, Gemini CLI, Zed, Codex CLI, Cline/Continue. Promotion rule: adapter added only when (a) config path+shape verified from client docs, (b) it can express stdio command+args, (c) a TEST-04-style writer test exists. Everything else: the generic route (CLIENT-01) plus documented snippet.

## 10. Testing strategy and release acceptance

**TEST-01 — MCP contract tests** (`node:test`): spawn the server, run `initialize`, `tools/list`, schema snapshot, graceful-shutdown exit, error containment. → PKG-02, MCP-01/02/03/04.
**TEST-02 — Setup/adapter writer tests**: temp HOME per client target; idempotency; backup creation; corrupt-input abort; generic writer merge semantics; security-boundary assertion (MCP-05). → DSH-01, CLIENT-01, PKG-03.
**TEST-03 — Release verification checklist (scripted where possible)**: fresh clone → `pnpm install` → typecheck (direct `tsc` to bypass the pnpm-store env issue, per audit §4) → build → `npm pack` → install tarball in temp dir → `--version`/`--help` → spawn `mcp` handshake → setup writers against temp HOMEs → live DSH reload record. → PKG-01/03, IS-09.
**TEST-04 — Provider tests**: `resolveProviderName` precedence, `resolveModelId`, validate.ts failure matrix. → MODEL-01/02/03.
**TEST-05 — README-as-spec checks**: every command block executed; CLI table diffed against `--help` output. → PKG-01, DOC-01/02, MCP-03, MODEL-04.
- Framework **[D5]** default: `node:test` (built into Node ≥ 20, zero dependencies). `pnpm test` script added.
- Release acceptance: G1–G5 all green; TEST-03 checklist results recorded in the release notes/issue.

## 11. Migration and backward compatibility

- No breaking changes: package name, bin names, all existing commands/flags, `~/.apograph/config.json` schema, provider env vars, and the five existing setup adapters keep current behavior. New: `mcp` subcommand, `dsh` + `custom` client ids, doctor capability lines (additive output).
- Migration: none required for users; the README corrections change documentation only. Generated DSH entry uses `npx -y apograph-agents mcp`, which works from 0.1.x once PKG-02 ships — release note must call this out.
- Rollback: each phase lands as an independently revertible commit; the MCP server refactor (mcp/server.ts extraction) is behavior-preserving and can be rolled back to the current `dist/mcp.js` monolith without affecting adapters (adapters only emit spawn commands).

## 12. Risks, dependencies, unresolved questions

| Risk | Mitigation |
|---|---|
| DSH preset/patch target choice affects all users' sessions (D2) | Default writes a dedicated agent preset; printing the entry is the safe fallback; user decision required |
| Client config formats drift (Tier 1) | Adapters verified per-client at implementation time; generic route always available |
| `npx -y` cold-start latency for DSH tool calls | Document; alternative (global install + absolute `apograph-mcp` path) documented in DSH notes |
| pnpm 11 store error in some environments breaks `pnpm typecheck` | Verification scripts invoke `tsc` directly; environment issue tracked separately |
| Capability probes add network calls to `doctor` | Short timeouts, degradable to WARN, `--deep` gating for the image probe |

**Blocking decisions (see `decisions-needed.md` Phase 01 section):** D1 naming, D2 DSH target, D3 generic format, D4 roster order, D5 test framework, D6 bump-script nit. Recommended defaults are stated there; none are silently resolved — the defaults above are implementation-ready **only upon approval**.

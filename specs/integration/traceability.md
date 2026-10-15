# Apograph SDD — Requirement-to-Test Traceability Matrix (Phase 01)

Test IDs are defined in `spec.md` §10 (TEST-01…TEST-05). "Planned" = test does not exist yet (no test suite exists today, per audit §1); each row is created in the plan phase listed in `plan.md`. Nothing in this matrix is claimed to pass until executed and observed.

| Requirement | Issue | Acceptance criterion (summary) | Verification | Test | Plan phase | Status |
|---|---|---|---|---|---|---|
| PKG-01 naming/invocation | IS-01 | README commands run verbatim, no E404 | Packed-tarball smoke | TEST-03, TEST-05 | P3 | **Partially Verified** (all local + fresh-tarball commands green incl. `mcp` handshake; the published 0.1.1 still carries broken commands until the authorized next release) |
| PKG-02 `mcp` subcommand | IS-03 | `npx -y apograph-agents mcp` completes MCP initialize | Scripted handshake | TEST-01, TEST-03 | P1 | **Verified locally** (handshake via `node dist/cli.js mcp`: serverInfo v0.1.1; published-tarball check pending) |
| PKG-03 version single-source | IS-04 | `--version` and MCP serverInfo = package version | CLI + MCP assertions | TEST-01, TEST-02, TEST-03 | P1 | **Verified** (both report 0.1.1) |
| MCP-01 shared server, stdio | IS-03 | Identical tool lists from both entry points | tools/list snapshot | TEST-01 | P1 | **Verified** (bin and `mcp` subcommand both list apograph_crawl, apograph_clone) |
| MCP-02 graceful shutdown | — | stdin close / SIGTERM ⇒ exit 0 ≤ 2 s | Spawn-and-kill test | TEST-01 | P1 | **Partially verified** (SIGTERM ⇒ exit 0 observed; stdin-close assertion pending in TEST-01) |
| MCP-03 contracts = docs | IS-10 | tools/list dump matches README tables | Snapshot + doc diff | TEST-01, TEST-05 | P3 | **Partially Verified** (README tool tables match tools/list exactly; explicit CLI-parity statement still to add) |
| MCP-04 error containment | — | Throwing tool ⇒ MCP error result, server alive | Fault-injection test | TEST-01 | P1 | **Verified** (tools/call with invalid URL → isError:true; subsequent tools/list OK; observed in Phase 06 audit) |
| MCP-05 security boundaries | — | Writes confined to documented cwd paths | Temp cwd inspection | TEST-02, TEST-03 | P2 | **Partially Verified** (confined writes unit/manual-verified; README security bullets pending) |
| DSH-01 dsh adapter | IS-02 | Valid preset entry; idempotent upsert; tools appear after reload | Writer test + live reload | TEST-02, TEST-03 | P2 | **Unit-verified** (15/15 node:test pass: creation, idempotency, print-fallback paths); **live DSH reload NOT yet executed** |
| DSH-02 verification guidance | IS-02 | Documented reload procedure executed once | Checklist record | TEST-03 | P3 | **Pending (Gate C)** — requires a fresh DSH session loading the apograph preset; cannot be executed from inside the audited session |
| CLIENT-01 generic writer | IS-02 | Merge preserves keys; corrupt input aborts; creates file if missing | Writer tests | TEST-02 | P2 | **Verified** (unit tests: create, merge-preserving, idempotent no-op, abort-on-corrupt with backup; `runSetup --config-path` route and unknown-client guidance added and tested in Phase 05) |
| CLIENT-02 ranked roster | IS-07 | Each promoted client: verified path/shape + writer test | Per-adapter tests + docs | TEST-02, TEST-05 | P4 (post-approval) | **Partially Verified** (authoritative matrix in `specs/integration/clients.md`; README surfacing pending; Tier-1.5 adapters deferred per approved D4) |
| MODEL-01 provider independence | IS-08 | Resolution depends only on env + config file | Precedence unit tests | TEST-04 | P2 | **Verified** (precedence + model-id override unit tests green) |
| MODEL-02 config validation | IS-08 | WARN/FAIL with fix text for each failure mode; healthy passes | validate.ts unit tests | TEST-04, TEST-03 | P2 | **Verified** (all five issue classes classified; [FAIL] marker observed in doctor; network probes injectable) |
| MODEL-03 capability detection | IS-08 | doctor prints structured-output + vision lines; pipeline unchanged | Unit + manual record | TEST-04, TEST-03 | P2 | **Verified locally** (doctor lines observed on live local Ollama; probes report-only) |
| MODEL-04 scoped claims | IS-08 | README claims match models.ts code paths | Doc review | TEST-05 | P3 | Planned |
| DOC-01 README overhaul | IS-01/IS-06 | All commands/tables verified against CLI | Command execution + table diff | TEST-05 | P3 | **Partially Verified** (npx commands + version fixed and re-audited; `mcp`/`dsh`/`custom` sections not yet in README) |
| DOC-02 client roster docs | IS-07 | Roster with verified paths; unverified labeled | Doc review | TEST-05 | P4 | **Partially Verified** (roster shipped as `specs/integration/clients.md` with verification-status table; README link pending) |
| DOC-03 resume/status documented | IS-06 | CLI table matches `apograph --help` | Table diff | TEST-05 | P3 | **Pending** (resume/status rows still absent from the README CLI table) |
| TEST-02 release checklist (as requirement) | IS-09 | Checklist green before publish | Scripted run | TEST-03 | P3 | **Partially Verified** (every element executed manually in the Phase 06 audit incl. fresh-tarball install + handshake; not yet one scripted command; no `test` script in package.json) |

**Reverse trace (tests → requirements):** TEST-01 → PKG-02/03, MCP-01/02/03/04 · TEST-02 → PKG-03, MCP-05, DSH-01, CLIENT-01, MODEL-01 · TEST-03 → PKG-01/02/03, MCP-03/05, DSH-01/02, MODEL-02/03, TEST-02 · TEST-04 → MODEL-01/02/03 · TEST-05 → PKG-01, MCP-03, MODEL-04, DOC-01/02/03.

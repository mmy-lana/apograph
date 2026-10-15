# Apograph SDD — Implementation Plan (Phase 01 proposal)

Small, independently reviewable phases. Each phase ends with: changed files, key decisions, observed test results, unresolved issues, next-phase prerequisites — and stops for review. **No phase starts until this spec is approved**; D-decision defaults below apply only if approved as stated.

## P1 — MCP launch path and version integrity (PKG-02, PKG-03, MCP-01, MCP-02, MCP-04)
1. Extract `src/mcp/server.ts` (behavior-preserving move of the two tools + schemas) consumed by `dist/mcp.js`.
2. Add `apograph mcp` (alias `serve`) subcommand starting the same server over stdio.
3. Read version from package.json in CLI and server; fix README's "v0.1.0" claim.
4. Lifecycle: stdin close/SIGINT/SIGTERM → clean exit; per-tool try/catch → `isError` result.
5. Add `node:test` scaffolding + TEST-01 (handshake, tools/list, shutdown, error containment).
- Deliverable: server spawnable via `npx apograph-agents mcp`; TEST-01 green (observed).
- Prerequisite for: DSH-01 (P2), PKG-01 (P3).

## P2 — Client adapters: dsh, generic writer, provider validation (DSH-01, CLIENT-01, MODEL-01/02/03, MCP-05)
1. `src/clients/registry.ts` + refactor the five existing adapters into it (no behavior change; TEST-02 locks current outputs first).
2. `dsh` adapter per D2 default (agent-preset writer + printed-entry fallback).
3. `custom` generic writer per D3 default (mcpServers JSON, merge, backup, corrupt-input abort).
4. `src/config/validate.ts` + doctor integration (model/family consistency, gateway /models probe, capability lines); TEST-04 + TEST-02.
- Deliverable: `setup --client dsh` and `--config-path` work against temp HOMEs; doctor reports capabilities.
- Prerequisite: P1; D2/D3 approval. **Live DSH reload verification (DSH-02) recorded here or in P3.**

## P3 — Documentation and release verification (PKG-01, DOC-01/02/03, MCP-03, MODEL-04, TEST-03)
1. README overhaul: `npx apograph-agents` everywhere, `mcp` subcommand + DSH/custom integration sections, resume/status added to CLI table, MCP-parity statement, provider-compatibility matrix, security bullets.
2. TEST-03 release-verification script (fresh clone → typecheck via direct tsc → build → pack → temp install → smoke) + npm-facing command audit; decide D6 (bump scripts) here.
- Deliverable: G1/G5 verifiable; checklist recorded.
- Prerequisite: P1, P2.

## P4 — Tier-1 client adapters (CLIENT-02, DOC-02) — post-approval, evidence-gated
Promote clients from the ranked roster only after verifying each client's config path/shape from its current documentation; one thin adapter + TEST-02 case each; DOC-02 roster publication. Requires D4 approval and may be deferred indefinitely without affecting P1–P3 value.

## Explicit decision gates
- **Gate A (now):** approve spec + defaults D1 (name unchanged), D2 (agent preset), D3 (mcpServers JSON), D5 (node:test); supply D4 roster order or defer P4.
- **Gate B (end of P1):** confirm `npx apograph-agents mcp` handshake result before adapters adopt it.
- **Gate C (end of P2):** confirm live DSH reload result (DSH-02) before docs claim it (P3).

## Rollback
Each phase is a revertible commit series; P1's server extraction is behavior-preserving (rollback restores the current `dist/mcp.js` monolith without breaking P2 adapters, which only emit spawn commands).

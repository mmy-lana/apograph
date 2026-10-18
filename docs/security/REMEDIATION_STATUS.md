# Apograph Remediation Status

- **Current phase:** P0-A through P0-H initial hardening; adversarial coverage and sandbox work remain incomplete
- **Repository baseline:** `c3b77c2` (`docs: align specs with visual repair workflow`)
- **Working tree at start:** clean
- **Baseline verification:** `pnpm test` PASS (194 tests); `pnpm typecheck` PASS; `pnpm build` PASS.
- **Completed this session:** baseline records; shared path/network helpers; emitter and asset containment; restricted root/final navigation checks; shell-safe evidence opener; fail-closed MCP clone entry; fail-closed typecheck status; atomic restrictive config writes; doctor redaction; focused security tests; release/security docs.
- **Active blockers:** generated-project install/build now fails closed by default but has no portable sandbox implementation; redirect/DNS revalidation is incomplete for every browser hop; MCP approval/workspace authorization is not implemented even though paths and page budgets are now constrained; complete symlink/TOCTOU coverage, prompt-injection containment, global budgets, dependency scanning, and clean-install verification remain incomplete. Local pack dry-run and CI configuration are present but CI execution is unverified.
- **Latest verification:** `pnpm typecheck` PASS; `pnpm build` PASS; `pnpm test` PASS (201 tests); focused security tests PASS (7 tests); `npm pack --dry-run` PASS; `git diff --check` PASS.
- **Latest hardening:** direct crawler/evidence paths and aggregate asset bytes are bounded; verifier repair outputs are bounded.
- **Final round verification:** `pnpm typecheck`, `pnpm test` (201), `npm pack --dry-run`, and `git diff --check` all PASS.
- **Exact next action:** implement MCP workspace/approval authorization and global run budgets, then add CI/package smoke gates; strict evidence-manifest and network-capture tests are now present.

Do not interpret baseline green tests as security acceptance; the existing suite lacks the required traversal, symlink, SSRF, subprocess, MCP, and release fixtures.

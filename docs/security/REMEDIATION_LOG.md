# Apograph Remediation Log

## 2025-02-14 — Baseline and threat model

- Confirmed baseline `pnpm test` passes 194 tests; `pnpm typecheck` and `pnpm build` pass.
- Current implementation still had P0 blockers in emitter paths, crawler/asset network policy, MCP approval, shell invocation, generated execution, and verification truthfulness.
- No commit, publish, install, or external service call performed.

## 2025-02-14 — Initial hardening

- Added shared relative-path and lexical containment helpers in `src/utils/fs-safe.ts`; emitter and mirrored-asset copy now validate paths and reject symlink components.
- Added `src/crawler/network-policy.ts`; crawler roots/final navigation and asset URLs now reject restricted destinations, embedded credentials, and non-HTTP(S) URLs. Asset mirroring has count, byte, redirect, and image-type bounds.
- Replaced evidence opener shell interpolation with `execFile` arguments.
- MCP clone now fails closed before crawl/output side effects until explicit approval/workspace authorization exists.
- Verification build success now requires both TypeScript and Vite; invalid/unapproved plan or missing manifest blocks route/visual tiers.
- Config persistence now validates optional field types and uses atomic mode `0600` replacement; doctor errors are redacted.
- Added security regression tests covering path rejection, restricted network addresses, private DNS results, and residual typecheck failures.
- Added root security/contribution/changelog documentation and persistent remediation records.
- Verification: `pnpm typecheck` PASS; `pnpm build` PASS; `pnpm test` PASS, 198 tests; focused security suite PASS, 4 tests.
- Added separator-aware static-server containment, rejected symlinked emitter roots, and intercepted browser subresource requests through the network policy; these reduce but do not eliminate TOCTOU/DNS races.
- Generated-project verification now fails closed unless `APOGRAPH_ALLOW_UNSANDBOXED_EXECUTION=1` is explicitly set; clone verification uses `npx --no-install`. This is a safety stop, not a sandbox.
- Added verifier evidence/component containment, semantic plan path/component uniqueness checks, bounded model-generated file paths/count/content, and explicit fail-closed generated verification. Full suite now reports 199 passing tests.
- Added strict evidence manifest schema validation at the plan-loader boundary and bounded MCP page/depth inputs with fixed evidence/output locations; full suite remains 199 passing tests and `pnpm typecheck` passes.
- Added strict evidence manifest schema validation at the plan-loader boundary and bounded MCP page/depth inputs with fixed evidence/output locations; full suite remains 199 passing tests and `pnpm typecheck` passes.
- `npm pack --dry-run` now passes and includes the root `LICENSE`, current `dist`, README, and package metadata; no tarball was created or published.
- Enforced `plan.approved` at the public synthesis API boundary, so non-CLI callers cannot synthesize unapproved plans. Added a CI workflow configuration for frozen install, typecheck, build, tests, and pack dry-run; remote CI execution remains unverified.
- Bounded the network collector to 500 requests, 512 KiB per response body, and 10 MiB aggregate response capture; focused security suite now has 7 passing tests.
- Latest verification: `pnpm test` PASS (201 tests), `npm pack --dry-run` PASS, and `git diff --check` PASS.
- Remaining blockers: robust browser redirect/DNS race policy, complete symlink/TOCTOU containment, actual sandboxed generated execution, MCP approval/workspace authorization, prompt-injection controls, global budgets, CI execution, and dependency scanning.
- Reused strict manifest validation in the verifier and added manual redirect revalidation for same-origin asset downloads; focused security suite remains 7 passing tests.
- Bounded CLI/direct crawl limits and verifier repair turns; rejected empty/oversized repair output. Added workspace containment for crawl evidence and a 50 MiB aggregate asset budget. `pnpm test` passes all 201 tests after these changes.
- Final round verification: `pnpm typecheck` PASS, `pnpm test` PASS (201 tests), `npm pack --dry-run` PASS, and `git diff --check` PASS. No commit/publish/deploy performed.
- Next action: implement global run budgets and MCP authorization, then run the full release/security matrix before any release recommendation.

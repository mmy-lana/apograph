# Apograph Release Readiness

Current verdict: **NOT READY — P0 remediation incomplete**. Initial hardening is present, but sandboxing, browser-wide SSRF enforcement, MCP workspace authorization, and adversarial coverage are not verified.

| Gate | Status | Evidence |
|---|---|---|
| Baseline typecheck | VERIFIED | `pnpm typecheck` passed at baseline |
| Baseline build | VERIFIED | `pnpm build` passed at baseline |
| Baseline tests | VERIFIED | `pnpm test`: 194 passing |
| Filesystem containment | PARTIALLY VERIFIED | Emitter, asset copy, verifier repair/evidence paths now reject traversal and many symlink components; full TOCTOU coverage remains |
| SSRF and fetch policy | PARTIALLY VERIFIED | Restricted roots, final URLs, browser subresources, bounded assets, and same-origin asset redirects are enforced; DNS race and all redirect-hop coverage remain |
| Generated execution isolation | FAILED / FAIL-CLOSED | Verification is disabled unless explicit unsafe opt-in; no portable sandbox exists |
| MCP approval/output authorization | PARTIALLY VERIFIED | Clone now fails before side effects and tool budgets/paths are constrained; authorized approved-workspace operation is not implemented |
| Resource governance | PARTIALLY VERIFIED | Crawl/page/depth, asset count/per-asset/aggregate bytes, network capture, model file output, repair turns, and verifier execution defaults are bounded; no central run-wide time/token/cost/disk/process budget |
| Shell injection safety | VERIFIED by inspection | Evidence opener uses argument-based `execFile`; adversarial platform matrix not run |
| Prompt injection containment | NOT VERIFIED | No independent model policy boundary or hostile-site fixture suite |
| Secrets and sensitive data | PARTIALLY VERIFIED | Config types, atomic `0600` writes, and doctor redaction hardened; complete data-flow audit remains |
| Truthful verification | PARTIALLY VERIFIED | Typecheck is a hard build gate, invalid authorization blocks tiers, generated execution fails closed by default, strict manifests are loaded, and repair turns/output are bounded; full malformed-manifest/repair matrix remains |
| Adversarial security tests | PARTIALLY VERIFIED | Focused suite: 7 passing security tests; full suite: 201 passing; broad browser/subprocess/MCP fixtures remain absent |
| CI/release/package smoke | PARTIALLY VERIFIED | Local `npm pack --dry-run` passed and included LICENSE/dist/README/package metadata; CI execution, dependency scanning, and clean-install smoke remain unverified |
| Hosted-service readiness | FAILED | No tenant isolation, auth, quota, or sandbox model |

This checklist must be updated only with exact commands and observed results. A green build alone is not release acceptance.

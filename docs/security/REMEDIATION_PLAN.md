# Apograph Remediation Plan

Status: active; release remains blocked until all P0 gates are verified.

## Scope and order

1. **P0-A Filesystem containment** — canonical roots, safe relative paths, symlink-aware writes/copies/reads, bounded output.
2. **P0-B SSRF/resource policy** — reject restricted destinations, redirect revalidation, bounded asset downloads and browser requests.
3. **P0-C Generated execution isolation** — fail closed for unsafe install/build execution; restrict subprocesses and cleanup.
4. **P0-D MCP authorization** — server-side approval, workspace containment, no implicit destructive overwrite, cancellation.
5. **P0-E Shell safety** — remove shell interpolation from evidence opener and command paths.
6. **P0-F Untrusted model/site data** — delimit data, strict generated-output validation, approval outside model output.
7. **P0-G Secrets** — restrictive/atomic config writes and complete diagnostic redaction.
8. **P0-H Truthful verification** — strict plan/evidence gates, no typecheck bypass, repair regression protection.
9. **P1 Reliability** — versioned schemas, global budgets, cancellation/resume correctness, capability enforcement.
10. **P2 Release** — CI, adversarial/E2E tests, package smoke tests, security/privacy/release documentation.

## Acceptance gates

- No untrusted path can escape its authorized root through traversal, absolute paths, sibling prefixes, or symlinks.
- Initial URLs, redirects, assets, and browser subresources cannot reach restricted network destinations without an explicit documented opt-in.
- Generated projects are not installed or executed with host privileges; unsupported isolation fails closed.
- MCP cannot bypass approval or write outside its authorized workspace.
- No shell command interpolates untrusted values.
- External content cannot grant tool or filesystem permissions through model prompts.
- Secret-bearing configuration and diagnostics are protected and redacted.
- Mandatory verification failures are never reported as full success.
- Focused adversarial tests, existing tests, typecheck, build, and release checks run with results recorded.

## Current known blockers

See `REMEDIATION_STATUS.md` and `RELEASE_READINESS.md`. This file is an implementation roadmap, not a claim that any gate passes.

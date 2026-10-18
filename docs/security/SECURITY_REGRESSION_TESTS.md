# Security Regression Tests

Required before release; status is tracked in `RELEASE_READINESS.md`.

## Filesystem

- Reject absolute, `..`, encoded traversal, sibling-prefix, malformed, and symlink paths.
- Verify emitter, visual repair, evidence screenshots, asset copy, static server, config, setup, and checkpoints stay inside authorized roots.
- Verify forced overwrite requires explicit authorization and cannot follow symlinked roots.
- Enforce file count, per-file size, and aggregate output limits.

## Network

- Reject loopback, RFC1918, link-local, metadata, reserved, IPv6, and IPv4-mapped IPv6 destinations.
- Recheck every redirect and DNS/address resolution.
- Block cross-origin redirects and browser subresource escapes unless explicitly allowed.
- Enforce asset count, response bytes, redirects, timeout, and concurrency budgets.

## Generated execution

- Lifecycle scripts, build plugins, and generated dependencies cannot access host files, credentials, or unrestricted network.
- Missing sandbox capability fails closed.
- Descendant processes terminate on cancellation and temporary outputs are cleaned.

## MCP and shell

- Unapproved direct tool calls fail without writes.
- Output/evidence paths are contained and destructive overwrite requires explicit authorization.
- Concurrent and repeated calls are safe.
- Shell metacharacters in evidence paths remain data.

## Models and secrets

- Hostile page text, metadata, assets, and model output cannot expand permissions.
- Config files use restrictive permissions and atomic replacement.
- Diagnostics redact provider keys, bearer tokens, URL credentials, cookies, and sensitive headers.

## Verification

- Invalid plans/manifests, missing evidence, typecheck failures, route failures, and browser failures cannot produce unqualified success.
- Repair tests include previously passing viewports and rollback on regressions.
- Resume only skips routes with validated emitted artifacts.

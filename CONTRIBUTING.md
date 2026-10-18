# Contributing

Before submitting changes:

- Use Node.js 20+ and `pnpm`.
- Run `pnpm typecheck`, `pnpm build`, and `pnpm test`.
- Add regression tests for security, filesystem, network, provider, MCP, or generated-project behavior.
- Do not include credentials, cookies, private URLs, generated evidence, or output projects.
- Do not weaken validation or mark unverified behavior as secure.

Security-sensitive changes should update the threat model and remediation log under `docs/security/`.

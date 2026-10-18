# Security Policy

Apograph is a local-first developer tool that crawls websites, sends selected evidence to configured model providers, emits generated projects, and may verify generated code. Treat target sites, model output, generated dependencies, and evidence bundles as untrusted.

## Safe-use assumptions

- Use only against sites you are authorized to inspect.
- Do not run generated-project installation or verification in a directory containing sensitive credentials.
- Do not expose the stdio MCP server to untrusted callers.
- Review output paths, generated files, dependencies, and verification reports before use.

## Reporting

Please report suspected vulnerabilities privately through the repository's issue tracker before public disclosure. Do not include API keys, cookies, private URLs, or sensitive evidence in reports.

## Scope limitation

The current release candidate is not approved for hosted multi-user deployment. SSRF, sandboxing, MCP authorization, and filesystem containment controls remain subject to the remediation checklist in `docs/security/RELEASE_READINESS.md`.

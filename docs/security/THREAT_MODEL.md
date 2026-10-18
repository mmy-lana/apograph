# Apograph Threat Model

## Trust boundaries

1. CLI/MCP caller to Apograph options and filesystem paths.
2. Target website and every redirect/subresource to the browser crawler.
3. Downloaded assets/network responses to local evidence files.
4. Harvested page text, metadata, screenshots, and source to model prompts.
5. Model output/plans to generated files and verification commands.
6. Generated project/dependencies to the host process, filesystem, environment, and network.
7. Provider configuration/credentials to diagnostics and external model endpoints.

## Attackers and capabilities

- A caller can supply URLs, output paths, evidence paths, numeric limits, or MCP arguments.
- A target website can control HTML, text, metadata, redirects, assets, scripts, and network behavior.
- A compromised or prompt-injected model can return malicious paths, source, package metadata, or commands through generated artifacts.
- A local attacker may race symlinks or inspect weakly protected configuration files.
- A compromised dependency can execute during install/build if generated projects are not isolated.

## Security decisions

- External website content is data, never authorization.
- Generated files and dependencies are untrusted and must not execute with host privileges.
- Filesystem operations require canonical containment and symlink-aware handling.
- Network destinations require explicit policy, including redirect and DNS revalidation.
- MCP approval must be enforced in server-side code for the exact target/scope/action.
- Verification status must fail closed for mandatory failures and distinguish degraded/unsupported states.
- Local-first does not imply safe for hosted multi-user deployment; hosted use requires separate isolation and authorization.

## Known limitations to resolve

The current implementation does not yet satisfy these decisions. See `REMEDIATION_STATUS.md` and `REMEDIATION_LOG.md` for verified progress.

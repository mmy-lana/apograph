/**
 * apograph — Package version single-source (PKG-03).
 *
 * Reads the version from package.json at runtime so the CLI `--version`
 * output and the MCP `initialize` serverInfo can never drift from the
 * published package version. package.json is always included in the npm
 * tarball and sits one level above dist/, where both entry points live.
 */

import { readFileSync } from 'node:fs';

/** The package version string, or '0.0.0' when package.json is unreadable. */
export function getVersion(): string {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const version =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { version?: unknown }).version
        : undefined;
    return typeof version === 'string' && version.length > 0 ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
